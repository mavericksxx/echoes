// GET /api/village — the derived world: every roster slot's activity level,
// share of listening, and the real artists placed inside it. This is what
// Phase 3 replaces src/sample-data.ts with (src/listening-source.ts picks
// between the two on the frontend); see SPEC.md's Phase 3 bullet.
//
// Reuses the same token/fetch/cache plumbing as top-artists.ts rather than
// duplicating it (see spotifyGet, getAccessToken, deriveArtists) — this
// endpoint just asks Spotify for more artists (VILLAGE_ARTISTS_LIMIT vs
// TOP_ARTISTS_LIMIT) and layers genre resolution + world-shaping on top.
//
// Range: Phase 3 always drives the world from a single fixed range
// (medium_term, same default as /api/top-artists) — a range *toggle* for
// the whole village is explicitly Phase 8 work (SPEC.md), so this endpoint
// accepts `range` for forward compatibility/testing but the frontend never
// passes one yet.
//
// "Faded" residents (an artist you've stopped playing): with no listening
// history storage yet (that's daily_snapshot/play_event, Phase 8), the only
// broader reference available now is Spotify's own long_term range. Unless
// the request *is* long_term, a second fetch of long_term top artists finds
// anyone who used to place in a slot but is missing from the current range's
// list; those render with score 0 / rank null / faded true instead of being
// dropped entirely.
//
// Phase 3.5 adds a 4th stage, "tracks": /me/top/tracks for the same range,
// bucketed into slots by primary-artist membership in the artist union
// already resolved above (see worker/tracks.ts's doc comment for why this
// costs zero extra Gemini calls). It has its own try/catch, separate from
// "assemble" below — a top-tracks failure degrades only the Songs tab
// (`songsLive: false`, every slot's `songs` stays `[]`) rather than paging
// back to pausedPayload and losing the whole village.

import type { Env } from "./index";
import { getAccessToken, TokenError } from "./token";
import { spotifyGet, SpotifyRequestError } from "./spotify-fetch";
import { deriveArtists, VALID_RANGES, type SpotifyTopArtistsResponse, type TopArtistOut } from "./top-artists";
import { resolveArtistSlots } from "./genre-resolution";
import { fetchTopTracks, bucketTracksBySlot, type SlottedSong } from "./tracks";
import { clientIp } from "./rate-limit";
import { activityLevel, type ActivityLevel } from "../shared/activity";
import { SLOTS } from "../data/loader";

const CACHE_TTL_SECONDS = 30 * 60;
const VILLAGE_ARTISTS_LIMIT = 50; // Spotify's max for /me/top/artists
const SLOT_IDS = SLOTS.map((s) => s.district.id);

export interface VillageArtist {
  id: string;
  name: string;
  image: string | null;
  /** 1-based rank within the current range's fetch, or null if this artist
   * only appears in the long_term baseline (faded/absent this range). */
  rank: number | null;
  /** 0..1, normalized within the current range's fetch; 0 for faded artists. */
  score: number;
  faded: boolean;
}

/** A song alias for the /api/village payload — see worker/tracks.ts's
 * SlottedSong (id/title/artist/artistIds/album/coverUrl/spotifyUrl/rank). No
 * play count or timestamp: Spotify's top-tracks endpoint gives neither (see
 * SPEC.md and src/sample-data.ts's Song type, which makes both optional for
 * exactly this reason). */
export type VillageSong = SlottedSong;

export interface VillageSlot {
  slotId: string;
  activity: ActivityLevel;
  /** This slot's share of total listening (0..1) across all 17 slots. */
  share: number;
  /** Highest score first; faded artists (score 0) last. */
  artists: VillageArtist[];
  /** This slot's top tracks, ranked (Spotify order). Empty if songsLive is
   * false (tracks stage failed) or none of this slot's residents have a
   * top-50 track this range — never widened to a broader fetch to fill it. */
  songs: VillageSong[];
}

export type VillagePayload =
  | { connected: false }
  | {
      connected: true;
      live: boolean;
      range: string;
      slots: VillageSlot[];
      /** True if the Gemini daily cap was hit while resolving genres for
          this response — some artists may be using a low-confidence fallback
          slot instead of a real classification. */
      geminiLimited: boolean;
      /** Set if a Gemini call actually failed (network/HTTP/parse error) —
          distinct from geminiLimited (a deliberate cap). Some artists may be
          using a low-confidence fallback slot instead of a real one. */
      geminiError: string | null;
      /** False if the tracks stage (Phase 3.5) failed — every slot's
       * `songs` is `[]` in that case, distinct from a slot that's genuinely
       * empty (no top-50 track for its residents this range). */
      songsLive: boolean;
      cachedAt: string | null;
    };

/** An unexpected failure at some stage of building the village — returned as
 * a plain 200 JSON error (never a thrown exception reaching the runtime,
 * which is what turned into a Cloudflare 1101 in production) so it's
 * diagnosable from the response body alone. */
export interface VillageErrorPayload {
  error: string;
  where: "token" | "spotify" | "assemble";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function dormantSlots(): VillageSlot[] {
  return SLOT_IDS.map((slotId) => ({ slotId, activity: activityLevel(0), share: 0, artists: [], songs: [] }));
}

function pausedPayload(range: string): VillagePayload {
  return {
    connected: true,
    live: false,
    range,
    slots: dormantSlots(),
    geminiLimited: false,
    geminiError: null,
    songsLive: false,
    cachedAt: null,
  };
}

function cacheKeyFor(range: string): Request {
  return new Request(`https://echoes-cache.internal/village/${range}`);
}

async function readCache(key: Request): Promise<VillagePayload | null> {
  const res = await caches.default.match(key);
  if (!res) return null;
  return (await res.json()) as VillagePayload;
}

async function writeCache(key: Request, payload: VillagePayload): Promise<void> {
  const res = new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json", "Cache-Control": `s-maxage=${CACHE_TTL_SECONDS}` },
  });
  await caches.default.put(key, res);
}

async function fetchTopArtists(env: Env, accessToken: string, range: string, limit: number): Promise<TopArtistOut[]> {
  const data = await spotifyGet<SpotifyTopArtistsResponse>(
    env,
    `/me/top/artists?time_range=${range}&limit=${limit}`,
    accessToken,
  );
  return deriveArtists(data.items);
}

/** Builds the per-slot world from a resolved current-range fetch and an
 * optional long_term baseline (for faded/absent detection — see doc comment
 * above). `slotById` covers every artist appearing in either list. */
function buildSlots(
  current: TopArtistOut[],
  baseline: TopArtistOut[],
  slotById: Map<string, { slotId: string }>,
): VillageSlot[] {
  const n = current.length;
  const totalRawScore = (n * (n + 1)) / 2;
  const currentIds = new Set(current.map((a) => a.id));

  const bySlot = new Map<string, VillageArtist[]>();
  const slotRawScore = new Map<string, number>();
  for (const slotId of SLOT_IDS) {
    bySlot.set(slotId, []);
    slotRawScore.set(slotId, 0);
  }

  current.forEach((artist, i) => {
    const slotId = slotById.get(artist.id)?.slotId;
    if (!slotId) return;
    const rank = i + 1;
    const rawScore = n - rank + 1;
    slotRawScore.set(slotId, (slotRawScore.get(slotId) ?? 0) + rawScore);
    bySlot.get(slotId)!.push({
      id: artist.id,
      name: artist.name,
      image: artist.image,
      rank,
      score: rawScore / n,
      faded: false,
    });
  });

  for (const artist of baseline) {
    if (currentIds.has(artist.id)) continue; // still present — not faded
    const slotId = slotById.get(artist.id)?.slotId;
    if (!slotId) continue;
    bySlot.get(slotId)!.push({ id: artist.id, name: artist.name, image: artist.image, rank: null, score: 0, faded: true });
  }

  return SLOT_IDS.map((slotId) => {
    const artists = (bySlot.get(slotId) ?? []).sort((a, b) => b.score - a.score);
    const share = totalRawScore > 0 ? (slotRawScore.get(slotId) ?? 0) / totalRawScore : 0;
    // songs is filled in by handleVillage's separate tracks stage below —
    // buildSlots only knows about artists.
    return { slotId, activity: activityLevel(share), share, artists, songs: [] };
  });
}

export async function handleVillage(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const range = url.searchParams.get("range") ?? "medium_term";
  if (!VALID_RANGES.has(range)) {
    return Response.json({ error: "range must be short_term, medium_term, or long_term" }, { status: 400 });
  }

  // Per-IP rate limiting for this endpoint happens centrally in
  // worker/index.ts (before routing) — see RATE_LIMIT_RULES.village there.
  // `ip` here is only for the Gemini daily-cap bookkeeping below.
  const ip = clientIp(request);

  // ---- stage: token ----
  let accessToken: string | null;
  try {
    accessToken = await getAccessToken(env);
  } catch (err) {
    if (err instanceof TokenError) return Response.json(pausedPayload(range));
    console.error("[village] token stage failed unexpectedly:", err);
    return Response.json({ error: errorMessage(err), where: "token" } satisfies VillageErrorPayload);
  }

  if (accessToken === null) {
    return Response.json({ connected: false } satisfies VillagePayload);
  }

  const cacheKey = cacheKeyFor(range);
  try {
    const cached = await readCache(cacheKey);
    if (cached) return Response.json(cached);
  } catch (err) {
    // A broken cache read should never block a fresh build below.
    console.error("[village] cache read failed, rebuilding:", err);
  }

  // ---- stage: spotify ----
  let current: TopArtistOut[];
  let baseline: TopArtistOut[];
  try {
    current = await fetchTopArtists(env, accessToken, range, VILLAGE_ARTISTS_LIMIT);
    baseline =
      range === "long_term" ? current : await fetchTopArtists(env, accessToken, "long_term", VILLAGE_ARTISTS_LIMIT);
  } catch (err) {
    if (err instanceof SpotifyRequestError) return Response.json(pausedPayload(range));
    console.error("[village] spotify stage failed unexpectedly:", err);
    return Response.json({ error: errorMessage(err), where: "spotify" } satisfies VillageErrorPayload);
  }

  const union = new Map<string, TopArtistOut>();
  for (const a of current) union.set(a.id, a);
  for (const a of baseline) union.set(a.id, a);

  // ---- stage: gemini — resolveArtistSlots is designed to never throw (see
  // its own doc comment); every artist gets at least a fallback slot even if
  // Gemini is capped or broken, so the village below is always real Spotify
  // data, just possibly with lower-confidence slotting. ----
  const { bySlotId, geminiLimited, geminiError } = await resolveArtistSlots(env, ip, Array.from(union.values()));
  if (geminiError) console.error("[village] gemini stage degraded:", geminiError);

  // ---- stage: assemble ----
  let payload: VillagePayload;
  try {
    const slots = buildSlots(current, baseline, bySlotId);
    payload = {
      connected: true,
      live: true,
      range,
      slots,
      geminiLimited,
      geminiError,
      songsLive: true, // tentative — the tracks stage below may flip this
      cachedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error("[village] assemble stage failed unexpectedly:", err);
    return Response.json({ error: errorMessage(err), where: "assemble" } satisfies VillageErrorPayload);
  }

  // ---- stage: tracks (Phase 3.5) — its own try/catch, deliberately outside
  // "assemble": a failure here must never fall back to pausedPayload (that
  // would throw away real artist/activity data over a Songs-tab problem).
  // It degrades to songsLive: false with every slot's songs already [] from
  // buildSlots instead. ----
  try {
    const tracks = await fetchTopTracks(env, accessToken, range);
    const songsBySlot = bucketTracksBySlot(tracks, bySlotId);
    payload.slots = payload.slots.map((slot) => ({ ...slot, songs: songsBySlot.get(slot.slotId) ?? [] }));
  } catch (err) {
    console.error("[village] tracks stage failed, songs disabled for this response:", err);
    payload.songsLive = false;
  }

  try {
    await writeCache(cacheKey, payload);
  } catch (err) {
    console.error("[village] cache write failed (response still returned):", err);
  }
  return Response.json(payload);
}
