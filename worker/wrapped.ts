// GET /api/wrapped?range=week|month|year|all — Phase 8.5: a Wrapped-style
// read on the owner's own listening, over real arbitrary ranges (unlike
// Spotify's three fixed time_range buckets), driven primarily by Phase 8a's
// play_event log — the only source of true play counts and minutes Spotify's
// API never exposes (see worker/history.ts's doc comment).
//
// Two sources, one response shape (WrappedPayload) so the frontend never has
// to branch on which one it got beyond the `source` label:
//   - "history": the normal case once play_event has enough rows in the
//     requested window — real plays, real approxMinutes, real topGenres.
//   - "spotify": the window has too little logged history yet (a fresh
//     install, or a range wider than what's been collected so far) — falls
//     back to /me/top/tracks + /me/top/artists, rank-only, clearly labelled.
// SPEC.md's Phase 8.5 decisions: no backfill/no fabricated pre-history
// figures (collectingSince is always the true answer, shown as-is), and
// duration_ms is catalog length, not listened time, so approxMinutes must
// read as approximate, never exact — enforced here only by naming; the
// "≈" labelling itself is the frontend's job.

import type { Env } from "./index";
import { getAccessToken, TokenError } from "./token";
import { spotifyGet } from "./spotify-fetch";
import { fetchTopTracks } from "./tracks";
import { deriveArtists, type SpotifyTopArtistsResponse } from "./top-artists";
import { slotPlaysBetween } from "./history-query";
import { isSpotifyBanned } from "./history";

export type WrappedRange = "week" | "month" | "year" | "all";

const VALID_RANGES = new Set<string>(["week", "month", "year", "all"]);

// Below this many raw plays in the window, history is too thin to be a real
// "Wrapped" (a handful of plays would make for a misleadingly tiny top-10) —
// fall back to Spotify's own top lists instead (see spotifyFallbackPayload).
const MIN_HISTORY_PLAYS = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

// `all` has no lower bound — windowFor turns that into fromMs = 0, naturally
// bounded in practice by Phase 8a's 2026-09-18 start (nothing was logged
// before then), same convention as SPEC.md's era→history-window mapping.
const RANGE_WINDOW_DAYS: Record<WrappedRange, number | null> = {
  week: 7,
  month: 30,
  year: 365,
  all: null,
};

// week/month both map to short_term — Spotify has no "last 7 days" bucket of
// its own, and short_term ("approximately last 4 weeks") is the closest
// fallback for either. See SPEC.md's Phase 8.5 spec.
const SPOTIFY_TIME_RANGE: Record<WrappedRange, string> = {
  week: "short_term",
  month: "short_term",
  year: "medium_term",
  all: "long_term",
};

export interface WrappedTrackOut {
  id: string;
  name: string;
  /** Comma-joined display string, same convention as track_cache/TrackOut. */
  artists: string;
  art: string | null;
  /** History source only — null (never fabricated) on the Spotify fallback. */
  plays: number | null;
  /** Spotify fallback only (Spotify gives rank, never a play count) — null on the history source. */
  rank: number | null;
}

export interface WrappedArtistOut {
  id: string;
  name: string;
  image: string | null;
  plays: number | null;
  rank: number | null;
}

export interface WrappedGenreOut {
  slotId: string;
  plays: number;
}

export interface WrappedPayload {
  range: WrappedRange;
  source: "history" | "spotify";
  /** epoch ms of the earliest logged play ever, or null before any data
   * exists — always the true, whole-history answer (never scoped to
   * `range`), so a viewer can always see how far back real data goes. */
  collectingSince: number | null;
  /** null on the Spotify fallback — Spotify exposes no play counts. */
  totalPlays: number | null;
  /** Sum of duration_ms / 60000, rounded — a track's catalog length, not
   * listened time (see this file's doc comment), so the frontend must label
   * it approximate. Null on the Spotify fallback. */
  approxMinutes: number | null;
  topTracks: WrappedTrackOut[];
  topArtists: WrappedArtistOut[];
  /** Empty on the Spotify fallback — Spotify has no genre-play-count
   * endpoint, and mapping its artists' raw genres to slots here would mean
   * an uncached classification call on a page load, which every other route
   * in this Worker already refuses to do (see worker/tracks.ts's doc
   * comment on the same rule). */
  topGenres: WrappedGenreOut[];
  /** Plays in the window whose primary artist has no resolved slot yet —
   * always 0 on the Spotify fallback (no play_event rows are involved). */
  unclassifiedPlays: number;
}

function isWrappedRange(value: string): value is WrappedRange {
  return VALID_RANGES.has(value);
}

function windowFor(range: WrappedRange, nowMs: number): { fromMs: number; toMs: number } {
  const days = RANGE_WINDOW_DAYS[range];
  return { fromMs: days === null ? 0 : nowMs - days * DAY_MS, toMs: nowMs };
}

async function fetchCollectingSince(env: Env): Promise<number | null> {
  const row = await env.DB.prepare("SELECT MIN(played_at) AS min_played FROM play_event").first<{
    min_played: number | null;
  }>();
  return row?.min_played ?? null;
}

interface WindowTotalsRow {
  n: number;
  dur: number;
}

async function windowTotals(env: Env, fromMs: number, toMs: number): Promise<{ totalPlays: number; totalDurationMs: number }> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(duration_ms), 0) AS dur FROM play_event WHERE played_at >= ? AND played_at <= ?`,
  )
    .bind(fromMs, toMs)
    .first<WindowTotalsRow>();
  return { totalPlays: row?.n ?? 0, totalDurationMs: row?.dur ?? 0 };
}

interface TrackWindowRow {
  track_id: string;
  name: string;
  artist_names: string;
  image_url: string | null;
  plays: number;
}

/** Top 10 tracks by play count in the window, joined to track_cache for
 * display fields (never re-resolved from Spotify — see track_cache's own
 * doc comment on why that would cost a call per historical row). */
async function topTracksInWindow(env: Env, fromMs: number, toMs: number): Promise<WrappedTrackOut[]> {
  const { results } = await env.DB.prepare(
    `SELECT tc.track_id AS track_id, tc.name AS name, tc.artist_names AS artist_names, tc.image_url AS image_url, COUNT(*) AS plays
     FROM play_event pe
     JOIN track_cache tc ON tc.track_id = pe.track_id
     WHERE pe.played_at >= ? AND pe.played_at <= ?
     GROUP BY tc.track_id
     ORDER BY plays DESC
     LIMIT 10`,
  )
    .bind(fromMs, toMs)
    .all<TrackWindowRow>();
  return results.map((row) => ({
    id: row.track_id,
    name: row.name,
    artists: row.artist_names,
    art: row.image_url,
    plays: row.plays,
    rank: null,
  }));
}

interface ArtistWindowRow {
  artist_id: string;
  name: string;
  image_url: string | null;
  plays: number;
}

/** Top 10 artists by play count in the window — aggregated by
 * `primary_artist_id` only, one vote per play, same convention as
 * worker/history-query.ts's slotPlaysBetween and worker/tracks.ts's
 * bucketing (never json_each over every artist on a track). */
async function topArtistsInWindow(env: Env, fromMs: number, toMs: number): Promise<WrappedArtistOut[]> {
  const { results } = await env.DB.prepare(
    `SELECT ac.artist_id AS artist_id, ac.name AS name, ac.image_url AS image_url, COUNT(*) AS plays
     FROM play_event pe
     JOIN artist_cache ac ON ac.artist_id = pe.primary_artist_id
     WHERE pe.played_at >= ? AND pe.played_at <= ?
     GROUP BY ac.artist_id
     ORDER BY plays DESC
     LIMIT 10`,
  )
    .bind(fromMs, toMs)
    .all<ArtistWindowRow>();
  return results.map((row) => ({
    id: row.artist_id,
    name: row.name,
    image: row.image_url,
    plays: row.plays,
    rank: null,
  }));
}

/** Builds the "history" source payload — always callable, even with zero
 * plays in the window (SPEC.md: never error, show a thin/empty result
 * instead). */
async function historyPayload(
  env: Env,
  range: WrappedRange,
  fromMs: number,
  toMs: number,
  collectingSince: number | null,
  totals: { totalPlays: number; totalDurationMs: number },
): Promise<WrappedPayload> {
  const { totalPlays, totalDurationMs } = totals;
  const [topTracks, topArtists, slotPlays] = await Promise.all([
    topTracksInWindow(env, fromMs, toMs),
    topArtistsInWindow(env, fromMs, toMs),
    slotPlaysBetween(env, fromMs, toMs),
  ]);

  const topGenres = Object.entries(slotPlays.bySlot)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([slotId, plays]) => ({ slotId, plays }));

  return {
    range,
    source: "history",
    collectingSince,
    totalPlays,
    approxMinutes: Math.round(totalDurationMs / 60_000),
    topTracks,
    topArtists,
    topGenres,
    unclassifiedPlays: totalPlays - slotPlays.slottedPlays,
  };
}

/** Attempts the Spotify top-lists fallback; returns null on anything that
 * should fall through to the (thin) history payload instead — not
 * connected, an active 429 ban, or the Spotify calls themselves failing.
 * Deliberately a broad catch around the Spotify calls, unlike every other
 * route in this Worker (top-artists.ts/tracks.ts only ever catch
 * SpotifyRequestError and let anything else 500) — SPEC.md's Phase 8.5 says
 * a failed fallback must never turn into an error response for this
 * endpoint, only the quieter history payload the caller falls back to. */
async function spotifyFallbackPayload(
  env: Env,
  range: WrappedRange,
  collectingSince: number | null,
): Promise<WrappedPayload | null> {
  if (await isSpotifyBanned(env)) return null;

  let accessToken: string | null;
  try {
    accessToken = await getAccessToken(env);
  } catch (err) {
    if (err instanceof TokenError) return null;
    throw err;
  }
  if (accessToken === null) return null;

  const timeRange = SPOTIFY_TIME_RANGE[range];

  try {
    const [tracks, artistsData] = await Promise.all([
      fetchTopTracks(env, accessToken, timeRange),
      spotifyGet<SpotifyTopArtistsResponse>(env, `/me/top/artists?time_range=${timeRange}&limit=10`, accessToken),
    ]);

    const topTracks: WrappedTrackOut[] = tracks.slice(0, 10).map((t, i) => ({
      id: t.id,
      name: t.title,
      artists: t.artist,
      art: t.coverUrl,
      plays: null,
      rank: i + 1,
    }));
    const topArtists: WrappedArtistOut[] = deriveArtists(artistsData.items).map((a) => ({
      id: a.id,
      name: a.name,
      image: a.image,
      plays: null,
      rank: a.rank,
    }));

    return {
      range,
      source: "spotify",
      collectingSince,
      totalPlays: null,
      approxMinutes: null,
      topTracks,
      topArtists,
      topGenres: [],
      unclassifiedPlays: 0,
    };
  } catch (err) {
    console.error("[wrapped] Spotify fallback failed, falling back to history data:", err);
    return null;
  }
}

export async function handleWrapped(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const rangeParam = url.searchParams.get("range");
  if (!rangeParam || !isWrappedRange(rangeParam)) {
    return Response.json({ error: "range must be week, month, year, or all" }, { status: 400 });
  }
  const range = rangeParam;

  const nowMs = Date.now();
  const { fromMs, toMs } = windowFor(range, nowMs);
  const collectingSince = await fetchCollectingSince(env);
  const totals = await windowTotals(env, fromMs, toMs);

  if (totals.totalPlays >= MIN_HISTORY_PLAYS) {
    return Response.json(await historyPayload(env, range, fromMs, toMs, collectingSince, totals));
  }

  const fallback = await spotifyFallbackPayload(env, range, collectingSince);
  if (fallback) return Response.json(fallback);

  return Response.json(await historyPayload(env, range, fromMs, toMs, collectingSince, totals));
}
