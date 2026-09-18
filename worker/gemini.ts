// Gemini Flash-Lite genre/artist classification. The only thing in this
// Worker allowed to call Gemini — everything else goes through
// worker/genre-resolution.ts, which decides *whether* a call is even needed
// (cache first, quota check second — see worker/rate-limit.ts) and catches
// anything this file throws so a Gemini failure degrades instead of 500ing
// the whole /api/village response.
//
// Plain `fetch` against the REST API, not the `@google/genai` SDK: the SDK
// crashed in production (Cloudflare error 1101, worker threw, no useful
// `wrangler tail` output) even though the exact same code worked against
// `wrangler d1 execute --local`-style local checks — almost certainly the
// SDK reaching for a Node API `workerd` doesn't provide without the
// `nodejs_compat` compatibility flag. A raw `fetch` call has no such
// runtime-detection surface and is trivially debuggable (a non-OK response
// is just an HTTP status + body).
//
// Model: pinned to "gemini-3.5-flash-lite" (verified against
// https://ai.google.dev/gemini-api/docs/models on 2026-09-17 — the current
// stable Flash-Lite id, no "-latest" alias listed for it). SPEC.md's Gemini
// section says Flash-Lite everywhere by default; this task never needs more
// than short classification, so there's no case to escalate to full Flash.
//
// AI policy (SPEC.md): inference only, never fine-tuning, and the prompt
// carries only the minimal derived fields — genre/tag strings or artist
// names — never a raw Spotify payload, user id, or token.

import type { Env } from "./index";
import { SLOTS } from "../data/loader";
import { MOOD_IDS, type MoodId } from "../shared/mood";

const MODEL_ID = "gemini-3.5-flash-lite";
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent`;

const SLOT_IDS = SLOTS.map((s) => s.district.id);
const SLOT_GENRE_LINES = SLOTS.map((s) => `- "${s.district.id}": ${s.district.genre}`).join("\n");

// Re-exported so callers (worker/genre-resolution.ts, worker/village.ts) can
// import both the mood roster and the classification types from this one
// file, same as they already do for SlotGuess/coerceSlot's slot roster.
export { MOOD_IDS, type MoodId };

export interface SlotGuess {
  slotId: string;
  confidence: number;
}

export interface MoodGuess {
  mood: MoodId;
  energy: number;
}

/** Thrown for anything that goes wrong calling Gemini — network failure, a
 * non-OK HTTP status, or a response with no usable text. Callers (see
 * worker/genre-resolution.ts) always catch this and fall back rather than
 * letting it propagate into a 500. */
export class GeminiRequestError extends Error {}

function clampConfidence(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(1, n));
}

// Same 0..1 clamp as clampConfidence, just under the name Phase 7a's mood
// tagging actually reads at its call site.
const clampEnergy = clampConfidence;

/** Coerces a model-returned mood to one of MOOD_IDS — mirrors coerceSlot: a
 * hallucinated/misspelled value falls back to the first mood rather than
 * reaching D1/the client. */
function coerceMood(value: unknown): MoodId {
  return typeof value === "string" && (MOOD_IDS as readonly string[]).includes(value)
    ? (value as MoodId)
    : MOOD_IDS[0];
}

/** Coerces a model-returned slot id to one of the 17 known ids — a
 * hallucinated/misspelled id falls back to the first slot with confidence
 * left untouched (the caller already has to treat every Gemini guess as
 * fallible; this just stops an invalid id from reaching D1/the client). */
function coerceSlot(id: unknown): string {
  return typeof id === "string" && SLOT_IDS.includes(id) ? id : SLOT_IDS[0]!;
}

// Plain OpenAPI-style schema objects — the same shape @google/genai's `Type`
// enum produced (its values are literally these uppercase strings), just
// written by hand so this file has zero SDK dependency.
function resultSchema(keyName: "genre" | "artist") {
  return {
    type: "ARRAY",
    items: {
      type: "OBJECT",
      properties: {
        [keyName]: { type: "STRING" },
        slot: { type: "STRING", enum: SLOT_IDS },
        confidence: {
          type: "NUMBER",
          description: "0..1 — how confident this mapping is. Use a value below 0.4 for a guess.",
        },
      },
      required: [keyName, "slot", "confidence"],
    },
  };
}

// Same hand-written OpenAPI-style shape as resultSchema above, for Phase
// 7a's mood tagging — its own function rather than a resultSchema("mood")
// variant since the fields (mood/energy) and their types don't line up with
// resultSchema's slot/confidence shape.
function moodResultSchema() {
  return {
    type: "ARRAY",
    items: {
      type: "OBJECT",
      properties: {
        artist: { type: "STRING" },
        mood: { type: "STRING", enum: [...MOOD_IDS] },
        energy: { type: "NUMBER", description: "0..1 — how high-energy this artist's music reads." },
      },
      required: ["artist", "mood", "energy"],
    },
  };
}

function safeParseArray(text: string): Record<string, unknown>[] {
  try {
    const data: unknown = JSON.parse(text);
    return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  } catch {
    return [];
  }
}

interface GeminiPart {
  text?: string;
}
interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
}
interface GeminiGenerateContentResponse {
  candidates?: GeminiCandidate[];
  // Present instead of `candidates` when the prompt itself was blocked
  // before generation (e.g. safety filters) — no candidate/content at all.
  promptFeedback?: { blockReason?: string };
}

/** Every failure path below throws with the HTTP status plus the first
 * ~300 chars of the *raw* response body, so a bad shape is self-explanatory
 * from `geminiError` alone on the next attempt — see worker/village.ts. */
function snippet(rawBody: string): string {
  return rawBody.slice(0, 300);
}

// Loose shape shared by resultSchema's and moodResultSchema's return values —
// generateJson only ever JSON.stringifies this, so it doesn't need (and
// deliberately doesn't pin to) either one's exact property set.
type JsonSchema = { type: string; items: { type: string; properties: Record<string, unknown>; required: string[] } };

/** POSTs one generateContent call with a JSON-schema-constrained response
 * and pulls the text out, checking every step of the documented response
 * shape (https://ai.google.dev/api/generate-content) explicitly rather than
 * silently defaulting through optional chaining — a defaulted `[]`/`""` is
 * exactly how a real shape mismatch (a blocked prompt, a non-STOP
 * finishReason, a missing `parts`) previously surfaced as a generic,
 * undiagnosable failure instead of a specific one. Throws `GeminiRequestError`
 * on any failure — network, non-OK status, or an unexpected/empty response —
 * never lets a raw fetch/parse exception escape this module. */
async function generateJson(env: Env, prompt: string, schema: JsonSchema): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: schema },
      }),
    });
  } catch (err) {
    throw new GeminiRequestError(`Gemini request failed (network error): ${(err as Error).message}`);
  }

  const rawBody = await res.text().catch((err) => {
    throw new GeminiRequestError(`Gemini response body could not be read (status ${res.status}): ${(err as Error).message}`);
  });

  if (!res.ok) {
    throw new GeminiRequestError(`Gemini request failed with status ${res.status}: ${snippet(rawBody)}`);
  }

  let data: GeminiGenerateContentResponse;
  try {
    data = JSON.parse(rawBody) as GeminiGenerateContentResponse;
  } catch (err) {
    throw new GeminiRequestError(
      `Gemini returned status ${res.status} but unparseable JSON (${(err as Error).message}): ${snippet(rawBody)}`,
    );
  }

  if (data.promptFeedback?.blockReason) {
    throw new GeminiRequestError(
      `Gemini blocked the prompt (${data.promptFeedback.blockReason}, status ${res.status}): ${snippet(rawBody)}`,
    );
  }

  const candidate = data.candidates?.[0];
  if (!candidate) {
    throw new GeminiRequestError(`Gemini response had no candidates (status ${res.status}): ${snippet(rawBody)}`);
  }

  if (candidate.finishReason && candidate.finishReason !== "STOP") {
    throw new GeminiRequestError(
      `Gemini finished with reason "${candidate.finishReason}" instead of STOP (status ${res.status}): ${snippet(rawBody)}`,
    );
  }

  const parts = candidate.content?.parts;
  if (!parts || parts.length === 0) {
    throw new GeminiRequestError(`Gemini response had no content parts (status ${res.status}): ${snippet(rawBody)}`);
  }

  const text = parts.map((p) => p.text ?? "").join("");
  if (!text) {
    throw new GeminiRequestError(`Gemini response parts had no text (status ${res.status}): ${snippet(rawBody)}`);
  }
  return text;
}

/** Classifies a batch of raw Spotify genre/tag strings into the 17 roster
 * slots in one call. */
export async function classifyGenres(env: Env, genres: string[]): Promise<Map<string, SlotGuess>> {
  if (genres.length === 0) return new Map();
  const prompt = [
    "You are sorting music genre/tag strings into a fixed set of 17 buckets.",
    "Buckets (id: representative genre):",
    SLOT_GENRE_LINES,
    "",
    "For each genre string below, pick the single closest bucket id.",
    "If a genre doesn't fit any bucket well, pick the nearest one anyway and give it a low confidence (below 0.4).",
    'Respond with a JSON array with one object per genre string, each with exactly the fields "genre" (the input string, unchanged), "slot" (one of the bucket ids above), and "confidence" (0..1).',
    "Genre strings (JSON array):",
    JSON.stringify(genres),
  ].join("\n");

  const text = await generateJson(env, prompt, resultSchema("genre"));
  const out = new Map<string, SlotGuess>();
  for (const row of safeParseArray(text)) {
    const genre = typeof row.genre === "string" ? row.genre : null;
    if (!genre) continue;
    out.set(genre, { slotId: coerceSlot(row.slot), confidence: clampConfidence(row.confidence) });
  }
  return out;
}

/** Normalizes an artist name for matching Gemini's echoed "artist" field
 * back to the name that was sent — trim, lowercase, Unicode-normalize
 * (NFC). Gemini doesn't always echo the input byte-for-byte (whitespace/
 * case/diacritic-composition can drift even though the prompt asks for it
 * "unchanged"), and an exact-string lookup miss there silently re-sends the
 * same artist to Gemini every cron run instead of ever caching it. Exported
 * so worker/genre-resolution.ts's lookup applies the exact same
 * normalization this file used to build the map's keys. */
export function normalizeArtistName(name: string): string {
  return name.trim().toLowerCase().normalize("NFC");
}

/** Classifies a batch of artist names directly into the 17 roster slots —
 * used only when Spotify returned no genres at all for that artist (the
 * common case for this account; see SPEC.md's "Reality check"). Sends only
 * artist names. */
export async function classifyArtistNames(env: Env, names: string[]): Promise<Map<string, SlotGuess>> {
  if (names.length === 0) return new Map();
  const prompt = [
    "You are placing musical artists into a fixed set of 17 genre buckets, using only their name — no other data is available.",
    "Buckets (id: representative genre):",
    SLOT_GENRE_LINES,
    "",
    "For each artist name below, infer their most likely genre from general knowledge and pick the single closest bucket id.",
    "If you don't recognize the artist, pick your best guess anyway and give it a low confidence (below 0.4).",
    'Respond with a JSON array with one object per artist name, each with exactly the fields "artist" (the input name, unchanged), "slot" (one of the bucket ids above), and "confidence" (0..1).',
    "Artist names (JSON array):",
    JSON.stringify(names),
  ].join("\n");

  const text = await generateJson(env, prompt, resultSchema("artist"));
  const out = new Map<string, SlotGuess>();
  for (const row of safeParseArray(text)) {
    const artist = typeof row.artist === "string" ? row.artist : null;
    if (!artist) continue;
    out.set(normalizeArtistName(artist), { slotId: coerceSlot(row.slot), confidence: clampConfidence(row.confidence) });
  }
  return out;
}

export interface MoodTagInput {
  name: string;
  /** Spotify-supplied genres for this artist, if already resolved this
   * request — sent along when present since it costs nothing extra and
   * sharpens the guess; never fetched specially for this call. */
  genres: string[];
}

/** Classifies a batch of artists' mood + energy in one call (Phase 7a —
 * SPEC.md's "Moods and personalities"). Sends only artist names and, when
 * already available, their genre strings — never a raw Spotify payload, per
 * the AI policy at the top of this file. Keyed by normalizeArtistName, same
 * as classifyArtistNames, so callers apply the identical lookup
 * normalization. */
export async function classifyMoods(env: Env, artists: MoodTagInput[]): Promise<Map<string, MoodGuess>> {
  if (artists.length === 0) return new Map();
  // Each input object's own "artist"/"genres" fields (rather than a
  // free-text line) so the model has an unambiguous "artist" value to echo
  // back — classifyArtistNames' plain string-array input doesn't carry a
  // second field alongside the name, so it doesn't have this ambiguity.
  const inputs = artists.map((a) => ({ artist: a.name, genres: a.genres }));
  const prompt = [
    "You are describing the mood/vibe and energy of musical artists, using their name and (when given) genre tags.",
    `Moods (pick exactly one per artist): ${MOOD_IDS.join(", ")}.`,
    "Energy is 0..1 — how high-energy/intense their music generally sounds (0 = very mellow, 1 = very high-energy).",
    "For each artist object below, infer from general knowledge of their music.",
    'Respond with a JSON array with one object per input artist, each with exactly the fields "artist" (copy the input object\'s "artist" field, unchanged), "mood" (one of the moods above), and "energy" (0..1).',
    "Artists (JSON array of {artist, genres}):",
    JSON.stringify(inputs),
  ].join("\n");

  const text = await generateJson(env, prompt, moodResultSchema());
  const out = new Map<string, MoodGuess>();
  for (const row of safeParseArray(text)) {
    const artist = typeof row.artist === "string" ? row.artist : null;
    if (!artist) continue;
    out.set(normalizeArtistName(artist), { mood: coerceMood(row.mood), energy: clampEnergy(row.energy) });
  }
  return out;
}
