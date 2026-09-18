// Phase 8a: the play-event log. A 15-min Worker cron (wrangler.jsonc's
// `triggers.crons`, wired to `scheduled()` in worker/index.ts) calls
// `runHistorySync` to backfill `play_event`/`track_cache`/`artist_cache` from
// GET /me/player/recently-played — the only source of play history Spotify's
// API offers (no play counts, no minutes listened anywhere). Also exports
// `handleHistoryStats`, the GET /api/history/stats route.
//
// Phase 8b adds `classifyUnslottedArtists`: after each run's batch insert,
// any of this run's primary artists still missing a slot (artist_cache.
// slot_id IS NULL) get run through worker/genre-resolution.ts, so
// worker/village.ts's history-driven activity (which joins play_event to
// artist_cache.slot_id at query time) isn't stuck waiting for an artist to
// happen to show up in a /api/village Spotify fetch too.
//
// Deliberately NO `after` cursor on the recently-played call. Offline/
// downloaded listening syncs to Spotify later carrying its *original*
// `played_at`, which can be older than MAX(played_at) already stored — a
// forward-only cursor would permanently miss those plays. The response is
// capped at 50 items either way, so a cursor buys nothing here and costs
// correctness.
//
// The cron runs with nobody watching in real time (SPEC.md's rate-limit
// research), so the single most important thing this file does is check for
// an active 429 ban *before* ever calling Spotify — see `isSpotifyBanned`.

import type { Env } from "./index";
import { getAccessToken, TokenError } from "./token";
import { spotifyGet } from "./spotify-fetch";
import { resolveArtistSlots } from "./genre-resolution";
import type { TopArtistOut } from "./top-artists";

const RECENTLY_PLAYED_LIMIT = 50; // Spotify's max, and the hard ceiling on how far back one call can see

interface SpotifyImage {
  url: string;
  height: number | null;
  width: number | null;
}

interface RecentlyPlayedArtist {
  id: string | null;
  name: string;
}

interface RecentlyPlayedTrack {
  id: string | null;
  name: string;
  duration_ms: number;
  is_local: boolean;
  album: { name: string; images: SpotifyImage[] };
  artists: RecentlyPlayedArtist[];
  external_urls: { spotify: string };
}

interface RecentlyPlayedItem {
  track: RecentlyPlayedTrack;
  played_at: string; // ISO 8601, ms precision — Spotify's own timestamp, unique per play
  context: { uri: string } | null;
}

interface RecentlyPlayedResponse {
  items: RecentlyPlayedItem[];
}

interface LatestBanRow {
  retry_after_raw: string | null;
  created_at: string;
}

/** Whether Spotify is currently under an active 429 ban, per the newest
 * `usage_log` row with `status = 429`. `retry_after_raw` can be either
 * delay-seconds or an HTTP-date (the header's two legal forms) — handled
 * defensively since a misparse here must never turn into "banned forever";
 * an unparseable value fails open (not banned) rather than silently wedging
 * every future cron run. */
export async function isSpotifyBanned(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT retry_after_raw, created_at FROM usage_log WHERE status = 429 ORDER BY id DESC LIMIT 1",
  ).first<LatestBanRow>();
  if (!row || !row.retry_after_raw) return false;

  const asSeconds = Number(row.retry_after_raw);
  const bannedUntilMs = !Number.isNaN(asSeconds)
    ? Date.parse(row.created_at) + asSeconds * 1000
    : Date.parse(row.retry_after_raw); // HTTP-date form
  if (Number.isNaN(bannedUntilMs)) return false;

  return bannedUntilMs > Date.now();
}

interface RunResult {
  ok: boolean;
  fetched: number;
  inserted: number;
  gapSuspected: boolean;
  error: string | null;
}

/** Appends one row to `history_sync`. Best-effort: a logging failure must
 * never be what makes a cron run look like it crashed. */
async function recordRun(env: Env, result: RunResult): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO history_sync (ran_at, ok, fetched, inserted, gap_suspected, error) VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        new Date().toISOString(),
        result.ok ? 1 : 0,
        result.fetched,
        result.inserted,
        result.gapSuspected ? 1 : 0,
        result.error,
      )
      .run();
  } catch (err) {
    console.error("[history] failed to record history_sync row:", err);
  }
}

/** A play is skippable if it has no usable track id (podcast episodes and
 * some other item shapes), is a locally-added file (never had a real
 * catalog id to begin with), or is missing a primary artist id — all three
 * would otherwise poison play_event/track_cache/artist_cache with garbage
 * keys. */
function isUsableItem(item: RecentlyPlayedItem): boolean {
  const track = item.track;
  return Boolean(track.id) && !track.is_local && Boolean(track.artists[0]?.id);
}

/** Classifies any of this run's primary artists that don't have a slot yet
 * (artist_cache.slot_id IS NULL) — e.g. one seeded fresh by this very run's
 * batch above, or an artist that's never appeared in a /api/village Spotify
 * fetch. Its own try/catch: a classification failure (Gemini down, capped,
 * or a D1 hiccup) must never fail the sync that already inserted real
 * play_event rows. Builds the empty-genres/null-image input shape
 * worker/genre-resolution.ts expects for an artist with no Spotify-supplied
 * metadata (this cron never fetches artist details — only what
 * recently-played already inlines) — see its Path 2 (classify by name).
 * "cron" is a fixed pseudo-IP for the Gemini daily-cap bookkeeping
 * (worker/rate-limit.ts), distinct from any real visitor IP. */
async function classifyUnslottedArtists(env: Env, primaryArtistIds: string[]): Promise<void> {
  if (primaryArtistIds.length === 0) return;
  try {
    const placeholders = primaryArtistIds.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT artist_id, name FROM artist_cache WHERE slot_id IS NULL AND artist_id IN (${placeholders})`,
    )
      .bind(...primaryArtistIds)
      .all<{ artist_id: string; name: string }>();
    if (results.length === 0) return;

    const artists: TopArtistOut[] = results.map((row, i) => ({
      id: row.artist_id,
      name: row.name,
      genres: [],
      image: null,
      rank: i + 1, // unused by resolveArtistSlots — TopArtistOut just requires a value
    }));
    await resolveArtistSlots(env, "cron", artists);
  } catch (err) {
    console.error("[history] cron classification failed (play_event rows already written are unaffected):", err);
  }
}

/**
 * Runs one cron cycle: checks for an active ban, fetches recently-played,
 * and inserts every new play (plus the track/artist rows it needs) in a
 * single `env.DB.batch()` round trip. Never throws — every exit path (ban,
 * not connected, Spotify failure, unexpected error) either returns quietly
 * or logs a `history_sync` row, per SPEC.md's Phase 8a spec.
 */
export async function runHistorySync(env: Env): Promise<void> {
  try {
    if (await isSpotifyBanned(env)) {
      await recordRun(env, {
        ok: false,
        fetched: 0,
        inserted: 0,
        gapSuspected: false,
        error: "skipped: active 429 ban (see usage_log)",
      });
      return;
    }

    let accessToken: string | null;
    try {
      accessToken = await getAccessToken(env);
    } catch (err) {
      if (err instanceof TokenError) return; // not connected — quiet, not an error
      throw err;
    }
    if (accessToken === null) return; // no Spotify account connected — quiet, not an error

    const data = await spotifyGet<RecentlyPlayedResponse>(
      env,
      `/me/player/recently-played?limit=${RECENTLY_PLAYED_LIMIT}`,
      accessToken,
    );

    const fetched = data.items.length;
    const usable = data.items.filter(isUsableItem);

    const existing = await env.DB.prepare("SELECT COUNT(*) AS n FROM play_event").first<{ n: number }>();
    const isFirstRun = (existing?.n ?? 0) === 0;

    const now = new Date().toISOString();
    const statements = [];

    // play_event inserts go first and in this exact order — `inserted`
    // below sums D1's per-statement `meta.changes` over the first
    // `usable.length` results, so the ordering here is load-bearing.
    for (const item of usable) {
      const track = item.track;
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO play_event (played_at, track_id, primary_artist_id, artist_ids, duration_ms, context_uri)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(
          Date.parse(item.played_at),
          track.id,
          track.artists[0]!.id,
          JSON.stringify(track.artists.map((a) => a.id)),
          track.duration_ms,
          item.context?.uri ?? null,
        ),
      );
    }

    // track_cache, from each item's inline track object — zero extra
    // Spotify calls (see this file's doc comment / SPEC.md). Deduped within
    // this run so a track played twice in the same window doesn't queue two
    // identical statements.
    const seenTracks = new Set<string>();
    for (const item of usable) {
      const track = item.track;
      if (seenTracks.has(track.id!)) continue;
      seenTracks.add(track.id!);
      statements.push(
        env.DB.prepare(
          `INSERT INTO track_cache (track_id, name, artist_names, album_name, image_url, spotify_url, duration_ms, cached_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(track_id) DO NOTHING`,
        ).bind(
          track.id,
          track.name,
          track.artists.map((a) => a.name).join(", "),
          track.album.name,
          track.album.images[0]?.url ?? null,
          track.external_urls.spotify,
          track.duration_ms,
          now,
        ),
      );
    }

    // artist_cache seed rows — slot_id/slot_source/slot_confidence/
    // inferred_at are left NULL (never included in this INSERT), which is
    // exactly what keeps a seeded row invisible to the village pipeline
    // (worker/genre-resolution.ts's fetchCachedArtists filters
    // `slot_id IS NOT NULL`) until the real artist pipeline resolves it for
    // real and overwrites this row via upsertArtistCache's full-column
    // ON CONFLICT DO UPDATE.
    const seenArtists = new Set<string>();
    for (const item of usable) {
      for (const artist of item.track.artists) {
        if (!artist.id || seenArtists.has(artist.id)) continue;
        seenArtists.add(artist.id);
        statements.push(
          env.DB.prepare(
            `INSERT INTO artist_cache (artist_id, name, genres, image_url, cached_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(artist_id) DO NOTHING`,
          ).bind(artist.id, artist.name, "[]", null, now),
        );
      }
    }

    let inserted = 0;
    if (statements.length > 0) {
      const results = await env.DB.batch(statements);
      for (let i = 0; i < usable.length; i++) {
        inserted += results[i]!.meta.changes ?? 0;
      }
    }

    // Phase 8b: classify this run's primary artists that still have no slot
    // (e.g. one that only just got seeded into artist_cache above, or one
    // that's never shown up in a /api/village Spotify fetch) — see
    // classifyUnslottedArtists's doc comment for why this can never fail the
    // sync above it.
    await classifyUnslottedArtists(env, Array.from(new Set(usable.map((item) => item.track.artists[0]!.id!))));

    // The endpoint only ever retains the newest 50 plays with no paging past
    // them, so if every fetched item was new (zero overlap with what's
    // already stored) on a run that isn't the very first one, some plays in
    // between almost certainly fell off the end before any cron run saw
    // them — unrecoverable, just worth recording rather than backfilling.
    const gapSuspected = !isFirstRun && fetched > 0 && inserted === fetched;

    await recordRun(env, { ok: true, fetched, inserted, gapSuspected, error: null });
  } catch (err) {
    console.error("[history] sync run failed:", err);
    await recordRun(env, {
      ok: false,
      fetched: 0,
      inserted: 0,
      gapSuspected: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

interface HistoryStatsRow {
  plays: number;
  min_played: number | null;
  max_played: number | null;
}

export interface HistoryStatsPayload {
  /** epoch ms of the earliest logged play, or null before any data exists. */
  collectingSince: number | null;
  plays: number;
  /** epoch ms of the most recent logged play, or null. */
  lastPlayedAt: number | null;
  /** ISO timestamp of the most recent cron run (successful or not), or null
   * if the cron has never run yet. */
  lastSyncAt: string | null;
}

/** GET /api/history/stats — D1-only (no `caches.default` entry: every
 * number here already comes straight out of two small local tables, so
 * there's nothing upstream worth caching), feeding the small "Collecting
 * since ... · N plays logged" readout (src/history-stats.ts). Never touches
 * Spotify or the access token — a visitor sees this even while "live
 * paused". */
export async function handleHistoryStats(env: Env): Promise<Response> {
  const playRow = await env.DB.prepare(
    "SELECT COUNT(*) AS plays, MIN(played_at) AS min_played, MAX(played_at) AS max_played FROM play_event",
  ).first<HistoryStatsRow>();
  const syncRow = await env.DB.prepare("SELECT ran_at FROM history_sync ORDER BY id DESC LIMIT 1").first<{
    ran_at: string;
  }>();

  const payload: HistoryStatsPayload = {
    collectingSince: playRow?.min_played ?? null,
    plays: playRow?.plays ?? 0,
    lastPlayedAt: playRow?.max_played ?? null,
    lastSyncAt: syncRow?.ran_at ?? null,
  };
  return Response.json(payload);
}
