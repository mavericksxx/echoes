// Per-slot personality + dialogue lines (SPEC.md's Phase 7 — "Per-slot
// personality + dialogue lines flavored by your top artists (cached); shown
// in the info card"). Cached in D1 (migrations/0007_slot_persona.sql), keyed
// by slot id rather than artist — this is flavor text for the genre
// character, not a per-artist fact.
//
// Regeneration rule: a slot's row is only eligible for a fresh Gemini call
// when its top-artist fingerprint (see fingerprint() below — built from the
// range-independent long_term baseline, not whichever era a visitor happens
// to be viewing; see worker/village.ts's persona stage) no longer matches
// the row's, AND at least REGEN_INTERVAL_MS has passed since the row was
// last *touched* — either a real generation or a failed attempt (see below)
// — both conditions, not either. A slot with no cached row yet always needs
// generation regardless of timing (there's nothing to rate-limit against).
// This caps Gemini calls to once/day/slot even if a listener's top artists
// reshuffle on every /api/village build, while still keeping every slot's
// row from going stale forever.
//
// Every slot needing generation is batched into a single Gemini call (same
// pattern as worker/gemini.ts's classifyGenres/classifyArtistNames), gated
// by the same daily quota (worker/rate-limit.ts's geminiQuotaAvailable) —
// this endpoint's overall cap on Gemini calls is shared with genre
// resolution, not a separate budget. On any failure (quota exhausted,
// network/HTTP error, a slot missing from the response) that slot falls back
// to its existing cached row if one exists, else null — worker/village.ts
// treats null as "no persona yet" and the frontend renders around it (never
// a 500, per SPEC.md's AI policy). A slot Gemini could never usefully
// classify (or a systemic outage) still gets its row's timestamp bumped on
// the attempt (see EMPTY_PERSONA below) — otherwise it would get rebatched
// into every cache-miss build instead of at most once a day, quietly
// burning the shared quota genre resolution depends on.
//
// Prompt carries only static game data (slot id, character name, genre) plus
// artist *names* — never a raw Spotify payload, user id, or token, matching
// worker/gemini.ts's existing AI policy.

import type { Env } from "./index";
import { generateJson } from "./gemini";
import { geminiQuotaAvailable, logGeminiCall } from "./rate-limit";
import { SLOTS } from "../data/loader";

const SLOT_IDS = SLOTS.map((s) => s.district.id);
const SLOT_BY_ID = new Map(SLOTS.map((s) => [s.district.id, s]));

const REGEN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_DIALOGUE_LINES = 6;
const MAX_PERSONALITY_CHARS = 240;
const MAX_DIALOGUE_CHARS = 140;

export interface SlotPersona {
  personality: string;
  dialogue: string[];
}

/** Written to D1 (never returned to a caller) to mark "an attempt was made
 * at this fingerprint and produced nothing usable" — see the doc comment on
 * its one use site below. rowToPersona() reads it back as `null`. */
const EMPTY_PERSONA: SlotPersona = { personality: "", dialogue: [] };

/** What worker/village.ts asks for: a slot id plus the (already-resolved)
 * names of its current top artists, highest-ranked first. An empty
 * `topArtistNames` means the slot has no real residents yet — never sent to
 * Gemini, always resolves to `null` (see resolveSlotPersonasInner). */
export interface PersonaInput {
  slotId: string;
  topArtistNames: string[];
}

/** Stable fingerprint of a slot's current top artists — a plain lowercased,
 * pipe-joined string rather than a hash, since it's only ever compared for
 * equality against the previous row and never needs to be short. */
function fingerprint(names: string[]): string {
  return names.map((n) => n.trim().toLowerCase()).join("|");
}

function personaSchema() {
  return {
    type: "ARRAY",
    items: {
      type: "OBJECT",
      properties: {
        slot: { type: "STRING", enum: SLOT_IDS },
        personality: {
          type: "STRING",
          description: "A short in-character personality blurb, 1-2 sentences.",
        },
        dialogue: {
          type: "ARRAY",
          items: { type: "STRING" },
          description: "4 to 6 short lines (under 140 characters each) this character might say about their music taste.",
        },
      },
      required: ["slot", "personality", "dialogue"],
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

/** Cleans one Gemini-returned persona: clamps the personality blurb's
 * length, trims/dedupes/caps the dialogue lines. Returns `null` if what's
 * left isn't usable (no personality text or no dialogue lines at all) so the
 * caller falls back to a cached row/`null` instead of caching junk. */
function sanitizePersona(row: Record<string, unknown>): SlotPersona | null {
  const personality = typeof row.personality === "string" ? row.personality.trim().slice(0, MAX_PERSONALITY_CHARS) : "";
  const rawDialogue = Array.isArray(row.dialogue) ? row.dialogue : [];
  const dialogue = rawDialogue
    .filter((line): line is string => typeof line === "string" && line.trim().length > 0)
    .map((line) => line.trim().slice(0, MAX_DIALOGUE_CHARS))
    .slice(0, MAX_DIALOGUE_LINES);
  if (!personality || dialogue.length === 0) return null;
  return { personality, dialogue };
}

interface PersonaRow {
  slot_id: string;
  personality: string;
  dialogue: string; // JSON-encoded string[]
  artist_fingerprint: string;
  generated_at: string;
}

/** A cached row can be a real persona, or a placeholder written after an
 * attempt that produced nothing usable (see resolveSlotPersonasInner's final
 * loop) — an empty `personality` marks the latter, which this resolves to
 * `null` rather than an empty-looking persona reaching the frontend. */
function rowToPersona(row: PersonaRow): SlotPersona | null {
  if (!row.personality) return null;
  let dialogue: string[];
  try {
    const parsed: unknown = JSON.parse(row.dialogue);
    dialogue = Array.isArray(parsed) ? parsed.filter((l): l is string => typeof l === "string") : [];
  } catch {
    dialogue = [];
  }
  if (dialogue.length === 0) return null;
  return { personality: row.personality, dialogue };
}

async function fetchCachedPersonas(env: Env, slotIds: string[]): Promise<Map<string, PersonaRow>> {
  if (slotIds.length === 0) return new Map();
  const placeholders = slotIds.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT slot_id, personality, dialogue, artist_fingerprint, generated_at FROM slot_persona WHERE slot_id IN (${placeholders})`,
  )
    .bind(...slotIds)
    .all<PersonaRow>();
  return new Map(results.map((r) => [r.slot_id, r]));
}

async function upsertPersona(env: Env, slotId: string, persona: SlotPersona, fp: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO slot_persona (slot_id, personality, dialogue, artist_fingerprint, generated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(slot_id) DO UPDATE SET
       personality = excluded.personality,
       dialogue = excluded.dialogue,
       artist_fingerprint = excluded.artist_fingerprint,
       generated_at = excluded.generated_at`,
  )
    .bind(slotId, persona.personality, JSON.stringify(persona.dialogue), fp, new Date().toISOString())
    .run();
}

function buildPrompt(inputs: PersonaInput[]): string {
  const lines = inputs.map((input) => {
    const slot = SLOT_BY_ID.get(input.slotId);
    const label = slot ? `${slot.character.name}, ${slot.district.genre}` : input.slotId;
    // Artist names JSON-encoded, not comma-joined — same reasoning as
    // worker/gemini.ts's classifyGenres/classifyArtistNames prompts: robust
    // to a name that itself contains a comma or quote.
    return `- "${input.slotId}" (${label}): top artists are ${JSON.stringify(input.topArtistNames)}`;
  });
  return [
    "You are writing short flavor text for characters in a pixel-art village game — one character represents one music genre district.",
    "Each character's personality and dialogue should feel inspired by the real artists their district's listener plays most, without ever naming Spotify, any platform, or the listener.",
    "For each district below, write a short in-character personality blurb (1-2 sentences, playful, game-appropriate) and 4 to 6 short dialogue lines (each under 140 characters) the character might say about the music they love.",
    "Districts (id (character, genre): top artists):",
    lines.join("\n"),
    'Respond with a JSON array with one object per district, each with exactly the fields "slot" (the id above, unchanged), "personality" (string), and "dialogue" (array of 4-6 strings).',
  ].join("\n");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function resolveSlotPersonasInner(
  env: Env,
  ip: string,
  inputs: PersonaInput[],
): Promise<Map<string, SlotPersona | null>> {
  const result = new Map<string, SlotPersona | null>();
  const withArtists: PersonaInput[] = [];
  for (const input of inputs) {
    if (input.topArtistNames.length === 0) result.set(input.slotId, null);
    else withArtists.push(input);
  }
  if (withArtists.length === 0) return result;

  const cached = await fetchCachedPersonas(
    env,
    withArtists.map((i) => i.slotId),
  );

  const needsGeneration: { input: PersonaInput; fp: string }[] = [];
  for (const input of withArtists) {
    const fp = fingerprint(input.topArtistNames);
    const row = cached.get(input.slotId);
    if (!row) {
      needsGeneration.push({ input, fp });
      continue;
    }
    const fingerprintChanged = row.artist_fingerprint !== fp;
    const ageMs = Date.now() - Date.parse(row.generated_at);
    if (!fingerprintChanged || ageMs < REGEN_INTERVAL_MS) {
      // Either nothing to regenerate, or there is but today's once/day cap
      // isn't up yet — serve the (possibly stale, possibly empty — see the
      // end of this function) cached row either way.
      result.set(input.slotId, rowToPersona(row));
    } else {
      needsGeneration.push({ input, fp });
    }
  }

  if (needsGeneration.length === 0) return result;

  if (!(await geminiQuotaAvailable(env, ip))) {
    // Quota exhausted — fall back to each slot's existing cached row (stale
    // fingerprint and all) rather than nothing, per this file's doc comment.
    for (const { input } of needsGeneration) {
      const row = cached.get(input.slotId);
      result.set(input.slotId, row ? rowToPersona(row) : null);
    }
    return result;
  }

  let guesses: Map<string, SlotPersona> | null = null;
  try {
    await logGeminiCall(env, ip, "persona");
    const text = await generateJson(
      env,
      buildPrompt(needsGeneration.map((n) => n.input)),
      personaSchema(),
    );
    guesses = new Map<string, SlotPersona>();
    for (const row of safeParseArray(text)) {
      const slotId = typeof row.slot === "string" && SLOT_IDS.includes(row.slot) ? row.slot : null;
      if (!slotId) continue;
      const persona = sanitizePersona(row);
      if (persona) guesses.set(slotId, persona);
    }
  } catch (err) {
    console.error("[persona] gemini call failed:", errorMessage(err));
  }

  for (const { input, fp } of needsGeneration) {
    const fresh = guesses?.get(input.slotId);
    if (fresh) {
      result.set(input.slotId, fresh);
      await upsertPersona(env, input.slotId, fresh, fp);
      continue;
    }
    // The whole call failed, or this one slot was missing/unusable in the
    // response — serve whatever was cached before (if anything), but still
    // record that an attempt was made at this fingerprint. Without this, a
    // slot Gemini can't or won't produce a usable persona for would get
    // rebatched into every village cache-miss (as often as every 30 min)
    // forever instead of at most once a day, silently eating the Gemini
    // quota genre resolution depends on (worker/rate-limit.ts's shared daily
    // caps). EMPTY_PERSONA is never surfaced — rowToPersona() reads an empty
    // `personality` back as `null` — it only exists to carry the attempted
    // fingerprint + timestamp.
    const row = cached.get(input.slotId);
    const persona = row ? rowToPersona(row) : null;
    result.set(input.slotId, persona);
    await upsertPersona(env, input.slotId, persona ?? EMPTY_PERSONA, fp);
  }

  return result;
}

/** Resolves every slot in `inputs` to its persona (or `null`), reading/
 * writing the D1 cache described above. `ip` is only used for the shared
 * Gemini daily-cap bookkeeping (worker/rate-limit.ts) — never sent to
 * Gemini itself.
 *
 * Guaranteed never to throw — an unexpected failure (e.g. a D1 hiccup)
 * degrades every requested slot to `null` rather than failing the whole
 * /api/village response (see worker/village.ts's own try/catch around this,
 * which is defense-in-depth on top of this one). */
export async function resolveSlotPersonas(
  env: Env,
  ip: string,
  inputs: PersonaInput[],
): Promise<Map<string, SlotPersona | null>> {
  try {
    return await resolveSlotPersonasInner(env, ip, inputs);
  } catch (err) {
    console.error("[persona] unexpected failure, no personas this response:", errorMessage(err));
    const result = new Map<string, SlotPersona | null>();
    for (const input of inputs) result.set(input.slotId, null);
    return result;
  }
}
