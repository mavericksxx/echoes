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
// Phase 10/11 only (see chatWithTools at the bottom of this file): every
// other function here is a single classifier call whose caller checks
// quota/logs the attempt itself (worker/weekly-brief.ts, worker/persona.ts,
// ...). chatWithTools instead runs its own internal multi-step loop (up to
// options.maxSteps + 1 Gemini calls per run — options.maxSteps tool-enabled
// steps, plus one forced final no-tools turn if the last of those is still a
// function call; see chatWithTools' doc comment), so the per-step quota
// check/log has to live inside that loop rather than around one outside call
// — the one place in this file that needs worker/rate-limit.ts at all.
// Generalized in Phase 11 (options.kind/maxSteps/sequentialTools/
// limitedReply/fallbackReply) so worker/village-agent.ts's daily cron agent
// can reuse the exact same loop mechanics as worker/hokage.ts's chat, rather
// than a second hand-rolled copy of this request/response/tool-call dance.
import { geminiQuotaAvailable, logGeminiCall, type GeminiCallKind } from "./rate-limit";

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

/** Unlike clampConfidence (a slot always needs *some* confidence number, so
 * an unusable value defaults to 0), an unusable energy must not silently
 * become a real-looking 0 — that would read as "confirmed very low energy"
 * and get persisted as if it were a real classification. Returns null
 * instead, so classifyMoods below drops the whole row rather than fabricate
 * a fallback guess (SPEC.md's "never persist a fallback guess as if it were
 * Gemini's" — the same rule fallbackSlot documents for slots). */
function clampEnergy(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

/** Coerces a model-returned mood to one of MOOD_IDS, or null if it isn't
 * one — unlike coerceSlot (a slot always needs *some* id so an artist can be
 * placed at all), an unusable mood must not silently become a real-looking
 * MOOD_IDS[0] guess; null lets classifyMoods drop the row instead of
 * persisting a fabricated classification (see clampEnergy's doc comment). */
function coerceMood(value: unknown): MoodId | null {
  return typeof value === "string" && (MOOD_IDS as readonly string[]).includes(value) ? (value as MoodId) : null;
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

/** POSTs one generateContent call with a JSON-schema-constrained response
 * and pulls the text out, checking every step of the documented response
 * shape (https://ai.google.dev/api/generate-content) explicitly rather than
 * silently defaulting through optional chaining — a defaulted `[]`/`""` is
 * exactly how a real shape mismatch (a blocked prompt, a non-STOP
 * finishReason, a missing `parts`) previously surfaced as a generic,
 * undiagnosable failure instead of a specific one. Throws `GeminiRequestError`
 * on any failure — network, non-OK status, or an unexpected/empty response —
 * never lets a raw fetch/parse exception escape this module.
 *
 * Exported (Phase 7b) so worker/persona.ts can reuse this exact request/
 * response handling for its own schema instead of duplicating it — `schema`
 * is typed as a loose `Record<string, unknown>` rather than `ReturnType<typeof resultSchema>`
 * for exactly that reuse; the function only ever JSON.stringifies it. */
export async function generateJson(env: Env, prompt: string, schema: Record<string, unknown>): Promise<string> {
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
 * normalization — with one addition: when the model's echoed "artist"
 * doesn't match anything sent (name drift beyond normalizeArtistName, or a
 * missing/empty field) but the response array has exactly one row per input
 * artist, the row's position recovers it instead of stranding it — see
 * worker/genre-resolution.ts's 24h retry cooldown, the other half of that
 * fix, for what happens when it still can't be matched.
 *
 * A row with an invalid mood or a non-finite energy (coerceMood/clampEnergy
 * both return null for those) is dropped entirely — never a fabricated
 * MOOD_IDS[0]/0 guess persisted as if it were Gemini's. */
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
  const rows = safeParseArray(text);
  const sentNames = new Set(artists.map((a) => normalizeArtistName(a.name)));
  // Only trustworthy when the model returned exactly one row per artist sent
  // — otherwise a row's index doesn't reliably line up with `artists`' own
  // order (a dropped or duplicated row would shift every later one).
  const positionalFallbackOk = rows.length === artists.length;

  const out = new Map<string, MoodGuess>();
  rows.forEach((row, i) => {
    const mood = coerceMood(row.mood);
    const energy = clampEnergy(row.energy);
    if (mood === null || energy === null) return;

    const echoedName = typeof row.artist === "string" ? normalizeArtistName(row.artist) : null;
    const key =
      echoedName && sentNames.has(echoedName)
        ? echoedName
        : positionalFallbackOk
          ? normalizeArtistName(artists[i]!.name)
          : null;
    if (!key) return;
    out.set(key, { mood, energy });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Phase 7c: AI live captions — short in-world lines reacting to the
// currently-playing track, generated on demand by worker/captions.ts (which
// owns the caching/dedupe/quota decisions; this file only ever knows how to
// make the one Gemini call).
// ---------------------------------------------------------------------------

const CAPTION_SCHEMA = { type: "ARRAY", items: { type: "STRING" } };

function safeParseStringArray(text: string): string[] {
  try {
    const data: unknown = JSON.parse(text);
    if (!Array.isArray(data)) return [];
    return data.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
  } catch {
    return [];
  }
}

/** Generates a few short in-world caption lines for one currently-playing
 * track, in the voice of the district it's reacting in. Sends only the
 * minimal derived fields SPEC.md's AI policy allows — artist name, track
 * name, and the reacting slot's representative genre — never a raw Spotify
 * payload, user id, or token. Throws `GeminiRequestError` (network failure,
 * non-OK status, or a response with no usable strings), same as every other
 * function in this file — worker/captions.ts is the one that catches it and
 * degrades to no AI caption. */
export async function generateCaptions(env: Env, artistName: string, trackName: string, genre: string): Promise<string[]> {
  const prompt = [
    `You are writing short, playful in-world lines for a pixel-art village character who represents the "${genre}" music scene, reacting to a song currently playing in their district.`,
    `Song: "${trackName}" by ${artistName}.`,
    "Write 3 short captions (each under 60 characters) in the character's voice — specific to this song/artist, not generic hype.",
    "Respond with a JSON array of exactly 3 strings, nothing else.",
  ].join("\n");

  const text = await generateJson(env, prompt, CAPTION_SCHEMA);
  const lines = safeParseStringArray(text);
  if (lines.length === 0) {
    throw new GeminiRequestError("Gemini caption response had no usable strings");
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Phase 10: "Talk to the Hokage" — Gemini function calling. worker/hokage.ts
// owns the system prompt, the tool declarations, and the D1-backed tool
// implementations (this file never touches D1); chatWithTools here only
// knows how to run the request/response/tool-call loop against Gemini, same
// division of responsibility as generateJson above vs. its callers. Phase 11
// generalizes the loop (see ChatWithToolsOptions) so worker/village-agent.ts
// can reuse it for its own, differently-tuned, write-tool loop — every
// per-kind decision (quota kind, step budget, whether same-step tool calls
// run concurrently or one-at-a-time, and the two canned reply strings) is
// now an option the caller passes in, and this file stays ignorant of both
// callers' actual tools/voice.
//
// Function-calling support on MODEL_ID (gemini-3.5-flash-lite) is *assumed*,
// not independently verified the way the model id itself is (see this
// file's top doc comment) — Google's docs list function calling as a
// Flash-Lite-family capability generally, but this hasn't been checked
// against a dated snapshot the way the model id was. If it turns out this
// model silently ignores `tools` and just answers in plain text, the loop
// below still degrades gracefully (a first-step plain-text reply with no
// functionCall just returns immediately, same as `finalize` at the bottom).
//
// Needs its own response parser (parseChatStep below) rather than reusing
// generateJson: generateJson throws on anything that isn't a single text
// part (by design — every other caller in this file always wants JSON
// text), and a functionCall part has no `text` at all.
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "user" | "model";
  text: string;
}

/** OpenAPI-style function declaration, same hand-written schema convention
 * as resultSchema/moodResultSchema above — `parameters` is typed loosely
 * (like generateJson's `schema` param) since this file only ever forwards it
 * to Gemini verbatim. */
export interface ChatToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ChatOutcome {
  reply: string;
  /** Every tool call made across the whole loop, in order — worker/hokage.ts
   * uses this to know which of its own tool implementations ran, so it can
   * report back which districts they touched (its own concern, not this
   * file's — see this section's doc comment). */
  toolCalls: ChatToolCall[];
  /** True only when a Gemini quota cap cut the conversation short (see the
   * quota check at the top of each loop iteration below) — never set for
   * the unrelated "still calling tools after options.maxSteps" fallback,
   * which is a correctness backstop, not a cost control. */
  limited: boolean;
  /** True only when a real Gemini call failed (network error, bad status,
   * unusable response — never a quota cap, that's `limited` above) and
   * `reply` is therefore `options.fallbackReply` rather than real model
   * text. worker/hokage.ts ignores this (a canned reply is fine either way
   * for a chat answer); worker/village-agent.ts uses it to tell "nothing
   * worth changing today" (a real, successful run) from "the run didn't
   * actually complete" (worth retrying later), which `limited` alone can't
   * distinguish. */
  failed: boolean;
}

/** Per-caller tuning for chatWithTools — see this section's doc comment for
 * why this exists (Phase 11 generalization). */
export interface ChatWithToolsOptions {
  /** Which worker/rate-limit.ts quota/sub-cap this loop's steps draw from. */
  kind: GeminiCallKind;
  /** Tool-enabled steps only — the forced final no-tools turn below (when
   * step `maxSteps` is still a function call) is one more possible Gemini
   * call on top of this, not counted in it. See chatWithTools' doc comment. */
  maxSteps: number;
  /** Run one step's tool calls one at a time (await each before starting the
   * next) instead of concurrently. Needed when a tool's own validation
   * depends on an earlier call in the *same* step having already applied
   * (worker/village-agent.ts's caps, e.g. "at most one festival per slot",
   * only see a prior call's effect once it's actually run). Hokage's
   * tools are read-only with no such ordering dependency, so they default to
   * concurrent (omitted / false). */
  sequentialTools?: boolean;
  /** Returned (with `limited: true`) when a quota cap cuts the conversation
   * short. */
  limitedReply: string;
  /** Returned (with `failed: true`) when a real Gemini call fails outright,
   * or the forced final turn still doesn't produce usable text. */
  fallbackReply: string;
}

// Gemini's Content.role is documented as accepting only "user" or "model" —
// there is no third "function"/"tool" role at this API layer, so a tool's
// result is sent back as a "user" turn carrying a functionResponse part
// instead (matching Gemini's own multi-turn function-calling examples),
// never a role this file's ChatMessage type doesn't already know about.
interface ChatPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  // Gemini 3 models attach this to a functionCall part and require it to be
  // echoed back verbatim on the model turn that follows (the API 400s
  // otherwise) — never generated or inspected here, just round-tripped. See
  // callGeminiStep's rawParts and chatWithTools' push of them below.
  thoughtSignature?: string;
}
interface ChatContent {
  role: "user" | "model";
  parts: ChatPart[];
}
interface ChatCandidate {
  content?: { parts?: ChatPart[] };
  finishReason?: string;
}
interface ChatGenerateContentResponse {
  candidates?: ChatCandidate[];
  promptFeedback?: { blockReason?: string };
}

interface ChatStepResult {
  text: string | null;
  // Every functionCall part this step returned, not just the first — Gemini
  // requires the *next* turn to answer all of them at once (see
  // chatWithTools' single combined functionResponse turn below), so a step
  // that drops any of them would make the following request 400.
  functionCalls: { name: string; args: Record<string, unknown> }[];
  // The candidate's own parts, untouched — chatWithTools pushes these back
  // verbatim as the model turn instead of reconstructing functionCall parts
  // by hand, so any sibling field the API attached (Gemini 3's
  // thoughtSignature in particular — see ChatPart) survives the round trip.
  rawParts: ChatPart[];
}

/** One generateContent call in the chat loop — unlike generateJson, no
 * responseSchema/responseMimeType (those force plain-JSON text output,
 * which is incompatible with letting the model return a functionCall part
 * instead), and `tools` is passed only when the caller still wants function
 * calling available this step (the forced final no-tools turn in
 * chatWithTools below passes `null`). Reuses GeminiRequestError/snippet from
 * this file's generateJson section — same failure-reporting convention,
 * just against this call's own response shape. */
async function callGeminiStep(
  env: Env,
  systemPrompt: string,
  contents: ChatContent[],
  toolDecls: ChatToolDef[] | null,
): Promise<ChatStepResult> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        ...(toolDecls && toolDecls.length > 0 ? { tools: [{ functionDeclarations: toolDecls }] } : {}),
      }),
    });
  } catch (err) {
    throw new GeminiRequestError(`Gemini chat request failed (network error): ${(err as Error).message}`);
  }

  const rawBody = await res.text().catch((err) => {
    throw new GeminiRequestError(`Gemini chat response body could not be read (status ${res.status}): ${(err as Error).message}`);
  });
  if (!res.ok) {
    throw new GeminiRequestError(`Gemini chat request failed with status ${res.status}: ${snippet(rawBody)}`);
  }

  let data: ChatGenerateContentResponse;
  try {
    data = JSON.parse(rawBody) as ChatGenerateContentResponse;
  } catch (err) {
    throw new GeminiRequestError(
      `Gemini chat returned status ${res.status} but unparseable JSON (${(err as Error).message}): ${snippet(rawBody)}`,
    );
  }

  if (data.promptFeedback?.blockReason) {
    throw new GeminiRequestError(`Gemini chat blocked the prompt (${data.promptFeedback.blockReason}, status ${res.status}): ${snippet(rawBody)}`);
  }
  const candidate = data.candidates?.[0];
  if (!candidate) {
    throw new GeminiRequestError(`Gemini chat response had no candidates (status ${res.status}): ${snippet(rawBody)}`);
  }
  if (candidate.finishReason && candidate.finishReason !== "STOP") {
    throw new GeminiRequestError(
      `Gemini chat finished with reason "${candidate.finishReason}" instead of STOP (status ${res.status}): ${snippet(rawBody)}`,
    );
  }

  const parts = candidate.content?.parts ?? [];
  // Every functionCall part in this step, in order — see ChatStepResult's
  // doc comment on why chatWithTools needs all of them, not just the first.
  const callParts = parts.filter((p): p is ChatPart & { functionCall: NonNullable<ChatPart["functionCall"]> } => Boolean(p.functionCall));
  if (callParts.length > 0) {
    return {
      text: null,
      functionCalls: callParts.map((p) => ({ name: p.functionCall.name, args: p.functionCall.args ?? {} })),
      rawParts: parts,
    };
  }
  const text = parts.map((p) => p.text ?? "").join("").trim();
  return { text: text || null, functionCalls: [], rawParts: parts };
}

/** Runs a Gemini function-calling loop: sends `history` (already validated/
 * trimmed by the caller — worker/hokage.ts or worker/village-agent.ts) plus
 * `systemPrompt`, and — for as long as Gemini keeps returning one or more
 * functionCall parts instead of a final answer — calls `runTool` for each
 * one and feeds all the results back in, for at most `options.maxSteps`
 * tool-enabled model steps. If step `options.maxSteps` is *still* a
 * functionCall, one last no-tools turn forces a text answer instead of
 * looping forever — one more possible Gemini call on top of
 * `options.maxSteps`, so a single run can cost up to `options.maxSteps + 1`
 * Gemini calls total (see worker/rate-limit.ts/worker/index.ts's matching
 * cost-control comments for each caller's own numbers). If even that final
 * turn fails, `options.fallbackReply` is returned with `failed: true` — per
 * SPEC.md's Phase 10 task, a question (or a Phase 11 agent run) never ends
 * without *something* to show for it.
 *
 * Each model step is gated by geminiQuotaAvailable(env, ip, options.kind)
 * first (this file's one exception to "callers check quota" — see this
 * section's doc comment) and, if it's actually made, logged with
 * logGeminiCall before the request goes out — same "log the attempt, not
 * just the success" convention worker/weekly-brief.ts's runWeeklyBriefInner
 * already uses. Running out of quota mid-conversation ends the loop
 * immediately with `limited: true` and `options.limitedReply`, never a
 * partial/broken answer. */
export async function chatWithTools(
  env: Env,
  ip: string,
  systemPrompt: string,
  history: ChatMessage[],
  tools: ChatToolDef[],
  runTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  options: ChatWithToolsOptions,
): Promise<ChatOutcome> {
  const contents: ChatContent[] = history.map((m) => ({ role: m.role, parts: [{ text: m.text }] }));
  const toolCalls: ChatToolCall[] = [];

  for (let step = 0; step < options.maxSteps; step++) {
    if (!(await geminiQuotaAvailable(env, ip, options.kind))) {
      return { reply: options.limitedReply, toolCalls, limited: true, failed: false };
    }

    let result: ChatStepResult;
    try {
      await logGeminiCall(env, ip, options.kind);
      result = await callGeminiStep(env, systemPrompt, contents, tools);
    } catch (err) {
      console.error(`[gemini] ${options.kind} step failed:`, (err as Error).message);
      return { reply: options.fallbackReply, toolCalls, limited: false, failed: true };
    }

    if (result.functionCalls.length === 0) {
      return result.text
        ? { reply: result.text, toolCalls, limited: false, failed: false }
        : { reply: options.fallbackReply, toolCalls, limited: false, failed: true };
    }

    // Echo the candidate's parts back verbatim (not hand-rebuilt
    // `functionCall` parts) — Gemini 3 models attach a `thoughtSignature` to
    // each functionCall part and require it to be echoed back on the next
    // turn, or the API 400s. Only `name`/`args` (below) are actually acted
    // on; `rawParts` is what gets sent back to Gemini.
    contents.push({ role: "model", parts: result.rawParts });

    // Gemini requires the turn that follows a model turn with N functionCall
    // parts to contain exactly N functionResponse parts, all in one turn —
    // never fewer, and never split across multiple turns. So every call this
    // step made has to be run and answered together, whether run
    // concurrently or (options.sequentialTools) one at a time, before the one
    // combined "user" turn below is pushed.
    const runOne = async ({ name, args }: { name: string; args: Record<string, unknown> }) => {
      try {
        return { name, output: await runTool(name, args) };
      } catch (err) {
        // A tool implementation failing (a D1 hiccup, an unrecognized name)
        // is reported back to the model as a functionResponse, not thrown
        // out of the loop — the model can apologize/adjust or try a
        // different tool instead of the whole run dying on one bad call.
        return { name, output: { error: `Tool "${name}" failed: ${(err as Error).message}` } };
      }
    };
    const toolResults = options.sequentialTools
      ? await (async () => {
          const out: { name: string; output: unknown }[] = [];
          for (const call of result.functionCalls) out.push(await runOne(call));
          return out;
        })()
      : await Promise.all(result.functionCalls.map(runOne));

    toolCalls.push(...result.functionCalls);
    contents.push({
      role: "user",
      parts: toolResults.map(({ name, output }) => ({ functionResponse: { name, response: { result: output } } })),
    });
  }

  // Still calling tools after options.maxSteps — one forced final turn with
  // no `tools` at all, so Gemini has nothing left to call and must answer in
  // text (see this function's doc comment).
  if (await geminiQuotaAvailable(env, ip, options.kind)) {
    try {
      await logGeminiCall(env, ip, options.kind);
      const result = await callGeminiStep(env, systemPrompt, contents, null);
      if (result.text) return { reply: result.text, toolCalls, limited: false, failed: false };
    } catch (err) {
      console.error(`[gemini] ${options.kind} final step failed:`, (err as Error).message);
    }
  }
  return { reply: options.fallbackReply, toolCalls, limited: false, failed: true };
}
