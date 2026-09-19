// GET /api/now-playing — the owner's currently-playing track (Phase 5a),
// shown as a display-only card top-right (src/now-playing-card.ts). Reuses
// the same token/spotifyGet plumbing as top-artists.ts/village.ts, but with
// its own much shorter shared cache — see the doc comment below.
//
// Shared, not per-visitor: the site is public, so every open tab polling
// this endpoint every ~10s would otherwise multiply real Spotify calls by
// however many people have the page open, against a rate limit that's per
// Client ID, app-wide (SPEC.md's Spotify API constraints — a bad 429 there
// can mean a Retry-After of 13-18 hours for the *whole site's* data, not
// just this widget). Caching the upstream response in caches.default for
// ~10s under one fixed key (not keyed by IP or query string) means Spotify
// is called at most ~6x/minute no matter how many visitors are polling.
//
// Any failure here (token, Spotify, or an unrecognized payload shape)
// degrades to `{ playing: false, track: null }` with HTTP 200, never a
// 5xx — a rate-limit blip must read as "no card", not take the page down.
//
// Phase 5b adds `slotId`: which district (if any) should react to this
// track. The payload only carries artist *display names*, so the frontend
// alone can't map a track to a slot — resolved here instead, the same
// bucketing rule as worker/tracks.ts's Phase 3.5 Songs tab: look up the
// track's *primary* artist (`artistIds[0]`) in `artist_cache.slot_id`
// (populated by the existing /api/village artist pipeline). No cache hit,
// no reaction — never a fresh Gemini call or a new artist_cache row here,
// so this costs zero additional AI usage. Resolved before writeCache so the
// D1 read happens at most once per ~10s cache window, not once per poll.
//
// Phase 7c adds `caption`: an AI-generated in-world line for the same
// track, resolved right alongside slotId (only when one was found — no
// reacting district, no caption either) so it rides this same ~10s window
// instead of running once per poll. worker/captions.ts owns the actual
// generation/caching decision (cached forever per artist+track, so this is
// a cheap D1 read on every request after the first for a given track); see
// its doc comment for why that never costs extra Spotify calls either.

import type { Env } from "./index";
import { getAccessToken, TokenError } from "./token";
import { spotifyGet, SpotifyRequestError } from "./spotify-fetch";
import { captionFor } from "./captions";

const CACHE_TTL_SECONDS = 10;

interface SpotifyImage {
  url: string;
  height: number | null;
  width: number | null;
}

interface SpotifyTrackItem {
  id: string;
  name: string;
  duration_ms: number;
  album: { name: string; images: SpotifyImage[] };
  artists: { id: string; name: string }[];
  external_urls: { spotify: string };
}

/** GET /me/player/currently-playing's shape — only the fields used here.
 * `item` is a track, an episode (different shape entirely), or absent;
 * `currently_playing_type` is how Spotify distinguishes them. Spotify
 * returns 204 No Content (no body) when nothing is playing at all — see
 * spotify-fetch.ts's 204 handling, which is why this is nullable. */
interface SpotifyCurrentlyPlaying {
  is_playing: boolean;
  progress_ms: number | null;
  item: SpotifyTrackItem | null;
  currently_playing_type: "track" | "episode" | "ad" | "unknown";
}

export interface NowPlayingTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  coverUrl: string | null;
  spotifyUrl: string;
  durationMs: number;
  progressMs: number;
  /** Every artist id on the track, same order as Spotify's `artists` array —
   * [0] is primary, the one `slotId` is resolved from (see this file's doc
   * comment). */
  artistIds: string[];
  /** The district this track should make react, or null if the primary
   * artist has no cached slot (a genuinely unknown artist, or the D1 lookup
   * itself failed — see resolveSlotId). Never widened past artist_cache. */
  slotId: string | null;
  /** One AI-generated in-world caption line for this track (Phase 7c), or
   * null when there's no reacting district (slotId is null), or none exists
   * yet and one couldn't be generated right now (the Gemini daily/captions
   * cap, a Gemini failure, or a D1 hiccup — see worker/captions.ts).
   * Generation is awaited inline as part of this same request (not
   * fire-and-forget): the very first poll of a brand-new track pays the
   * full Gemini round-trip once, and every later poll — for the rest of
   * that play, or any future replay of the same track — is a cached D1
   * read. The frontend falls back to its own template caption whenever
   * this is null. */
  caption: string | null;
}

export type NowPlayingPayload = { playing: boolean; track: NowPlayingTrack | null };

const NOT_PLAYING: NowPlayingPayload = { playing: false, track: null };

function cacheKey(): Request {
  // One fixed URL regardless of who's asking — see the shared-cache doc
  // comment above. Not real routing, just a caches.default key.
  return new Request("https://echoes-cache.internal/now-playing");
}

async function readCache(key: Request): Promise<NowPlayingPayload | null> {
  const res = await caches.default.match(key);
  if (!res) return null;
  return (await res.json()) as NowPlayingPayload;
}

async function writeCache(key: Request, payload: NowPlayingPayload): Promise<void> {
  const res = new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json", "Cache-Control": `s-maxage=${CACHE_TTL_SECONDS}` },
  });
  await caches.default.put(key, res);
}

/** Turns Spotify's raw currently-playing shape into the small payload the
 * card needs. `data` is null on a 204 (nothing playing at all); explicit
 * `is_playing: false` and the podcast/episode case (`item` present but not
 * a track) are both treated as "not playing" rather than a crash.
 *
 * `slotId` is left null here — handleNowPlaying resolves it afterward (a D1
 * read, so it can't happen inside this sync function) and fills it in
 * before caching. */
function toPayload(data: SpotifyCurrentlyPlaying | null): NowPlayingPayload {
  if (!data || !data.is_playing || !data.item || data.currently_playing_type !== "track") {
    return NOT_PLAYING;
  }
  const track = data.item;
  return {
    playing: true,
    track: {
      id: track.id,
      title: track.name,
      artist: track.artists.map((a) => a.name).join(", "),
      album: track.album.name,
      coverUrl: track.album.images[0]?.url ?? null,
      spotifyUrl: track.external_urls.spotify,
      durationMs: track.duration_ms,
      progressMs: data.progress_ms ?? 0,
      artistIds: track.artists.map((a) => a.id),
      slotId: null,
      caption: null,
    },
  };
}

/** Looks up the primary artist's resolved slot in `artist_cache` (populated
 * by /api/village's Phase 3 genre-resolution pipeline) — see this file's
 * doc comment for why this is a pure cache read, never a fresh Gemini call.
 * A D1 failure degrades to null (no reaction), matching every other
 * failure path in this file — a slot lookup breaking must never take the
 * now-playing card down with it. */
async function resolveSlotId(env: Env, primaryArtistId: string): Promise<string | null> {
  try {
    const row = await env.DB.prepare(`SELECT slot_id FROM artist_cache WHERE artist_id = ? AND slot_id IS NOT NULL`)
      .bind(primaryArtistId)
      .first<{ slot_id: string }>();
    return row?.slot_id ?? null;
  } catch (err) {
    console.error("[now-playing] slot lookup failed, degrading to no reaction:", err);
    return null;
  }
}

export async function handleNowPlaying(env: Env): Promise<Response> {
  const key = cacheKey();
  try {
    const cached = await readCache(key);
    if (cached) return Response.json(cached);
  } catch (err) {
    console.error("[now-playing] cache read failed, fetching fresh:", err);
  }

  let accessToken: string | null;
  try {
    accessToken = await getAccessToken(env);
  } catch (err) {
    // Token/refresh trouble degrades to "nothing playing", never a 5xx —
    // see this file's doc comment.
    if (err instanceof TokenError) return Response.json(NOT_PLAYING);
    console.error("[now-playing] token stage failed unexpectedly:", err);
    return Response.json(NOT_PLAYING);
  }
  if (accessToken === null) return Response.json(NOT_PLAYING);

  let payload: NowPlayingPayload;
  try {
    const data = await spotifyGet<SpotifyCurrentlyPlaying | null>(env, "/me/player/currently-playing", accessToken);
    payload = toPayload(data);
  } catch (err) {
    if (err instanceof SpotifyRequestError) return Response.json(NOT_PLAYING);
    console.error("[now-playing] spotify stage failed unexpectedly:", err);
    return Response.json(NOT_PLAYING);
  }

  // Resolve which district (if any) reacts to this track, and (Phase 7c)
  // its AI caption — both before caching, so their reads/writes ride the
  // same ~10s window as the Spotify call above rather than running once per
  // poll (see this file's doc comment).
  if (payload.playing && payload.track) {
    const primaryArtistId = payload.track.artistIds[0];
    payload.track.slotId = primaryArtistId ? await resolveSlotId(env, primaryArtistId) : null;
    if (payload.track.slotId && primaryArtistId) {
      // "now-playing" is a fixed pseudo-IP for the Gemini daily-cap
      // bookkeeping (worker/rate-limit.ts), same convention as
      // worker/history.ts's cron ("cron") — see worker/captions.ts's doc
      // comment for why the real polling visitor's IP wouldn't make sense
      // here (this whole block runs at most once per shared ~10s window,
      // not once per visitor).
      payload.track.caption = await captionFor(
        env,
        "now-playing",
        payload.track.slotId,
        primaryArtistId,
        payload.track.artist,
        payload.track.id,
        payload.track.title,
      );
    }
  }

  try {
    await writeCache(key, payload);
  } catch (err) {
    console.error("[now-playing] cache write failed (response still returned):", err);
  }
  return Response.json(payload);
}
