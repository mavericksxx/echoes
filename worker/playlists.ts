// GET /api/playlists + GET /api/playlists/{id} — Phase 8.6 first cut
// (SPEC.md: "Playlists are places"). This slice is sidebar-only: playlists
// as *buildings you can enter* on the map is deferred (see SPEC.md's Phase
// 8.6 note) — these two endpoints just list the owner's playlists and, on
// demand, resolve one playlist's tracks into a per-slot "cast" breakdown
// using the existing artist_cache/genre-resolution pipeline. No new D1
// table: nothing here persists a playlist id, track id, or track name —
// only artist ids/names ever reach artist_cache, exactly the same
// derived-data-only write path /api/village and the history cron already
// use (SPEC.md's storage policy).
//
// Scopes: GET /me/playlists and GET /playlists/{id}/items both require
// playlist-read-private + playlist-read-collaborative (scripts/
// spotify-connect.mjs), which didn't exist before this phase — until the
// owner reruns `npm run spotify:connect`, Spotify answers both with
// 401/403. That is handled explicitly below (`reason: "needs-reconnect"`,
// see SpotifyRequestError.status) rather than falling into the generic
// "paused" state every other endpoint uses for a broken/expired token —
// reconnecting fixes this instantly, refreshing again does not, so the
// frontend needs to tell the two apart. Neither a 401 nor a 403 is retried
// by spotifyGet (only 429/5xx are), so this can never trip the 429 ban
// check (worker/history.ts's isSpotifyBanned only ever looks at status-429
// usage_log rows).

import type { Env } from "./index";
import { getAccessToken, TokenError } from "./token";
import { spotifyGet, SpotifyRequestError } from "./spotify-fetch";
import { resolveArtistSlots } from "./genre-resolution";
import { clientIp } from "./rate-limit";
import type { TopArtistOut } from "./top-artists";

const LIST_CACHE_TTL_SECONDS = 30 * 60;
const DETAIL_CACHE_TTL_SECONDS = 30 * 60;
// Spotify's max page size for both /me/playlists and /playlists/{id}/items.
const PAGE_SIZE = 50;
const PLAYLISTS_LIMIT = PAGE_SIZE; // single page — plenty for a personal account; see handlePlaylists' doc note
// Items endpoint gets its own (larger) page size and a hard page cap, per
// SPEC.md's Phase 8.6 task: up to 3 pages of 100 = 300 tracks classified per
// playlist, worst case. A playlist longer than that gets `truncated: true`
// rather than a wider fetch — same "never silently widen a fetch" rule as
// worker/tracks.ts's Songs-tab bucketing.
const ITEMS_PAGE_SIZE = 100;
const ITEMS_MAX_PAGES = 3;
// Cast rows only ever show a playlist's few most-represented artists per
// slot — same spirit as worker/persona.ts capping a slot's prompt to its top
// 5 artists, just for display here instead of a prompt.
const TOP_ARTISTS_PER_SLOT = 3;

interface SpotifyImage {
  url: string;
  height: number | null;
  width: number | null;
}

interface SpotifyMeResponse {
  id: string;
}

interface SpotifyPlaylistOwner {
  id: string;
}

// Feb 2026: the field on a playlist object that used to be called `tracks`
// (an { href, total } ref, never the tracks themselves) was renamed to
// `items` — same rename as the standalone GET /playlists/{id}/tracks ->
// GET /playlists/{id}/items endpoint below (SPEC.md's Spotify API
// constraints / this phase's research).
interface SpotifyPlaylistItemsRef {
  total: number;
}

interface SpotifyPlaylist {
  id: string;
  name: string;
  images: SpotifyImage[];
  owner: SpotifyPlaylistOwner;
  collaborative: boolean;
  items: SpotifyPlaylistItemsRef;
}

interface SpotifyPlaylistsResponse {
  items: SpotifyPlaylist[];
}

export interface PlaylistOut {
  id: string;
  name: string;
  image: string | null;
  trackCount: number;
  collaborative: boolean;
}

export type PlaylistsPayload =
  | { connected: false }
  | { connected: true; live: false; reason: "paused" | "needs-reconnect" }
  | { connected: true; live: true; playlists: PlaylistOut[]; cachedAt: string };

export interface PlaylistCastArtist {
  id: string;
  name: string;
  trackCount: number;
}

export interface PlaylistCastSlot {
  slotId: string;
  /** This slot's share (0..1) of the playlist's classified tracks — tracks
   * whose primary artist resolved to *some* slot (resolveArtistSlots always
   * returns one, even a low-confidence fallback — see its doc comment), out
   * of every track actually fetched (`tracksSeen`, not the playlist's full
   * `trackCount` if it was truncated). */
  share: number;
  /** Highest trackCount first, capped at TOP_ARTISTS_PER_SLOT. */
  topArtists: PlaylistCastArtist[];
}

export type PlaylistDetailPayload =
  | { connected: false }
  | { connected: true; live: false; reason: "paused" | "needs-reconnect" }
  | {
      connected: true;
      live: true;
      id: string;
      /** Spotify's own total track count for the playlist. */
      trackCount: number;
      /** Tracks actually fetched and classified — equals trackCount unless
       * `truncated` (the ITEMS_MAX_PAGES cap was hit first). */
      tracksSeen: number;
      truncated: boolean;
      cast: PlaylistCastSlot[];
      /** Same meaning as worker/village.ts's VillagePayload fields — some
       * artists may be using a low-confidence fallback slot instead of a
       * real Gemini classification. */
      geminiLimited: boolean;
      geminiError: string | null;
      cachedAt: string;
    };

function isReconnectStatus(status: number): boolean {
  return status === 401 || status === 403;
}

// ---------------------------------------------------------------------------
// GET /api/playlists
// ---------------------------------------------------------------------------

function listCacheKey(): Request {
  return new Request("https://echoes-cache.internal/playlists/list");
}

async function readListCache(): Promise<PlaylistsPayload | null> {
  const res = await caches.default.match(listCacheKey());
  if (!res) return null;
  return (await res.json()) as PlaylistsPayload;
}

async function writeListCache(payload: PlaylistsPayload): Promise<void> {
  const res = new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json", "Cache-Control": `s-maxage=${LIST_CACHE_TTL_SECONDS}` },
  });
  await caches.default.put(listCacheKey(), res);
}

function derivePlaylists(items: SpotifyPlaylist[], ownerId: string): PlaylistOut[] {
  return items
    // GET /me/playlists also returns playlists the owner *follows* but
    // doesn't own or collaborate on — Spotify only returns track/item
    // content for owned-or-collaborative playlists (this phase's research),
    // so a followed playlist would show a count but never a cast. Dropped
    // here rather than shown half-working.
    .filter((p) => p.owner.id === ownerId || p.collaborative)
    .map((p) => ({
      id: p.id,
      name: p.name,
      // images are typically ordered largest-first, same convention as
      // top-artists.ts's artist image pick.
      image: p.images[1]?.url ?? p.images[0]?.url ?? null,
      trackCount: p.items.total,
      collaborative: p.collaborative,
    }));
}

/**
 * GET /api/playlists — the owner's own playlists (owned or collaborative
 * only, see derivePlaylists), cover + name + track count, nothing else.
 *
 * A single 50-item page: Spotify's own max for /me/playlists in one call,
 * and plenty for a personal account (this is a single-owner app — see
 * SPEC.md's "Auth & tokens"). Not paginated further, unlike the per-
 * playlist items fetch below — keeping this endpoint to at most 2 Spotify
 * calls (GET /me, GET /me/playlists) worst case.
 */
export async function handlePlaylists(env: Env): Promise<Response> {
  let accessToken: string | null;
  try {
    accessToken = await getAccessToken(env);
  } catch (err) {
    if (err instanceof TokenError) return Response.json({ connected: true, live: false, reason: "paused" } satisfies PlaylistsPayload);
    throw err;
  }

  if (accessToken === null) {
    return Response.json({ connected: false } satisfies PlaylistsPayload);
  }

  try {
    const cached = await readListCache();
    if (cached) return Response.json(cached);
  } catch (err) {
    console.error("[playlists] list cache read failed, rebuilding:", err);
  }

  try {
    const me = await spotifyGet<SpotifyMeResponse>(env, "/me", accessToken);
    const data = await spotifyGet<SpotifyPlaylistsResponse>(env, `/me/playlists?limit=${PLAYLISTS_LIMIT}`, accessToken);
    const payload: PlaylistsPayload = {
      connected: true,
      live: true,
      playlists: derivePlaylists(data.items, me.id),
      cachedAt: new Date().toISOString(),
    };
    try {
      await writeListCache(payload);
    } catch (err) {
      console.error("[playlists] list cache write failed (response still returned):", err);
    }
    return Response.json(payload);
  } catch (err) {
    if (err instanceof SpotifyRequestError) {
      const reason = isReconnectStatus(err.status) ? "needs-reconnect" : "paused";
      return Response.json({ connected: true, live: false, reason } satisfies PlaylistsPayload);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// GET /api/playlists/{id}
// ---------------------------------------------------------------------------

interface SpotifyPlaylistTrackArtist {
  id: string | null;
  name: string;
}

interface SpotifyPlaylistTrack {
  type: string; // "track" | "episode" — episodes carry no `artists`
  is_local: boolean;
  artists?: SpotifyPlaylistTrackArtist[];
}

interface SpotifyPlaylistItem {
  // Can be null for a removed/unavailable track — Spotify still returns the
  // slot in the page.
  track: SpotifyPlaylistTrack | null;
}

interface SpotifyPlaylistItemsResponse {
  items: SpotifyPlaylistItem[];
  next: string | null;
  total: number;
}

interface PrimaryArtistRef {
  id: string;
  name: string;
}

/** Fetches up to ITEMS_MAX_PAGES pages of a playlist's items, returning only
 * each real track's *primary* artist — same "primary artist only" bucketing
 * convention as worker/tracks.ts/worker/history-query.ts, not every artist
 * on the track. Episodes, local files, and null/removed tracks are skipped
 * (they carry no artist to classify). Never throws SpotifyRequestError past
 * the first attempt into a partial result — a failure partway through a
 * multi-page playlist surfaces the same way a first-page failure would (the
 * caller's try/catch), rather than silently returning what was fetched so
 * far as if it were complete. */
async function fetchPlaylistPrimaryArtists(
  env: Env,
  accessToken: string,
  playlistId: string,
): Promise<{ artists: PrimaryArtistRef[]; trackCount: number; tracksSeen: number; truncated: boolean }> {
  const artists: PrimaryArtistRef[] = [];
  let total = 0;
  let tracksSeen = 0;
  let sawNext = false;

  for (let page = 0; page < ITEMS_MAX_PAGES; page++) {
    const offset = page * ITEMS_PAGE_SIZE;
    const data = await spotifyGet<SpotifyPlaylistItemsResponse>(
      env,
      `/playlists/${encodeURIComponent(playlistId)}/items?limit=${ITEMS_PAGE_SIZE}&offset=${offset}`,
      accessToken,
    );
    total = data.total;
    for (const item of data.items) {
      const track = item.track;
      if (!track || track.type !== "track" || track.is_local) continue;
      tracksSeen++;
      const primary = track.artists?.[0];
      if (primary?.id) artists.push({ id: primary.id, name: primary.name });
    }
    if (!data.next) {
      sawNext = false;
      break;
    }
    sawNext = true;
  }

  return { artists, trackCount: total, tracksSeen, truncated: sawNext };
}

function detailCacheKey(playlistId: string): Request {
  return new Request(`https://echoes-cache.internal/playlists/detail/${playlistId}`);
}

async function readDetailCache(key: Request): Promise<PlaylistDetailPayload | null> {
  const res = await caches.default.match(key);
  if (!res) return null;
  return (await res.json()) as PlaylistDetailPayload;
}

async function writeDetailCache(key: Request, payload: PlaylistDetailPayload): Promise<void> {
  const res = new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json", "Cache-Control": `s-maxage=${DETAIL_CACHE_TTL_SECONDS}` },
  });
  await caches.default.put(key, res);
}

/** Builds the per-slot cast breakdown from a playlist's primary-artist list
 * and their resolved slots — mirrors worker/village.ts's buildSlots share
 * math (rawScore / totalRawScore), just unweighted (every track counts
 * once, there's no rank to weight by here). */
function buildCast(artists: PrimaryArtistRef[], bySlotId: Map<string, { slotId: string }>): PlaylistCastSlot[] {
  interface SlotAgg {
    count: number;
    artists: Map<string, PlaylistCastArtist>;
  }
  const bySlot = new Map<string, SlotAgg>();
  let classified = 0;

  for (const artist of artists) {
    const slotId = bySlotId.get(artist.id)?.slotId;
    if (!slotId) continue; // resolveArtistSlots always resolves every artist it's given — defensive only
    classified++;
    const agg = bySlot.get(slotId) ?? { count: 0, artists: new Map() };
    agg.count++;
    const existing = agg.artists.get(artist.id);
    if (existing) existing.trackCount++;
    else agg.artists.set(artist.id, { id: artist.id, name: artist.name, trackCount: 1 });
    bySlot.set(slotId, agg);
  }

  return Array.from(bySlot.entries())
    .map(([slotId, agg]) => ({
      slotId,
      share: classified > 0 ? agg.count / classified : 0,
      topArtists: Array.from(agg.artists.values())
        .sort((a, b) => b.trackCount - a.trackCount)
        .slice(0, TOP_ARTISTS_PER_SLOT),
    }))
    .sort((a, b) => b.share - a.share);
}

/**
 * GET /api/playlists/{id} — one playlist's tracks (lazily, only fetched when
 * a visitor opens it), mapped to a per-slot cast breakdown. Worst case, this
 * is ITEMS_MAX_PAGES (3) Spotify calls for the items pages, plus whatever
 * worker/genre-resolution.ts's resolveArtistSlots spends resolving any
 * artist ids never seen before (0 Spotify calls, up to 2 batched Gemini
 * calls gated by the existing daily cap) — no unbounded per-artist fetch.
 */
export async function handlePlaylistDetail(request: Request, env: Env, playlistId: string): Promise<Response> {
  let accessToken: string | null;
  try {
    accessToken = await getAccessToken(env);
  } catch (err) {
    if (err instanceof TokenError) return Response.json({ connected: true, live: false, reason: "paused" } satisfies PlaylistDetailPayload);
    throw err;
  }

  if (accessToken === null) {
    return Response.json({ connected: false } satisfies PlaylistDetailPayload);
  }

  const cacheKey = detailCacheKey(playlistId);
  try {
    const cached = await readDetailCache(cacheKey);
    if (cached) return Response.json(cached);
  } catch (err) {
    console.error("[playlists] detail cache read failed, rebuilding:", err);
  }

  let fetched: Awaited<ReturnType<typeof fetchPlaylistPrimaryArtists>>;
  try {
    fetched = await fetchPlaylistPrimaryArtists(env, accessToken, playlistId);
  } catch (err) {
    if (err instanceof SpotifyRequestError) {
      const reason = isReconnectStatus(err.status) ? "needs-reconnect" : "paused";
      return Response.json({ connected: true, live: false, reason } satisfies PlaylistDetailPayload);
    }
    throw err;
  }

  // Unique-by-id, matching resolveArtistSlots' input shape (TopArtistOut).
  // No genres — the items endpoint gives none, so every never-before-seen
  // artist here goes through Gemini's name-classification path, same as any
  // artist Spotify itself never sent genres for (worker/genre-resolution.ts).
  const byArtistId = new Map<string, TopArtistOut>();
  let rank = 0;
  for (const artist of fetched.artists) {
    if (byArtistId.has(artist.id)) continue;
    rank++;
    byArtistId.set(artist.id, { id: artist.id, name: artist.name, genres: [], image: null, rank });
  }

  const ip = clientIp(request);
  const { bySlotId, geminiLimited, geminiError } = await resolveArtistSlots(env, ip, Array.from(byArtistId.values()));
  if (geminiError) console.error("[playlists] gemini stage degraded:", geminiError);

  const payload: PlaylistDetailPayload = {
    connected: true,
    live: true,
    id: playlistId,
    trackCount: fetched.trackCount,
    tracksSeen: fetched.tracksSeen,
    truncated: fetched.truncated,
    cast: buildCast(fetched.artists, bySlotId),
    geminiLimited,
    geminiError,
    cachedAt: new Date().toISOString(),
  };

  try {
    await writeDetailCache(cacheKey, payload);
  } catch (err) {
    console.error("[playlists] detail cache write failed (response still returned):", err);
  }
  return Response.json(payload);
}
