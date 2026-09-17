// Resolves each top artist to one of the 17 roster slots, caching every
// step in D1 so a given artist or genre string only ever costs one Gemini
// call, ever (SPEC.md: "never call Gemini for something already cached").
//
// Order of preference per artist:
//   1. `artist_cache` already has a slot for this artist id — done, no
//      lookup or call needed at all.
//   2. Spotify gave this artist genres — resolve each genre string via
//      `genre_slot_map` (itself cached per genre string), batching every
//      still-unseen genre into a single Gemini call.
//   3. Spotify gave no genres (the common case for this account — see
//      SPEC.md's "Reality check") — batch the artist's *name* into a single
//      Gemini call classifying names straight to slots.
// Whichever path resolves an artist, the result is written back to
// `artist_cache` so step 1 catches it from then on.
//
// If the Gemini daily cap (worker/rate-limit.ts) is already hit, or a
// Gemini call itself fails (network error, non-OK status, bad response —
// see worker/gemini.ts's GeminiRequestError), no further Gemini call is
// made for that batch: anything that would have needed one instead gets a
// deterministic, low-confidence "nearest slot" guess (hashed from its
// name/genre — not persisted to the shared caches, since it's a degraded
// stand-in, not a real classification). The response says which happened
// via `geminiLimited` (quota cap) / `geminiError` (an actual failure) —
// either way, resolution for every other artist proceeds normally, and
// `resolveArtistSlots` itself is guaranteed never to throw (see its own
// try/catch below) so a Gemini problem never turns into a 500.

import type { Env } from "./index";
import type { TopArtistOut } from "./top-artists";
import { classifyArtistNames, classifyGenres, type SlotGuess } from "./gemini";
import { geminiQuotaAvailable, logGeminiCall } from "./rate-limit";
import { SLOTS } from "../data/loader";

const SLOT_IDS = SLOTS.map((s) => s.district.id);

// Spotify never supplies a slot id, only genre strings (and often not even
// those — see SPEC.md's "Reality check"), so "source" describes how the
// *slot* was determined, not where the genre string came from: either a
// real Gemini classification, or the deterministic no-AI fallback below.
export type SlotSource = "gemini" | "fallback";

export interface ArtistSlot {
  slotId: string;
  confidence: number;
  source: SlotSource;
}

export interface GenreResolutionResult {
  bySlotId: Map<string, ArtistSlot>;
  /** True if the Gemini daily cap was hit and at least one artist/genre had
   * to use the non-AI fallback instead of a real classification. */
  geminiLimited: boolean;
  /** Set to the first Gemini call's error message if one actually failed
   * (as opposed to being skipped because the daily cap was hit). */
  geminiError: string | null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeGenre(genre: string): string {
  return genre.trim().toLowerCase();
}

/** Deterministic "nearest slot" for when Gemini can't be called (quota hit
 * or an actual failure) and nothing is cached yet — stable across calls
 * (same string always lands on the same slot) rather than random, so a
 * degraded response doesn't visibly reshuffle a district's residents on
 * every request. Not a real classification, so callers must not persist it
 * to the shared caches. */
export function fallbackSlot(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return SLOT_IDS[Math.abs(hash) % SLOT_IDS.length]!;
}

interface ArtistCacheRow {
  artist_id: string;
  slot_id: string | null;
  slot_source: SlotSource | null;
  slot_confidence: number | null;
}

interface GenreSlotMapRow {
  genre: string;
  slot_id: string;
  source: SlotSource;
  confidence: number;
}

async function fetchCachedArtists(env: Env, artistIds: string[]): Promise<Map<string, ArtistCacheRow>> {
  if (artistIds.length === 0) return new Map();
  const placeholders = artistIds.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT artist_id, slot_id, slot_source, slot_confidence FROM artist_cache WHERE artist_id IN (${placeholders}) AND slot_id IS NOT NULL`,
  )
    .bind(...artistIds)
    .all<ArtistCacheRow>();
  return new Map(results.map((r) => [r.artist_id, r]));
}

async function fetchCachedGenres(env: Env, genres: string[]): Promise<Map<string, GenreSlotMapRow>> {
  if (genres.length === 0) return new Map();
  const placeholders = genres.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT genre, slot_id, source, confidence FROM genre_slot_map WHERE genre IN (${placeholders})`,
  )
    .bind(...genres)
    .all<GenreSlotMapRow>();
  return new Map(results.map((r) => [r.genre, r]));
}

async function insertGenreSlotMap(
  env: Env,
  genre: string,
  guess: SlotGuess,
  source: SlotSource,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO genre_slot_map (genre, slot_id, source, confidence, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(genre) DO NOTHING`,
  )
    .bind(genre, guess.slotId, source, guess.confidence, new Date().toISOString())
    .run();
}

async function upsertArtistCache(
  env: Env,
  artist: TopArtistOut,
  slot: ArtistSlot,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO artist_cache (artist_id, name, genres, image_url, cached_at, slot_id, slot_source, slot_confidence, inferred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(artist_id) DO UPDATE SET
       name = excluded.name,
       genres = excluded.genres,
       image_url = excluded.image_url,
       cached_at = excluded.cached_at,
       slot_id = excluded.slot_id,
       slot_source = excluded.slot_source,
       slot_confidence = excluded.slot_confidence,
       inferred_at = excluded.inferred_at`,
  )
    .bind(
      artist.id,
      artist.name,
      JSON.stringify(artist.genres),
      artist.image,
      now,
      slot.slotId,
      slot.source,
      slot.confidence,
      now,
    )
    .run();
}

async function resolveArtistSlotsInner(
  env: Env,
  ip: string,
  artists: TopArtistOut[],
): Promise<GenreResolutionResult> {
  const bySlotId = new Map<string, ArtistSlot>();
  let geminiLimited = false;
  let geminiError: string | null = null;

  const cachedArtists = await fetchCachedArtists(
    env,
    artists.map((a) => a.id),
  );
  const uncached = artists.filter((a) => !cachedArtists.has(a.id));
  for (const [artistId, row] of cachedArtists) {
    bySlotId.set(artistId, {
      slotId: row.slot_id!,
      confidence: row.slot_confidence ?? 0,
      source: row.slot_source ?? "fallback",
    });
  }

  if (uncached.length === 0) {
    return { bySlotId, geminiLimited, geminiError };
  }

  const withGenres = uncached.filter((a) => a.genres.length > 0);
  const withoutGenres = uncached.filter((a) => a.genres.length === 0);

  // ---- Path 1: artists with Spotify-supplied genres ----
  const genreToSlot = new Map<string, SlotGuess & { source: SlotSource }>();
  if (withGenres.length > 0) {
    const allGenres = Array.from(new Set(withGenres.flatMap((a) => a.genres.map(normalizeGenre))));
    const cachedGenres = await fetchCachedGenres(env, allGenres);
    for (const [genre, row] of cachedGenres) {
      genreToSlot.set(genre, { slotId: row.slot_id, confidence: row.confidence, source: row.source });
    }
    const uncachedGenres = allGenres.filter((g) => !cachedGenres.has(g));

    if (uncachedGenres.length > 0) {
      if (await geminiQuotaAvailable(env, ip)) {
        let guesses: Map<string, SlotGuess> | null = null;
        try {
          await logGeminiCall(env, ip, "genres");
          guesses = await classifyGenres(env, uncachedGenres);
        } catch (err) {
          geminiError = geminiError ?? errorMessage(err);
        }
        for (const genre of uncachedGenres) {
          const guess = guesses?.get(genre);
          if (guess) {
            genreToSlot.set(genre, { ...guess, source: "gemini" });
            await insertGenreSlotMap(env, genre, guess, "gemini");
          } else {
            // Either the whole call failed (guesses is null — geminiError is
            // already set above) or Gemini's response just skipped this one
            // genre (a schema/parse gap) — either way, fall back.
            genreToSlot.set(genre, { slotId: fallbackSlot(genre), confidence: 0.05, source: "fallback" });
          }
        }
      } else {
        geminiLimited = true;
        for (const genre of uncachedGenres) {
          // Degraded, not persisted — see fallbackSlot's doc comment.
          genreToSlot.set(genre, { slotId: fallbackSlot(genre), confidence: 0.05, source: "fallback" });
        }
      }
    }

    for (const artist of withGenres) {
      const guesses = artist.genres
        .map((g) => genreToSlot.get(normalizeGenre(g)))
        .filter((g): g is SlotGuess & { source: SlotSource } => g !== undefined);
      const best = guesses.reduce<(SlotGuess & { source: SlotSource }) | undefined>(
        (acc, g) => (!acc || g.confidence > acc.confidence ? g : acc),
        undefined,
      );
      const slot: ArtistSlot = best
        ? { slotId: best.slotId, confidence: best.confidence, source: best.source }
        : { slotId: fallbackSlot(artist.name), confidence: 0.05, source: "fallback" };
      bySlotId.set(artist.id, slot);
      // A fallback guess isn't a real classification — leave it uncached so
      // a later request (once genres/quota resolve) tries again for real.
      if (slot.source !== "fallback") await upsertArtistCache(env, artist, slot);
    }
  }

  // ---- Path 2: artists with no genres at all — classify by name ----
  if (withoutGenres.length > 0) {
    let nameGuesses: Map<string, SlotGuess> | null = null;
    if (await geminiQuotaAvailable(env, ip)) {
      try {
        await logGeminiCall(env, ip, "artists");
        nameGuesses = await classifyArtistNames(
          env,
          withoutGenres.map((a) => a.name),
        );
      } catch (err) {
        geminiError = geminiError ?? errorMessage(err);
      }
    } else {
      geminiLimited = true;
    }

    for (const artist of withoutGenres) {
      const guess = nameGuesses?.get(artist.name);
      const slot: ArtistSlot = guess
        ? { slotId: guess.slotId, confidence: guess.confidence, source: "gemini" }
        : { slotId: fallbackSlot(artist.name), confidence: 0.05, source: "fallback" };
      bySlotId.set(artist.id, slot);
      if (slot.source !== "fallback") await upsertArtistCache(env, artist, slot);
    }
  }

  return { bySlotId, geminiLimited, geminiError };
}

/** Resolves every artist in `artists` to a roster slot, reading/writing the
 * D1 caches described above. `ip` is only used for the Gemini daily cap
 * bookkeeping (worker/rate-limit.ts) — never sent to Gemini itself.
 *
 * Guaranteed never to throw: Gemini call failures are already caught inside
 * resolveArtistSlotsInner (see `geminiError`/`geminiLimited`); this outer
 * try/catch is defense-in-depth against anything else unexpected (e.g. a D1
 * hiccup), so worker/village.ts can always build *some* village — every
 * artist just gets the same deterministic fallback slot — rather than
 * failing the whole request. */
export async function resolveArtistSlots(
  env: Env,
  ip: string,
  artists: TopArtistOut[],
): Promise<GenreResolutionResult> {
  try {
    return await resolveArtistSlotsInner(env, ip, artists);
  } catch (err) {
    console.error("[genre-resolution] unexpected failure, using fallback slots for every artist:", err);
    const bySlotId = new Map<string, ArtistSlot>();
    for (const artist of artists) {
      bySlotId.set(artist.id, { slotId: fallbackSlot(artist.name), confidence: 0.05, source: "fallback" });
    }
    return { bySlotId, geminiLimited: false, geminiError: errorMessage(err) };
  }
}
