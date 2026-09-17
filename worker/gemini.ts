// Gemini Flash-Lite genre/artist classification. The only thing in this
// Worker allowed to call Gemini — everything else goes through
// worker/genre-resolution.ts, which decides *whether* a call is even needed
// (cache first, quota check second — see worker/rate-limit.ts).
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

import { GoogleGenAI, Type } from "@google/genai";
import type { Env } from "./index";
import { SLOTS } from "../data/loader";

const MODEL_ID = "gemini-3.5-flash-lite";

const SLOT_IDS = SLOTS.map((s) => s.district.id);
const SLOT_GENRE_LINES = SLOTS.map((s) => `- "${s.district.id}": ${s.district.genre}`).join("\n");

export interface SlotGuess {
  slotId: string;
  confidence: number;
}

function clampConfidence(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(1, n));
}

/** Coerces a model-returned slot id to one of the 17 known ids — a
 * hallucinated/misspelled id falls back to the first slot with confidence
 * left untouched (the caller already has to treat every Gemini guess as
 * fallible; this just stops an invalid id from reaching D1/the client). */
function coerceSlot(id: unknown): string {
  return typeof id === "string" && SLOT_IDS.includes(id) ? id : SLOT_IDS[0]!;
}

function resultSchema(keyName: "genre" | "artist") {
  return {
    type: Type.ARRAY,
    items: {
      type: Type.OBJECT,
      properties: {
        [keyName]: { type: Type.STRING },
        slot: { type: Type.STRING, enum: SLOT_IDS },
        confidence: {
          type: Type.NUMBER,
          description: "0..1 — how confident this mapping is. Use a value below 0.4 for a guess.",
        },
      },
      required: [keyName, "slot", "confidence"],
    },
  };
}

function safeParseArray(text: string | undefined): Record<string, unknown>[] {
  if (!text) return [];
  try {
    const data: unknown = JSON.parse(text);
    return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  } catch {
    return [];
  }
}

/** Classifies a batch of raw Spotify genre/tag strings into the 17 roster
 * slots in one call. */
export async function classifyGenres(env: Env, genres: string[]): Promise<Map<string, SlotGuess>> {
  if (genres.length === 0) return new Map();
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const prompt = [
    "You are sorting music genre/tag strings into a fixed set of 17 buckets.",
    "Buckets (id: representative genre):",
    SLOT_GENRE_LINES,
    "",
    "For each genre string below, pick the single closest bucket id.",
    "If a genre doesn't fit any bucket well, pick the nearest one anyway and give it a low confidence (below 0.4).",
    "Genre strings (JSON array):",
    JSON.stringify(genres),
  ].join("\n");

  const response = await ai.models.generateContent({
    model: MODEL_ID,
    contents: prompt,
    config: { responseMimeType: "application/json", responseSchema: resultSchema("genre") },
  });

  const out = new Map<string, SlotGuess>();
  for (const row of safeParseArray(response.text)) {
    const genre = typeof row.genre === "string" ? row.genre : null;
    if (!genre) continue;
    out.set(genre, { slotId: coerceSlot(row.slot), confidence: clampConfidence(row.confidence) });
  }
  return out;
}

/** Classifies a batch of artist names directly into the 17 roster slots —
 * used only when Spotify returned no genres at all for that artist (the
 * common case for this account; see SPEC.md's "Reality check"). Sends only
 * artist names. */
export async function classifyArtistNames(env: Env, names: string[]): Promise<Map<string, SlotGuess>> {
  if (names.length === 0) return new Map();
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const prompt = [
    "You are placing musical artists into a fixed set of 17 genre buckets, using only their name — no other data is available.",
    "Buckets (id: representative genre):",
    SLOT_GENRE_LINES,
    "",
    "For each artist name below, infer their most likely genre from general knowledge and pick the single closest bucket id.",
    "If you don't recognize the artist, pick your best guess anyway and give it a low confidence (below 0.4).",
    "Artist names (JSON array):",
    JSON.stringify(names),
  ].join("\n");

  const response = await ai.models.generateContent({
    model: MODEL_ID,
    contents: prompt,
    config: { responseMimeType: "application/json", responseSchema: resultSchema("artist") },
  });

  const out = new Map<string, SlotGuess>();
  for (const row of safeParseArray(response.text)) {
    const artist = typeof row.artist === "string" ? row.artist : null;
    if (!artist) continue;
    out.set(artist, { slotId: coerceSlot(row.slot), confidence: clampConfidence(row.confidence) });
  }
  return out;
}
