// Phase 11's shared contract — the one place both the Worker (worker/
// village-agent.ts, which runs the daily cron agent and validates its tool
// calls) and the frontend (src/*, which renders weather/time-of-day/
// festivals/visitors on top of the village) agree on what the agent can set
// and how a raw, possibly-expired entry resolves into what's actually shown
// right now. Pure data/logic, no DOM and no Worker-only globals — same
// convention as shared/activity.ts and shared/mood.ts, and reuses both
// their ActivityLevel and MoodId rather than redefining a parallel roster.

import type { ActivityLevel } from "./activity";
import type { MoodId } from "./mood";

export const WEATHER_IDS = ["clear", "rain", "snow", "fog", "storm", "blossom"] as const;
export type WeatherId = (typeof WEATHER_IDS)[number];

export const TIME_OF_DAY_IDS = ["dawn", "day", "dusk", "night"] as const;
export type TimeOfDayId = (typeof TIME_OF_DAY_IDS)[number];

/** One agent-set value with its own lifetime: `setOn` is when the agent
 * wrote it, `expiresOn` is when it stops applying and effectiveWorld()
 * drops it. Both ISO timestamps, not epoch ms, so world_state's JSON stays
 * human-readable in D1 (same convention as every other *_at column in this
 * project's migrations). */
export interface Timed<T> {
  value: T;
  setOn: string; // ISO
  expiresOn: string; // ISO
}

/** The village agent's raw, as-written state: every entry it has ever set
 * that hasn't been pruned yet. Never rendered directly — always pass
 * through effectiveWorld() first, which drops anything already expired. */
export interface WorldState {
  weather?: Timed<WeatherId>;
  // An override of the real clock's dawn/day/dusk/night (see
  // timeOfDayFor()), capped at 6 hours so the agent can never leave the
  // village stuck in, say, permanent night — see DEFAULT_DURATIONS_MS.
  timeOfDay?: Timed<TimeOfDayId>;
  // At most MAX_FESTIVALS live at once, at most one per slot — the agent
  // tool that starts one is responsible for enforcing both before writing
  // here (this file only defines the caps, see worker/village-agent.ts).
  festivals: Array<Timed<{ slotId: string; name: string }>>;
  visitors: Array<Timed<{ slotId: string; artistId: string }>>;
  // Per-slot overrides of the derived activity level / mood — see
  // activityFor()/moodFor() for how they layer on top of the real,
  // listening-derived value.
  activity: Record<string, Timed<ActivityLevel>>;
  moods: Record<string, Timed<MoodId>>;
}

/** A fresh village with no agent overrides at all — GET /api/world falls
 * back to this before the agent has ever run, and it's what
 * effectiveWorld() reduces to once every entry has expired. */
export const EMPTY_WORLD: WorldState = {
  festivals: [],
  visitors: [],
  activity: {},
  moods: {},
};

/** WorldState with every expired Timed<T> entry dropped — what actually
 * gets rendered/returned. Same shape as WorldState; the type alias exists
 * so call sites can say "the effective world" rather than "the raw one"
 * without a structural difference to keep straight. */
export type EffectiveWorld = WorldState;

/** Reduces a raw WorldState down to what's still live at `nowMs`. Doesn't
 * mutate `state` — callers that persist should keep writing the raw state
 * (agent_run.state_after, world_state.state) and only call this at read
 * time, so an entry that's expired now can still be inspected/replayed
 * later (see Phase 12's chronicle). */
export function effectiveWorld(state: WorldState, nowMs: number): EffectiveWorld {
  const isLive = <T>(t: Timed<T> | undefined): t is Timed<T> => t !== undefined && Date.parse(t.expiresOn) > nowMs;

  const activity: Record<string, Timed<ActivityLevel>> = {};
  for (const [slotId, t] of Object.entries(state.activity)) {
    if (isLive(t)) activity[slotId] = t;
  }
  const moods: Record<string, Timed<MoodId>> = {};
  for (const [slotId, t] of Object.entries(state.moods)) {
    if (isLive(t)) moods[slotId] = t;
  }

  return {
    weather: isLive(state.weather) ? state.weather : undefined,
    timeOfDay: isLive(state.timeOfDay) ? state.timeOfDay : undefined,
    festivals: state.festivals.filter(isLive),
    visitors: state.visitors.filter(isLive),
    activity,
    moods,
  };
}

/** GET /api/world's response shape: the effective (already-pruned) world,
 * visitor artist ids resolved to display names (artist_cache is a Worker-
 * only table, so the resolution happens server-side, not here), and the
 * bookkeeping the frontend needs to show "last updated"/explain a stale
 * run. `runDate` is owner-local YYYY-MM-DD, matching agent_run.run_date. */
export interface WorldResponse {
  state: EffectiveWorld;
  visitorNames: Record<string, string>; // artistId -> display name
  updatedAt: string | null; // ISO, world_state.updated_at
  runDate: string | null; // most recent agent_run.run_date, if any
  ownerTz: string; // wrangler.jsonc's OWNER_TZ, so the frontend can label times
}

// timeOfDayFor is called every render frame on the client (src/world-state.ts's
// getTimeOfDay, read once per frame by src/main.ts's world-effects drawing) —
// caching one Intl.DateTimeFormat per tz instead of constructing a fresh one
// on every call avoids needless per-frame allocation. In practice there's
// only ever one tz in play (wrangler.jsonc's OWNER_TZ), so this map never
// grows past a single entry.
const HOUR_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function hourFormatterFor(tz: string): Intl.DateTimeFormat {
  let fmt = HOUR_FORMATTERS.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hourCycle: "h23" });
    HOUR_FORMATTERS.set(tz, fmt);
  }
  return fmt;
}

/** Real-clock dawn/day/dusk/night for `tz` at `nowMs`, before any
 * WorldState.timeOfDay override is layered on (see moodFor-style helpers
 * below). Boundaries: dawn 5-7, day 7-17, dusk 17-20, night otherwise —
 * same Intl-in-OWNER_TZ technique as worker/weekly-brief.ts's hourFmt. */
export function timeOfDayFor(nowMs: number, tz: string): TimeOfDayId {
  const hour = Number(hourFormatterFor(tz).format(new Date(nowMs)));
  if (hour >= 5 && hour < 7) return "dawn";
  if (hour >= 7 && hour < 17) return "day";
  if (hour >= 17 && hour < 20) return "dusk";
  return "night";
}

/** A slot's shown activity level: the agent's override if one's still
 * live, else whatever the caller derived from real listening share
 * (shared/activity.ts's activityLevel()). */
export function activityFor(world: EffectiveWorld, slotId: string, derived: ActivityLevel): ActivityLevel {
  return world.activity[slotId]?.value ?? derived;
}

/** A slot's shown mood: the agent's override if one's still live, else
 * whatever the caller derived (worker/gemini.ts's Gemini-tagged mood). */
export function moodFor(world: EffectiveWorld, slotId: string, derived: MoodId | undefined): MoodId | undefined {
  return world.moods[slotId]?.value ?? derived;
}

// --- Caps & defaults (worker/village-agent.ts enforces these; this file
// only defines the numbers so both sides agree on them) ---

/** A single cron run may make at most this many *accepted* (validated,
 * actually-applied) tool calls — keeps one run from rewriting the whole
 * village at once, independent of any Gemini step/quota cap. */
export const MAX_ACCEPTED_CALLS_PER_RUN = 4;

/** At most this many festivals live at once, one per slot. */
export const MAX_FESTIVALS = 2;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Default entry lifetimes in ms, keyed by what's being set. Festival,
 * activity and mood give a [min, max] the agent picks within; the actual
 * pick is worker/village-agent.ts's job — these are just the bounds both
 * sides agree on. Time-of-day is capped at 6h so an override can never
 * outlive more than one real day-part. */
export const DEFAULT_DURATIONS_MS = {
  weather: DAY_MS,
  festival: [DAY_MS, 3 * DAY_MS] as const,
  visitor: DAY_MS,
  activity: [DAY_MS, 2 * DAY_MS] as const,
  mood: [DAY_MS, 2 * DAY_MS] as const,
  timeOfDay: 6 * HOUR_MS, // max — the agent may set less, never more
};

/** Trims a free-text label (a festival name, so far) down to something
 * safe to store and render: strips newlines/control characters, then caps
 * length at `max` chars. Doesn't touch ordinary punctuation/unicode. */
export function sanitizeLabel(s: string, max: number): string {
  const stripped = s.trim().replace(/[\x00-\x1F\x7F]/g, ""); // strips C0/DEL control chars, including \n/\r
  return stripped.length > max ? stripped.slice(0, max) : stripped;
}
