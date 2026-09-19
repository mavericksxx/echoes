// Phase 11: "the village evolves itself" (SPEC.md — a daily cron agent with
// tools set_district_activity/set_weather/start_festival/set_time_of_day/
// send_visitor/set_character_mood; validated diffs stored in agent_event).
// shared/world.ts is the contract both this file and the frontend (once
// built) agree on; migrations/0010_village_agent.sql is where this file
// persists. Same division of labor as worker/hokage.ts vs worker/gemini.ts:
// this file owns the system prompt, tool declarations, tool implementations
// (validation + the actual WorldState writes), and the D1 read/write; Phase
// 11's generalized worker/gemini.ts's chatWithTools owns the request/
// response/tool-call loop mechanics.
//
// Unlike Hokage's read-only tools, every tool here *writes* — so the model
// gets no read tools at all; every fact it needs (recent listening,
// current world state) is handed to it up front in the one prompt built by
// buildPrompt below, and every write is validated server-side before it's
// ever applied (see runTool/TOOL_IMPLS) — a rejected call gets an error back
// as its functionResponse and is never applied or logged, same "never trust
// the model's own claim" posture as every other Gemini-backed feature here.
//
// Gated to run at most once per owner-local day, first cron tick at/after
// RUN_HOUR_OWNER_LOCAL, with the same 'ready'/'pending' retry convention
// worker/weekly-brief.ts already established (see runVillageAgent's doc
// comment). Rides worker/index.ts's existing scheduled() tick, after the
// weekly brief.

import type { Env } from "./index";
import { chatWithTools, normalizeArtistName, type ChatMessage, type ChatToolDef } from "./gemini";
import { SLOTS } from "../data/loader";
import type { ActivityLevel } from "../shared/activity";
import { MOOD_IDS, type MoodId } from "../shared/mood";
import {
  EMPTY_WORLD,
  WEATHER_IDS,
  TIME_OF_DAY_IDS,
  MAX_ACCEPTED_CALLS_PER_RUN,
  MAX_FESTIVALS,
  DEFAULT_DURATIONS_MS,
  sanitizeLabel,
  effectiveWorld,
  type WorldState,
  type EffectiveWorld,
  type WorldResponse,
  type Timed,
  type WeatherId,
  type TimeOfDayId,
} from "../shared/world";

const SLOT_IDS = SLOTS.map((s) => s.district.id);
const SLOT_BY_ID = new Map(SLOTS.map((s) => [s.district.id, s]));
// shared/activity.ts only exports the ActivityLevel *type* (no runtime
// roster, unlike shared/mood.ts's MOOD_IDS or shared/world.ts's
// WEATHER_IDS/TIME_OF_DAY_IDS) — this is Phase 11's own copy of that same
// fixed 4-value set, needed here to validate a model-returned level against
// something real.
const ACTIVITY_LEVELS: readonly ActivityLevel[] = ["dormant", "quiet", "active", "festival"];

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function slotGenre(slotId: string): string {
  return SLOT_BY_ID.get(slotId)?.district.genre ?? slotId;
}

// ---------------------------------------------------------------------------
// Listening summary — the model's only window into real listening (SPEC.md's
// AI policy: derived fields only, never a raw Spotify payload). Two rolling
// windows (last 24h, last 7d), each with per-district plays+dominant mood
// and a top-artists list. Unlike worker/weekly-brief.ts's owner-local
// calendar-week math, these are plain rolling windows off `played_at` — no
// owner-local day bucketing (and so no fetch safety margin) needed.
// ---------------------------------------------------------------------------
const SUMMARY_WINDOW_DAYS = 7;
const TOP_ARTISTS_PER_PERIOD = 8;

interface PeriodArtist {
  artistId: string;
  name: string;
  slotId: string | null;
  mood: MoodId | null;
  plays: number;
}
interface PeriodSlot {
  slotId: string;
  plays: number;
  dominantMood: MoodId | null;
}
interface Period {
  totalPlays: number;
  slots: PeriodSlot[];
  artists: PeriodArtist[];
}
interface ListeningSummary {
  day: Period;
  week: Period;
  /** Every artist named in either period's `artists` list above, keyed by
   * normalizeArtistName — the closed universe send_visitor's artist_name is
   * validated against (see toolSendVisitor): only an artist actually shown
   * to the model in this prompt, never an arbitrary D1 lookup. */
  validArtists: Map<string, PeriodArtist>;
}

function coerceMoodId(mood: string | null): MoodId | null {
  return mood && (MOOD_IDS as readonly string[]).includes(mood) ? (mood as MoodId) : null;
}

function summarizePeriod(rows: { artist_id: string; name: string; slot_id: string | null; mood: string | null }[]): Period {
  const bySlot = new Map<string, { plays: number; moodCounts: Map<string, number> }>();
  const byArtist = new Map<string, PeriodArtist>();

  for (const r of rows) {
    if (r.slot_id) {
      const s = bySlot.get(r.slot_id) ?? { plays: 0, moodCounts: new Map<string, number>() };
      s.plays++;
      if (r.mood) s.moodCounts.set(r.mood, (s.moodCounts.get(r.mood) ?? 0) + 1);
      bySlot.set(r.slot_id, s);
    }
    const existing = byArtist.get(r.artist_id);
    if (existing) existing.plays++;
    else byArtist.set(r.artist_id, { artistId: r.artist_id, name: r.name, slotId: r.slot_id, mood: coerceMoodId(r.mood), plays: 1 });
  }

  const slots: PeriodSlot[] = Array.from(bySlot.entries())
    .map(([slotId, s]) => {
      let dominantMood: MoodId | null = null;
      let best = 0;
      for (const [mood, count] of s.moodCounts) {
        if (count > best) {
          best = count;
          dominantMood = mood as MoodId;
        }
      }
      return { slotId, plays: s.plays, dominantMood };
    })
    .sort((a, b) => b.plays - a.plays);

  const artists = Array.from(byArtist.values())
    .sort((a, b) => b.plays - a.plays)
    .slice(0, TOP_ARTISTS_PER_PERIOD);

  return { totalPlays: rows.length, slots, artists };
}

async function buildListeningSummary(env: Env, nowMs: number): Promise<ListeningSummary> {
  const fromMs = nowMs - SUMMARY_WINDOW_DAYS * DAY_MS;
  const { results } = await env.DB.prepare(
    `SELECT pe.played_at AS played_at, pe.primary_artist_id AS artist_id, ac.name AS name, ac.slot_id AS slot_id, ac.mood AS mood
     FROM play_event pe
     JOIN artist_cache ac ON ac.artist_id = pe.primary_artist_id
     WHERE pe.played_at >= ?`,
  )
    .bind(fromMs)
    .all<{ played_at: number; artist_id: string; name: string; slot_id: string | null; mood: string | null }>();

  const dayFromMs = nowMs - DAY_MS;
  const day = summarizePeriod(results.filter((r) => r.played_at >= dayFromMs));
  const week = summarizePeriod(results);

  const validArtists = new Map<string, PeriodArtist>();
  for (const a of [...day.artists, ...week.artists]) validArtists.set(normalizeArtistName(a.name), a);

  return { day, week, validArtists };
}

function periodLines(period: Period): string {
  const slotLines =
    period.slots
      .map((s) => `- "${s.slotId}" (${slotGenre(s.slotId)}): ${s.plays} plays${s.dominantMood ? `, mostly ${s.dominantMood}` : ""}`)
      .join("\n") || "(no plays)";
  const artistLines =
    period.artists
      .map((a) => `- ${a.name} (${a.slotId ? slotGenre(a.slotId) : "unplaced"}${a.mood ? `, ${a.mood}` : ""}): ${a.plays} plays`)
      .join("\n") || "(none)";
  return `Districts:\n${slotLines}\nTop artists:\n${artistLines}`;
}

function currentStateLines(effective: EffectiveWorld): string {
  const lines: string[] = [];
  lines.push(effective.weather ? `Weather: ${effective.weather.value} (until ${effective.weather.expiresOn})` : "Weather: no override (cycles normally)");
  lines.push(
    effective.timeOfDay
      ? `Time-of-day override: ${effective.timeOfDay.value} (until ${effective.timeOfDay.expiresOn})`
      : "Time-of-day override: none (follows the real clock)",
  );
  lines.push(
    effective.festivals.length > 0
      ? `Active festivals: ${effective.festivals.map((f) => `"${f.value.name}" in ${f.value.slotId} (until ${f.expiresOn})`).join("; ")}`
      : "Active festivals: none",
  );
  lines.push(
    effective.visitors.length > 0
      ? `Active visitors: ${effective.visitors.map((v) => `${v.value.artistId} in ${v.value.slotId} (until ${v.expiresOn})`).join("; ")}`
      : "Active visitors: none",
  );
  const activityEntries = Object.entries(effective.activity);
  lines.push(
    activityEntries.length > 0
      ? `Activity overrides: ${activityEntries.map(([slot, t]) => `${slot}=${t.value} (until ${t.expiresOn})`).join("; ")}`
      : "Activity overrides: none",
  );
  const moodEntries = Object.entries(effective.moods);
  lines.push(
    moodEntries.length > 0
      ? `Mood overrides: ${moodEntries.map(([slot, t]) => `${slot}=${t.value} (until ${t.expiresOn})`).join("; ")}`
      : "Mood overrides: none",
  );
  return lines.join("\n");
}

function buildPrompt(listening: ListeningSummary, effective: EffectiveWorld, runDate: string): string {
  return [
    `Today's owner-local date: ${runDate}.`,
    "",
    "Last 24 hours of real listening:",
    periodLines(listening.day),
    "",
    "Last 7 days of real listening:",
    periodLines(listening.week),
    "",
    "The village's current state:",
    currentStateLines(effective),
  ].join("\n");
}

const SYSTEM_PROMPT = [
  "You are the Hokage, quietly shaping the pixel-art ninja village overnight based on how its owner has actually been listening to music — every genre is one of the village's districts, each led by a character from the show.",
  "You are given a summary of real listening over the last day and the last week (per district, with each district's dominant mood, plus top artists), and the village's current state (weather, time-of-day override, active festivals, visitors, and any per-district activity/mood overrides).",
  "Use your tools to make the village reflect that listening — but only when there is something genuinely worth reflecting. A quiet day, or a day that looks like every other recent one, is a perfectly good reason to change nothing at all.",
  "Avoid daily thrash: don't re-set something that's already active unless the listening genuinely justifies extending or changing it, and prefer a single well-chosen district-specific change over several small ones.",
  "Every tool call needs a short, honest reason tying it to the listening described above — never invent a reason, an artist, or a fact not in the summary.",
  "send_visitor only accepts an artist name copied exactly from the summary above — never guess, misspell, or reuse a name from outside it.",
  "Never say \"Spotify\", \"app\", \"database\", or anything that breaks the illusion.",
  "When you are done — even if you made no changes at all — reply with one short in-character sentence summarizing what you did, or why you left the village as it was.",
].join("\n");

// ---------------------------------------------------------------------------
// Tools — every one a write, validated here before it's ever applied to the
// in-memory WorldState (see AgentCtx/runTool below). A rejected call returns
// a short error string to the model as its functionResponse and is never
// applied or persisted.
// ---------------------------------------------------------------------------
const REASON_MAX_CHARS = 200;
const FESTIVAL_NAME_MAX_CHARS = 60;

interface AgentCtx {
  env: Env;
  runDate: string;
  nowMs: number;
  nowIso: string;
  state: WorldState;
  listening: ListeningSummary;
  accepted: number;
  rejected: number;
}

interface ToolAccept {
  ok: true;
  reason: string;
  before: unknown;
  after: unknown;
  message: string;
}
interface ToolReject {
  ok: false;
  error: string;
}
type ToolOutcome = ToolAccept | ToolReject;

function reject(error: string): ToolReject {
  return { ok: false, error };
}

function strArg(args: Record<string, unknown>, key: string): string {
  const raw = args[key];
  return typeof raw === "string" ? raw.trim() : "";
}

function numArg(args: Record<string, unknown>, key: string): number | null {
  const raw = args[key];
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

function readReason(args: Record<string, unknown>): string | null {
  return sanitizeLabel(strArg(args, "reason"), REASON_MAX_CHARS) || null;
}

/** Clamps an optional `durationHours` arg into `[rangeMs[0], rangeMs[1]]`,
 * defaulting to the shorter end (least disruptive) when omitted/invalid —
 * see DEFAULT_DURATIONS_MS's own doc comment for why activity/mood/festival
 * are ranges the agent picks within, not fixed values. */
function clampRangeHours(args: Record<string, unknown>, key: string, rangeMs: readonly [number, number]): number {
  const hours = numArg(args, key);
  if (hours === null) return rangeMs[0];
  return Math.max(rangeMs[0], Math.min(rangeMs[1], hours * HOUR_MS));
}

/** Clamps an optional `hours` arg into `(0, maxMs]`, defaulting to `maxMs`
 * when omitted/invalid — set_time_of_day's own duration ("hours <= 6"): the
 * agent may set less, never more, than DEFAULT_DURATIONS_MS.timeOfDay. */
function clampMaxHours(args: Record<string, unknown>, key: string, maxMs: number): number {
  const hours = numArg(args, key);
  if (hours === null || hours <= 0) return maxMs;
  return Math.max(HOUR_MS, Math.min(maxMs, hours * HOUR_MS));
}

/** start_festival's own duration param — an integer day count (1-3), not a
 * generic hours value, matching DEFAULT_DURATIONS_MS.festival's bounds
 * exactly. Defaults to the middle of the range when omitted/invalid. */
function clampFestivalDays(args: Record<string, unknown>): number {
  const days = numArg(args, "days");
  if (days === null) return 2;
  return Math.round(Math.max(1, Math.min(3, days)));
}

async function toolSetDistrictActivity(ctx: AgentCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const slot = strArg(args, "slot");
  if (!SLOT_IDS.includes(slot)) return reject(`"${slot}" isn't one of the village's districts.`);
  const level = strArg(args, "level");
  if (!ACTIVITY_LEVELS.includes(level as ActivityLevel)) return reject(`"${level}" isn't a valid activity level.`);
  const reason = readReason(args);
  if (!reason) return reject("A reason is required.");

  const durationMs = clampRangeHours(args, "durationHours", DEFAULT_DURATIONS_MS.activity);
  const before = ctx.state.activity[slot] ?? null;
  const after: Timed<ActivityLevel> = { value: level as ActivityLevel, setOn: ctx.nowIso, expiresOn: new Date(ctx.nowMs + durationMs).toISOString() };
  ctx.state.activity[slot] = after;
  return { ok: true, reason, before, after, message: `${slot}'s activity is now shown as ${level}.` };
}

async function toolSetCharacterMood(ctx: AgentCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const slot = strArg(args, "slot");
  if (!SLOT_IDS.includes(slot)) return reject(`"${slot}" isn't one of the village's districts.`);
  const mood = strArg(args, "mood");
  if (!(MOOD_IDS as readonly string[]).includes(mood)) return reject(`"${mood}" isn't a valid mood.`);
  const reason = readReason(args);
  if (!reason) return reject("A reason is required.");

  const durationMs = clampRangeHours(args, "durationHours", DEFAULT_DURATIONS_MS.mood);
  const before = ctx.state.moods[slot] ?? null;
  const after: Timed<MoodId> = { value: mood as MoodId, setOn: ctx.nowIso, expiresOn: new Date(ctx.nowMs + durationMs).toISOString() };
  ctx.state.moods[slot] = after;
  return { ok: true, reason, before, after, message: `${slot}'s mood is now shown as ${mood}.` };
}

async function toolSetWeather(ctx: AgentCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const weather = strArg(args, "weather");
  if (!(WEATHER_IDS as readonly string[]).includes(weather)) return reject(`"${weather}" isn't a valid weather.`);
  const reason = readReason(args);
  if (!reason) return reject("A reason is required.");

  const before = ctx.state.weather ?? null;
  const after: Timed<WeatherId> = {
    value: weather as WeatherId,
    setOn: ctx.nowIso,
    expiresOn: new Date(ctx.nowMs + DEFAULT_DURATIONS_MS.weather).toISOString(),
  };
  ctx.state.weather = after;
  return { ok: true, reason, before, after, message: `The village's weather is now ${weather}.` };
}

async function toolSetTimeOfDay(ctx: AgentCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const timeOfDay = strArg(args, "timeOfDay");
  if (!(TIME_OF_DAY_IDS as readonly string[]).includes(timeOfDay)) return reject(`"${timeOfDay}" isn't a valid time of day.`);
  const reason = readReason(args);
  if (!reason) return reject("A reason is required.");

  const durationMs = clampMaxHours(args, "hours", DEFAULT_DURATIONS_MS.timeOfDay);
  const before = ctx.state.timeOfDay ?? null;
  const after: Timed<TimeOfDayId> = {
    value: timeOfDay as TimeOfDayId,
    setOn: ctx.nowIso,
    expiresOn: new Date(ctx.nowMs + durationMs).toISOString(),
  };
  ctx.state.timeOfDay = after;
  return { ok: true, reason, before, after, message: `The village's time-of-day is overridden to ${timeOfDay}.` };
}

async function toolStartFestival(ctx: AgentCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const slot = strArg(args, "slot");
  if (!SLOT_IDS.includes(slot)) return reject(`"${slot}" isn't one of the village's districts.`);
  const name = sanitizeLabel(strArg(args, "name"), FESTIVAL_NAME_MAX_CHARS);
  if (!name) return reject("A festival name is required.");
  const reason = readReason(args);
  if (!reason) return reject("A reason is required.");

  const liveFestivals = effectiveWorld(ctx.state, ctx.nowMs).festivals;
  if (liveFestivals.length >= MAX_FESTIVALS) return reject(`Only ${MAX_FESTIVALS} festivals can run at once.`);
  if (liveFestivals.some((f) => f.value.slotId === slot)) return reject(`"${slot}" already has a festival running.`);

  const days = clampFestivalDays(args);
  const after: Timed<{ slotId: string; name: string }> = {
    value: { slotId: slot, name },
    setOn: ctx.nowIso,
    expiresOn: new Date(ctx.nowMs + days * DAY_MS).toISOString(),
  };
  ctx.state.festivals.push(after);
  return { ok: true, reason, before: null, after, message: `${slot} is now hosting "${name}" for ${days} day(s).` };
}

async function toolSendVisitor(ctx: AgentCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const slot = strArg(args, "slot");
  if (!SLOT_IDS.includes(slot)) return reject(`"${slot}" isn't one of the village's districts.`);
  const artistName = strArg(args, "artist_name");
  if (!artistName) return reject("An artist name is required.");
  const match = ctx.listening.validArtists.get(normalizeArtistName(artistName));
  if (!match) return reject(`"${artistName}" isn't one of the artists listed in today's listening summary.`);
  const reason = readReason(args);
  if (!reason) return reject("A reason is required.");

  const after: Timed<{ slotId: string; artistId: string }> = {
    value: { slotId: slot, artistId: match.artistId },
    setOn: ctx.nowIso,
    expiresOn: new Date(ctx.nowMs + DEFAULT_DURATIONS_MS.visitor).toISOString(),
  };
  ctx.state.visitors.push(after);
  return { ok: true, reason, before: null, after, message: `${match.name} is now visiting ${slot}.` };
}

const TOOL_IMPLS: Record<string, (ctx: AgentCtx, args: Record<string, unknown>) => Promise<ToolOutcome>> = {
  set_district_activity: toolSetDistrictActivity,
  set_weather: toolSetWeather,
  start_festival: toolStartFestival,
  set_time_of_day: toolSetTimeOfDay,
  send_visitor: toolSendVisitor,
  set_character_mood: toolSetCharacterMood,
};

const REASON_PROP = { reason: { type: "STRING", description: "A short reason tying this to the actual listening described above, under 200 characters." } };

const TOOL_DEFS: ChatToolDef[] = [
  {
    name: "set_district_activity",
    description: "Override one district's shown activity level for a while, independent of the real listening-derived level.",
    parameters: {
      type: "OBJECT",
      properties: {
        slot: { type: "STRING", enum: SLOT_IDS, description: "The district's id." },
        level: { type: "STRING", enum: ACTIVITY_LEVELS, description: "The activity level to show." },
        ...REASON_PROP,
        durationHours: { type: "NUMBER", description: "How many hours the override lasts (24-48); defaults to 24 if omitted." },
      },
      required: ["slot", "level", "reason"],
    },
  },
  {
    name: "set_weather",
    description: "Set the whole village's weather for the next day.",
    parameters: {
      type: "OBJECT",
      properties: { weather: { type: "STRING", enum: WEATHER_IDS, description: "The weather to show." }, ...REASON_PROP },
      required: ["weather", "reason"],
    },
  },
  {
    name: "start_festival",
    description: "Start a festival in one district for a few days — at most two festivals village-wide at once, one per district.",
    parameters: {
      type: "OBJECT",
      properties: {
        slot: { type: "STRING", enum: SLOT_IDS, description: "The district hosting the festival." },
        name: { type: "STRING", description: "A short festival name, under 60 characters." },
        ...REASON_PROP,
        days: { type: "NUMBER", description: "How many days it runs, 1 to 3. Defaults to 2 if omitted." },
      },
      required: ["slot", "name", "reason"],
    },
  },
  {
    name: "set_time_of_day",
    description: "Override the village's real day/night cycle for a few hours.",
    parameters: {
      type: "OBJECT",
      properties: {
        timeOfDay: { type: "STRING", enum: TIME_OF_DAY_IDS, description: "The time of day to show." },
        ...REASON_PROP,
        hours: { type: "NUMBER", description: "How many hours the override lasts, at most 6. Defaults to 6 if omitted." },
      },
      required: ["timeOfDay", "reason"],
    },
  },
  {
    name: "send_visitor",
    description: "Send one artist from today's listening summary to visit a district for a day.",
    parameters: {
      type: "OBJECT",
      properties: {
        slot: { type: "STRING", enum: SLOT_IDS, description: "The district the visitor appears in." },
        artist_name: { type: "STRING", description: "The visiting artist's name, copied exactly from the listening summary above." },
        ...REASON_PROP,
      },
      required: ["slot", "artist_name", "reason"],
    },
  },
  {
    name: "set_character_mood",
    description: "Override one district's shown mood for a while, independent of the real listening-derived mood.",
    parameters: {
      type: "OBJECT",
      properties: {
        slot: { type: "STRING", enum: SLOT_IDS, description: "The district's id." },
        mood: { type: "STRING", enum: MOOD_IDS, description: "The mood to show." },
        ...REASON_PROP,
        durationHours: { type: "NUMBER", description: "How many hours the override lasts (24-48); defaults to 24 if omitted." },
      },
      required: ["slot", "mood", "reason"],
    },
  },
];

async function writeAgentEvent(
  env: Env,
  runDate: string,
  tool: string,
  args: Record<string, unknown>,
  reasoning: string,
  before: unknown,
  after: unknown,
  nowIso: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO agent_event (run_date, tool, args, reasoning, before, after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(runDate, tool, JSON.stringify(args), reasoning, JSON.stringify(before), JSON.stringify(after), nowIso)
    .run();
}

/** Runs one validated tool call against `ctx.state`, in order — never thrown
 * out to worker/gemini.ts's chatWithTools (every path returns a plain object
 * it forwards to Gemini as the functionResponse). Rejected calls (bad
 * enum/slot, over MAX_ACCEPTED_CALLS_PER_RUN, over MAX_FESTIVALS, an
 * artist_name outside today's summary, ...) are never applied to `ctx.state`
 * and never written to agent_event — only what actually lands in the world
 * gets logged. */
async function runTool(ctx: AgentCtx, name: string, args: Record<string, unknown>): Promise<unknown> {
  if (ctx.accepted >= MAX_ACCEPTED_CALLS_PER_RUN) {
    ctx.rejected++;
    return { error: `The village has already changed enough today (limit ${MAX_ACCEPTED_CALLS_PER_RUN} reached) — no further changes will be made.` };
  }
  const impl = TOOL_IMPLS[name];
  if (!impl) {
    ctx.rejected++;
    return { error: `Unknown tool "${name}".` };
  }

  const result = await impl(ctx, args);
  if (!result.ok) {
    ctx.rejected++;
    return { error: result.error };
  }

  ctx.accepted++;
  await writeAgentEvent(ctx.env, ctx.runDate, name, args, result.reason, result.before, result.after, ctx.nowIso);
  return { ok: true, message: result.message };
}

// ---------------------------------------------------------------------------
// Cron entry point — gating, D1 read/write, and the chatWithTools run.
// ---------------------------------------------------------------------------
const RUN_HOUR_OWNER_LOCAL = 6;
// Same 4h convention as worker/weekly-brief.ts's RETRY_COOLDOWN_MS — a
// failed/quota-capped attempt is retried on a later cron tick, but never
// sooner than this.
const RETRY_COOLDOWN_MS = 4 * 60 * 60 * 1000;
// Tool-enabled steps only, same role as worker/hokage.ts's MAX_CHAT_STEPS —
// worker/gemini.ts's chatWithTools adds one more possible forced final turn
// on top of this. Smaller than Hokage's 4 isn't right either way: this run
// makes several small write decisions (up to MAX_ACCEPTED_CALLS_PER_RUN),
// some of which will be rejected and need a retry within the same run.
const AGENT_MAX_STEPS = 6;
const MAX_SUMMARY_CHARS = 280;

const AGENT_LIMITED_REPLY = "Today's village review ran out of attention before it could finish.";
const AGENT_FALLBACK_REPLY = "Today's village review didn't come together.";

function parseWorldState(text: string): WorldState {
  try {
    const parsed = JSON.parse(text) as Partial<WorldState>;
    return {
      weather: parsed.weather,
      timeOfDay: parsed.timeOfDay,
      festivals: Array.isArray(parsed.festivals) ? parsed.festivals : [],
      visitors: Array.isArray(parsed.visitors) ? parsed.visitors : [],
      activity: parsed.activity && typeof parsed.activity === "object" ? parsed.activity : {},
      moods: parsed.moods && typeof parsed.moods === "object" ? parsed.moods : {},
    };
  } catch {
    return structuredClone(EMPTY_WORLD);
  }
}

async function loadRawWorldState(env: Env): Promise<WorldState> {
  const row = await env.DB.prepare("SELECT state FROM world_state WHERE id = 1").first<{ state: string }>();
  return row ? parseWorldState(row.state) : structuredClone(EMPTY_WORLD);
}

async function writeWorldState(env: Env, state: EffectiveWorld, nowIso: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO world_state (id, state, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
  )
    .bind(JSON.stringify(state), nowIso)
    .run();
}

interface AgentRunRow {
  status: "ready" | "pending";
  last_attempt_at: string;
  summary: string;
}

async function readAgentRun(env: Env, runDate: string): Promise<AgentRunRow | null> {
  return env.DB.prepare("SELECT status, last_attempt_at, summary FROM agent_run WHERE run_date = ?").bind(runDate).first<AgentRunRow>();
}

async function upsertAgentRun(
  env: Env,
  runDate: string,
  data: { status: "ready" | "pending"; stateBefore: WorldState; stateAfter: WorldState; summary: string },
  nowIso: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO agent_run (run_date, status, last_attempt_at, state_before, state_after, summary)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_date) DO UPDATE SET
       status = excluded.status,
       last_attempt_at = excluded.last_attempt_at,
       state_before = excluded.state_before,
       state_after = excluded.state_after,
       summary = excluded.summary`,
  )
    .bind(runDate, data.status, nowIso, JSON.stringify(data.stateBefore), JSON.stringify(data.stateAfter), data.summary)
    .run();
}

export interface VillageAgentResult {
  /** False when gating skipped the run entirely (too early, already ready,
   * or a pending retry still inside its cooldown) — no D1 write happened at
   * all beyond the reads needed to decide that. */
  ran: boolean;
  runDate: string;
  status: "ready" | "pending" | "skipped";
  summary: string | null;
  acceptedCalls: number;
  rejectedCalls: number;
}

function skipResult(runDate: string, status: "skipped" | "ready" | "pending", summary: string | null = null): VillageAgentResult {
  return { ran: false, runDate, status, summary, acceptedCalls: 0, rejectedCalls: 0 };
}

async function runVillageAgentInner(env: Env, opts: { force?: boolean }): Promise<VillageAgentResult> {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: env.OWNER_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: env.OWNER_TZ, hour: "2-digit", hourCycle: "h23" });
  const runDate = dayFmt.format(new Date(nowMs));

  if (!opts.force) {
    if (Number(hourFmt.format(new Date(nowMs))) < RUN_HOUR_OWNER_LOCAL) {
      return skipResult(runDate, "skipped");
    }
    const existing = await readAgentRun(env, runDate);
    if (existing) {
      if (existing.status === "ready") return skipResult(runDate, "ready", existing.summary);
      if (nowMs - Date.parse(existing.last_attempt_at) < RETRY_COOLDOWN_MS) return skipResult(runDate, "pending");
    }
  }

  const stateBefore = await loadRawWorldState(env);
  const listening = await buildListeningSummary(env, nowMs);
  const effective = effectiveWorld(stateBefore, nowMs);

  const ctx: AgentCtx = { env, runDate, nowMs, nowIso, state: structuredClone(stateBefore), listening, accepted: 0, rejected: 0 };
  const history: ChatMessage[] = [{ role: "user", text: buildPrompt(listening, effective, runDate) }];

  const outcome = await chatWithTools(env, "cron", SYSTEM_PROMPT, history, TOOL_DEFS, (name, args) => runTool(ctx, name, args), {
    kind: "agent",
    maxSteps: AGENT_MAX_STEPS,
    sequentialTools: true, // start_festival/send_visitor's caps must see each other's effects within one step
    limitedReply: AGENT_LIMITED_REPLY,
    fallbackReply: AGENT_FALLBACK_REPLY,
  });

  const status: "ready" | "pending" = outcome.limited || outcome.failed ? "pending" : "ready";
  const summary = status === "ready" ? sanitizeLabel(outcome.reply, MAX_SUMMARY_CHARS) : "";

  await upsertAgentRun(env, runDate, { status, stateBefore, stateAfter: ctx.state, summary }, nowIso);
  // Only a 'ready' run's state actually becomes the live world — see this
  // file's task doc comment / migrations/0010's world_state comment: a
  // 'pending' run's already-accepted calls are still logged in agent_event
  // above, just not yet reflected in what GET /api/world serves.
  if (status === "ready") {
    await writeWorldState(env, effectiveWorld(ctx.state, nowMs), nowIso);
  }

  return { ran: true, runDate, status, summary: status === "ready" ? summary : null, acceptedCalls: ctx.accepted, rejectedCalls: ctx.rejected };
}

/**
 * Runs one cron cycle's worth of village-agent work. Gating (SPEC.md's Phase
 * 11 task):
 *  - Before RUN_HOUR_OWNER_LOCAL owner-local -> too early, skip entirely.
 *  - No row yet for today, at/after RUN_HOUR_OWNER_LOCAL -> generate (first
 *    attempt of the day; this is effectively "the first cron tick at/after
 *    06:00" since every earlier tick that day already skipped above).
 *  - Row exists with status 'ready' -> nothing to do, today is done.
 *  - Row exists with status 'pending' -> retried only once RETRY_COOLDOWN_MS
 *    has passed since last_attempt_at.
 *  - `force: true` (POST /api/world/run's `?force=1`) bypasses every gate
 *    above and always attempts a fresh run — but never the Gemini quota
 *    itself (worker/rate-limit.ts's "agent" sub-cap), which chatWithTools
 *    still checks per step regardless.
 *
 * Never throws — every exit path either returns a result or has already
 * logged, matching worker/weekly-brief.ts's runWeeklyBrief (this rides the
 * same scheduled() tick, right after it — see worker/index.ts).
 */
export async function runVillageAgent(env: Env, opts: { force?: boolean } = {}): Promise<VillageAgentResult> {
  try {
    return await runVillageAgentInner(env, opts);
  } catch (err) {
    console.error("[village-agent] run failed:", err);
    return skipResult("", "skipped");
  }
}

// ---------------------------------------------------------------------------
// GET /api/world — D1-only, no Gemini call this path can ever trigger
// (generation is the cron's/POST /api/world/run's job above).
// ---------------------------------------------------------------------------
export async function handleGetWorld(env: Env): Promise<Response> {
  const nowMs = Date.now();
  const [stateRow, runRow] = await Promise.all([
    env.DB.prepare("SELECT state, updated_at FROM world_state WHERE id = 1").first<{ state: string; updated_at: string }>(),
    env.DB.prepare("SELECT run_date FROM agent_run ORDER BY run_date DESC LIMIT 1").first<{ run_date: string }>(),
  ]);

  const raw = stateRow ? parseWorldState(stateRow.state) : structuredClone(EMPTY_WORLD);
  const effective = effectiveWorld(raw, nowMs);

  const artistIds = Array.from(new Set(effective.visitors.map((v) => v.value.artistId)));
  const visitorNames: Record<string, string> = {};
  if (artistIds.length > 0) {
    const placeholders = artistIds.map(() => "?").join(",");
    const { results } = await env.DB.prepare(`SELECT artist_id, name FROM artist_cache WHERE artist_id IN (${placeholders})`)
      .bind(...artistIds)
      .all<{ artist_id: string; name: string }>();
    for (const r of results) visitorNames[r.artist_id] = r.name;
  }

  const payload: WorldResponse = {
    state: effective,
    visitorNames,
    updatedAt: stateRow?.updated_at ?? null,
    runDate: runRow?.run_date ?? null,
    ownerTz: env.OWNER_TZ,
  };
  return Response.json(payload, { headers: { "Cache-Control": "public, s-maxage=300" } });
}

// ---------------------------------------------------------------------------
// POST /api/world/run — a manual trigger for testing/demoing the agent
// without waiting for the next cron tick. Gated on a shared-secret header
// rather than any real auth (this Worker has no user accounts — same "one
// owner" posture as spotify_token/world_state's single-row tables), and
// returns 404 (not 401/403) on any mismatch, including when
// env.AGENT_TRIGGER_TOKEN was never set at all, so the route is invisible
// unless it's actually been configured (SPEC.md's "API keys only in the
// Worker" — this is that same instinct applied to an admin route).
// ---------------------------------------------------------------------------
export async function handleRunWorld(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }
  if (!env.AGENT_TRIGGER_TOKEN || request.headers.get("X-Agent-Token") !== env.AGENT_TRIGGER_TOKEN) {
    return new Response("Not Found", { status: 404 });
  }

  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "1";
  const result = await runVillageAgent(env, { force });
  return Response.json(result);
}
