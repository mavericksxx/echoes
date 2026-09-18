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
import { resolveArtistMoods, resolveArtistSlots } from "./genre-resolution";
import { fetchTopTracks, bucketTracksBySlot, type SlottedSong } from "./tracks";
import { resolveSlotPersonas, type SlotPersona } from "./persona";
import { clientIp } from "./rate-limit";
import { slotPlaysBetween } from "./history-query";
import { activityLevel, type ActivityLevel } from "../shared/activity";
import { SLOTS } from "../data/loader";
import type { MoodGuess, MoodId } from "./gemini";

const CACHE_TTL_SECONDS = 30 * 60;
const VILLAGE_ARTISTS_LIMIT = 50; // Spotify's max for /me/top/artists
const SLOT_IDS = SLOTS.map((s) => s.district.id);

// Phase 8b: maps a village range to the play_event window judged equivalent
// to it — short_term (Spotify's own window is "approximately 4 weeks") gets
// the same 28 days, medium_term ("approximately 6 months") gets 180 days,
// long_term is all logged history (Phase 8a started collecting 2026-09-18,
// so "all time" here is naturally bounded by that start date, not an
// arbitrary lookback). `null` means "from the beginning".
const HISTORY_WINDOW_MS: Record<string, number | null> = {
  short_term: 28 * 24 * 60 * 60 * 1000,
  medium_term: 180 * 24 * 60 * 60 * 1000,
  long_term: null,
};

// Below this many *slotted* plays in the window, today's Spotify
// rank-weighted share is more trustworthy than a history-derived one — a
// handful of plays would let one or two artists swing a slot's whole share.
// Applied uniformly: either every slot in the response uses history, or
// every slot uses the rank-weighted share — never mixed per slot, since a
// visitor comparing two districts should be comparing the same kind of
// number for both.
const MIN_SLOTTED_PLAYS_FOR_HISTORY = 50;

interface HistoryActivity {
  /** Per-slot share (0..1) of slotted plays in the window, or `null` if
   * there isn't enough history yet to trust it (see
   * MIN_SLOTTED_PLAYS_FOR_HISTORY) — callers keep every slot on whichever
   * source this is, never mixed. */
  bySlotShare: Map<string, number> | null;
  /** slottedPlays / totalPlays for the window, 0 if the window has no plays
   * at all — how much of it is actually classified yet, regardless of
   * whether bySlotShare ended up populated. */
  historyCoverage: number;
  /** Every play in the window, slotted or not. */
  historyPlays: number;
}

/** Resolves `range`'s history window and decides whether there's enough D1
 * play history to drive activity/share from real plays instead of today's
 * Spotify rank-weighted numbers (SPEC.md's Phase 8b). Never throws — a D1
 * query failure here should degrade to the Spotify-driven numbers, not fail
 * the whole village. */
async function historyActivityForRange(env: Env, range: string): Promise<HistoryActivity> {
  const windowMs = HISTORY_WINDOW_MS[range] ?? null;
  const toMs = Date.now();
  const fromMs = windowMs === null ? 0 : toMs - windowMs;
  const { bySlot, slottedPlays, totalPlays } = await slotPlaysBetween(env, fromMs, toMs);
  const historyCoverage = totalPlays > 0 ? slottedPlays / totalPlays : 0;
  if (slottedPlays < MIN_SLOTTED_PLAYS_FOR_HISTORY) {
    return { bySlotShare: null, historyCoverage, historyPlays: totalPlays };
  }
  const bySlotShare = new Map<string, number>();
  for (const slotId of SLOT_IDS) bySlotShare.set(slotId, (bySlot[slotId] ?? 0) / slottedPlays);
  return { bySlotShare, historyCoverage, historyPlays: totalPlays };
}

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
  /** Phase 7a: this slot's play/share-weighted dominant mood — the mood with
   * the highest total `score` (buildSlots' rank-weighted artist score,
   * VillageArtist.score) among its artists that have one tagged. Null when
   * no resident artist has a mood tagged yet (new artist, quota cap, or a
   * Gemini failure — see worker/genre-resolution.ts's resolveArtistMoods),
   * or when the slot has no artists at all. */
  mood: MoodId | null;
  /** Phase 7a: this slot's score-weighted mean energy (0..1) across artists
   * with a tagged mood/energy — same weighting and same null cases as
   * `mood` above (always null/non-null together). */
  energy: number | null;
  /** Phase 7b: this slot's personality + dialogue lines, flavored by its own
   * top artists and cached in D1 (worker/persona.ts) — null if the slot has
   * no real top artists yet, the persona stage below failed, or nothing was
   * cached yet for a slot that just became eligible. Never blocks the rest
   * of the payload (see handleVillage's persona stage). */
  persona: SlotPersona | null;
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
      /** Phase 8b: whether every slot's activity/share above came from real
       * play_event history or from today's Spotify rank-weighted share
       * (see historyActivityForRange) — never mixed per slot. */
      activitySource: "history" | "spotify";
      /** slottedPlays / totalPlays for this range's history window, 0 if the
       * window has no logged plays yet. Meaningful even when
       * activitySource is "spotify" (not enough slotted plays yet) — it's
       * what tells a caller *how close* the history source is to kicking in. */
      historyCoverage: number;
      /** Every play_event row in this range's history window, slotted or
       * not — 0 before Phase 8a had collected anything. */
      historyPlays: number;
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
  return SLOT_IDS.map((slotId) => ({
    slotId,
    activity: activityLevel(0),
    share: 0,
    artists: [],
    songs: [],
    mood: null,
    energy: null,
    persona: null,
  }));
}

/** Live-paused (token/Spotify stage failed): no artist roster (that only
 * ever comes from Spotify), but Phase 8b's history is D1-only, so this
 * *payload* no longer has to flatten every slot to dormant — if there's
 * enough play_event history for this range, activity/share still reflect
 * real listening. Falls back to dormantSlots() if there isn't (including on
 * a D1 query failure — this must never itself throw).
 *
 * Not yet wired into what a paused visitor actually sees: src/listening-
 * source.ts's getActivity()/getArtists() only read a village payload while
 * isVillageLive() (live === true), so today a paused response's real
 * activity numbers here are inspectable via the API but the frontend still
 * falls back to sample data while paused. Tracked in BACKLOG.md. */
async function pausedPayload(env: Env, range: string): Promise<VillagePayload> {
  let slots = dormantSlots();
  let activitySource: "history" | "spotify" = "spotify";
  let historyCoverage = 0;
  let historyPlays = 0;
  try {
    const history = await historyActivityForRange(env, range);
    historyCoverage = history.historyCoverage;
    historyPlays = history.historyPlays;
    if (history.bySlotShare) {
      activitySource = "history";
      slots = SLOT_IDS.map((slotId) => {
        const share = history.bySlotShare!.get(slotId) ?? 0;
        return { slotId, activity: activityLevel(share), share, artists: [], songs: [], mood: null, energy: null, persona: null };
      });
    }
  } catch (err) {
    console.error("[village] paused-payload history stage failed, falling back to dormant slots:", err);
  }

  return {
    connected: true,
    live: false,
    range,
    slots,
    geminiLimited: false,
    geminiError: null,
    songsLive: false,
    cachedAt: null,
    activitySource,
    historyCoverage,
    historyPlays,
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

// Phase 8b cheap win: the raw long_term artist list, cached separately from
// cacheKeyFor's whole-payload-per-range cache (see handleVillage's spotify
// stage) so a short_term or medium_term build within CACHE_TTL_SECONDS can
// reuse it without a second Spotify call.
function baselineCacheKey(): Request {
  return new Request("https://echoes-cache.internal/village/baseline/long_term");
}

async function readBaselineCache(): Promise<TopArtistOut[] | null> {
  const res = await caches.default.match(baselineCacheKey());
  if (!res) return null;
  return (await res.json()) as TopArtistOut[];
}

async function writeBaselineCache(artists: TopArtistOut[]): Promise<void> {
  const res = new Response(JSON.stringify(artists), {
    headers: { "Content-Type": "application/json", "Cache-Control": `s-maxage=${CACHE_TTL_SECONDS}` },
  });
  await caches.default.put(baselineCacheKey(), res);
}

async function fetchTopArtists(env: Env, accessToken: string, range: string, limit: number): Promise<TopArtistOut[]> {
  const data = await spotifyGet<SpotifyTopArtistsResponse>(
    env,
    `/me/top/artists?time_range=${range}&limit=${limit}`,
    accessToken,
  );
  return deriveArtists(data.items);
}

/** Phase 7a: this slot's play/share-weighted dominant mood + mean energy —
 * see VillageSlot.mood/energy's doc comments. Weighted by each artist's
 * already-computed rank-based `score` (0 for faded artists, which this
 * naturally excludes without a separate check); artists with no tagged mood
 * are skipped entirely rather than counted as 0 weight toward a "known"
 * mood. Null when nothing in `artists` has a tagged mood. */
function aggregateSlotMood(
  artists: VillageArtist[],
  moodByArtistId: Map<string, MoodGuess>,
): { mood: MoodId; energy: number } | null {
  let weightSum = 0;
  let energyWeightSum = 0;
  const moodWeights = new Map<MoodId, number>();
  for (const artist of artists) {
    const guess = moodByArtistId.get(artist.id);
    if (!guess || artist.score <= 0) continue;
    weightSum += artist.score;
    energyWeightSum += guess.energy * artist.score;
    moodWeights.set(guess.mood, (moodWeights.get(guess.mood) ?? 0) + artist.score);
  }
  if (weightSum <= 0) return null;
  let dominant: MoodId | null = null;
  let dominantWeight = -1;
  for (const [mood, weight] of moodWeights) {
    if (weight > dominantWeight) {
      dominantWeight = weight;
      dominant = mood;
    }
  }
  return { mood: dominant!, energy: energyWeightSum / weightSum };
}

/** Builds the per-slot world from a resolved current-range fetch and an
 * optional long_term baseline (for faded/absent detection — see doc comment
 * above). `slotById` covers every artist appearing in either list. */
function buildSlots(
  current: TopArtistOut[],
  baseline: TopArtistOut[],
  slotById: Map<string, { slotId: string }>,
  moodByArtistId: Map<string, MoodGuess>,
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
    const moodAgg = aggregateSlotMood(artists, moodByArtistId);
    // songs/persona are filled in by handleVillage's separate tracks/persona
    // stages below — buildSlots only knows about artists.
    return {
      slotId,
      activity: activityLevel(share),
      share,
      artists,
      songs: [],
      mood: moodAgg?.mood ?? null,
      energy: moodAgg?.energy ?? null,
      persona: null,
    };
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
    if (err instanceof TokenError) return Response.json(await pausedPayload(env, range));
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
  // Only true when `baseline` above was actually just fetched from Spotify
  // (this request *is* long_term, or the baseline cache missed) — gates the
  // cache write below so a cache *hit* doesn't re-arm its own TTL on every
  // read. Without this, the baseline cache would rewrite its expiry on
  // every non-long_term build that hit it and never actually go stale/
  // refresh again.
  let baselineFetched = false;
  try {
    current = await fetchTopArtists(env, accessToken, range, VILLAGE_ARTISTS_LIMIT);
    if (range === "long_term") {
      baseline = current;
      baselineFetched = true;
    } else {
      // Cheap win (Phase 8b): the long_term baseline fetch is identical for
      // every non-long_term build within CACHE_TTL_SECONDS, so cache its raw
      // artist list under its own key — separate from cacheKeyFor's whole-
      // payload cache, which is keyed per range and wouldn't help a
      // short_term build reuse long_term's fetch.
      let cachedBaseline: TopArtistOut[] | null = null;
      try {
        cachedBaseline = await readBaselineCache();
      } catch (err) {
        console.error("[village] baseline cache read failed, refetching:", err);
      }
      if (cachedBaseline) {
        baseline = cachedBaseline;
      } else {
        baseline = await fetchTopArtists(env, accessToken, "long_term", VILLAGE_ARTISTS_LIMIT);
        baselineFetched = true;
      }
    }
  } catch (err) {
    if (err instanceof SpotifyRequestError) return Response.json(await pausedPayload(env, range));
    console.error("[village] spotify stage failed unexpectedly:", err);
    return Response.json({ error: errorMessage(err), where: "spotify" } satisfies VillageErrorPayload);
  }

  if (baselineFetched) {
    try {
      await writeBaselineCache(baseline);
    } catch (err) {
      console.error("[village] baseline cache write failed (response still returned):", err);
    }
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

  // ---- stage: mood (Phase 7a) — its own call, sharing the same daily cap
  // resolveArtistSlots above may have already spent some of (see
  // resolveArtistMoods' doc comment). Never throws, never blocks the slot
  // roster on a mood miss — an artist with no entry in moodByArtistId just
  // renders with no mood (aggregateSlotMood above treats it as unweighted). ----
  const moodByArtistId = await resolveArtistMoods(env, ip, Array.from(union.values()));

  // ---- stage: assemble ----
  let payload: VillagePayload;
  try {
    const slots = buildSlots(current, baseline, bySlotId, moodByArtistId);
    payload = {
      connected: true,
      live: true,
      range,
      slots,
      geminiLimited,
      geminiError,
      songsLive: true, // tentative — the tracks stage below may flip this
      cachedAt: new Date().toISOString(),
      // Defaults below — the history stage right after this overrides them
      // when there's enough D1 history to trust (see historyActivityForRange).
      activitySource: "spotify",
      historyCoverage: 0,
      historyPlays: 0,
    };
  } catch (err) {
    console.error("[village] assemble stage failed unexpectedly:", err);
    return Response.json({ error: errorMessage(err), where: "assemble" } satisfies VillageErrorPayload);
  }

  // ---- stage: history activity (Phase 8b) — its own try/catch, deliberately
  // outside "assemble": a D1 query failure here must never turn a perfectly
  // good Spotify-driven response into an error payload, it should just leave
  // the rank-weighted numbers already in `payload` alone. Overrides every
  // slot's activity/share uniformly (never mixed per slot — see
  // historyActivityForRange's doc comment). ----
  try {
    const history = await historyActivityForRange(env, range);
    payload.historyCoverage = history.historyCoverage;
    payload.historyPlays = history.historyPlays;
    if (history.bySlotShare) {
      payload.activitySource = "history";
      payload.slots = payload.slots.map((slot) => {
        const share = history.bySlotShare!.get(slot.slotId) ?? 0;
        return { ...slot, share, activity: activityLevel(share) };
      });
    }
  } catch (err) {
    console.error("[village] history activity stage failed, using spotify-driven share:", err);
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

  // ---- stage: persona (Phase 7b) — its own try/catch, deliberately outside
  // "assemble": a failure here must never fall back to pausedPayload or drop
  // songs/artists, only leave every slot's persona at buildSlots' null
  // default (worker/persona.ts's resolveSlotPersonas is itself guaranteed
  // never to throw, but this is defense-in-depth, same as the tracks stage).
  //
  // Built from `baseline` (long_term top artists — already in hand from the
  // spotify stage above, no extra fetch) rather than `payload.slots[].artists`
  // (this request's `range`): a slot's persona fingerprint has to track real
  // taste, not which era a visitor happened to load first — deriving it from
  // the range would make every era switch look like a fingerprint change and
  // regenerate from whichever era was viewed today, defeating the once/day
  // cap's intent (see worker/persona.ts's doc comment). ----
  try {
    const namesBySlot = new Map<string, string[]>();
    for (const slotId of SLOT_IDS) namesBySlot.set(slotId, []);
    // `baseline` is already in Spotify's long_term rank order (see
    // fetchTopArtists/deriveArtists) — pushing in iteration order keeps each
    // slot's list ranked without a separate sort.
    for (const artist of baseline) {
      const slotId = bySlotId.get(artist.id)?.slotId;
      if (slotId) namesBySlot.get(slotId)!.push(artist.name);
    }
    const personaInputs = SLOT_IDS.map((slotId) => ({
      slotId,
      topArtistNames: (namesBySlot.get(slotId) ?? []).slice(0, 5),
    }));
    const personas = await resolveSlotPersonas(env, ip, personaInputs);
    payload.slots = payload.slots.map((slot) => ({ ...slot, persona: personas.get(slot.slotId) ?? null }));
  } catch (err) {
    console.error("[village] persona stage failed, personas disabled for this response:", err);
  }

  try {
    await writeCache(cacheKey, payload);
  } catch (err) {
    console.error("[village] cache write failed (response still returned):", err);
  }
  return Response.json(payload);
}
