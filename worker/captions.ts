// AI live captions (Phase 7c) — short in-world caption lines for whatever
// track is currently playing, used by the frontend in place of its template
// "Now playing: X – Y" text once one exists. Called from
// worker/now-playing.ts, not a separate endpoint: that handler already
// resolves the track's slotId from artist_cache on every refresh of its own
// ~10s shared cache (see its doc comment), so reading/writing one more D1
// table here costs zero extra Spotify calls — SPEC.md's Phase 7c bullet
// explicitly prefers whichever of the two adds none.
//
// Cached forever per (artist id, track id) in `caption_cache` (migration
// 0008): once a pair has a row, every later call is a plain D1 SELECT, never
// another Gemini call. This matters because now-playing's shared cache only
// covers ~10s — a song playing its whole ~3-4 minutes crosses roughly 20 of
// those windows, and without this table each one would re-trigger
// generation instead of at most one per newly-seen track. Two isolates
// racing on the very first poll of a brand-new track could both miss the D1
// cache and both call Gemini before either write lands; accepted the same
// way worker/genre-resolution.ts accepts the equivalent race for
// artist_cache/genre_slot_map (`ON CONFLICT DO NOTHING`, cheap and rare for
// a personal-scale app) rather than adding a distributed lock for it.
//
// Failure/quota behavior mirrors genre-resolution.ts: no cached row, quota
// exhausted, or a Gemini error all degrade to `null` — worker/now-playing.ts
// then leaves the track's `caption` null and the frontend falls back to its
// own template caption exactly as it did before Phase 7c. Never throws.

import type { Env } from "./index";
import { generateCaptions, GeminiRequestError } from "./gemini";
import { geminiQuotaAvailable, logGeminiCall } from "./rate-limit";
import { getSlot } from "../data/loader";

interface CaptionCacheRow {
  lines: string; // JSON array of strings
}

async function readCache(env: Env, artistId: string, trackId: string): Promise<string[] | null> {
  const row = await env.DB.prepare("SELECT lines FROM caption_cache WHERE artist_id = ? AND track_id = ?")
    .bind(artistId, trackId)
    .first<CaptionCacheRow>();
  if (!row) return null;
  try {
    const parsed: unknown = JSON.parse(row.lines);
    return Array.isArray(parsed) && parsed.every((s) => typeof s === "string") ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

async function writeCache(env: Env, artistId: string, trackId: string, lines: string[]): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO caption_cache (artist_id, track_id, lines, generated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(artist_id, track_id) DO NOTHING`,
  )
    .bind(artistId, trackId, JSON.stringify(lines), new Date().toISOString())
    .run();
}

function pickLine(lines: string[]): string | null {
  if (lines.length === 0) return null;
  return lines[Math.floor(Math.random() * lines.length)]!;
}

/** Returns one AI caption line for `artistName`/`trackName` reacting in
 * `slotId`'s district, generating (and caching) one first if this exact
 * (artistId, trackId) pair has never been captioned before. Returns null —
 * never throws — when there's nothing cached and one couldn't be generated
 * (Gemini daily cap already hit, a Gemini failure, or a D1 hiccup); callers
 * fall back to their own template caption in that case.
 *
 * `ip` is only for the shared Gemini daily-cap bookkeeping
 * (worker/rate-limit.ts) — same role it plays in genre-resolution.ts —
 * never sent to Gemini itself. */
export async function captionFor(
  env: Env,
  ip: string,
  slotId: string,
  artistId: string,
  artistName: string,
  trackId: string,
  trackName: string,
): Promise<string | null> {
  try {
    const cached = await readCache(env, artistId, trackId);
    if (cached) return pickLine(cached);

    if (!(await geminiQuotaAvailable(env, ip))) return null;

    const genre = getSlot(slotId).district.genre;
    await logGeminiCall(env, ip, "captions");
    const lines = await generateCaptions(env, artistName, trackName, genre);
    await writeCache(env, artistId, trackId, lines);
    return pickLine(lines);
  } catch (err) {
    if (!(err instanceof GeminiRequestError)) {
      console.error("[captions] unexpected failure, degrading to no AI caption:", err);
    }
    return null;
  }
}
