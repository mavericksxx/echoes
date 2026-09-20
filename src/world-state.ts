// Phase 11: picks between GET /api/world's real (already-pruned) state and
// src/sample-data.ts's SAMPLE_WORLD fallback — the "sample mode keeps
// working" convention src/listening-source.ts already follows for
// artists/songs/mood, kept in its own module rather than folded into
// listening-source.ts so that file can import this one's accessors (to
// merge agent overrides into getActivity/getMoodEnergy via
// shared/world.ts's activityFor/moodFor) without a circular import: this
// file never imports listening-source.ts, so the connected/not-connected
// decision is passed in by main.ts (which already knows it, right after
// initListeningSource() resolves) instead of read here.

import {
  EMPTY_WORLD,
  effectiveWorld,
  hourFormatterFor,
  timeOfDayFor,
  type EffectiveWorld,
  type TimeOfDayId,
  type WeatherId,
  type WorldResponse,
  type WorldState,
} from "../shared/world";
import { SAMPLE_WORLD } from "./sample-data";

let rawState: WorldState = EMPTY_WORLD;
let visitorNames: Record<string, string> = {};
// A sensible default before the real ownerTz (or SAMPLE_WORLD's) loads —
// getTimeOfDay() can be called before initWorldState() resolves.
let ownerTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Starts GET /api/world immediately — src/main.ts kicks this off in
 * parallel with src/listening-source.ts's initListeningSource() rather than
 * awaiting it serially after, since this fetch doesn't need to know whether
 * the village is actually connected (only whether to *use* the result does
 * — see initWorldState below). Never throws: resolves `null` on any
 * failure, same silent-degrade-to-no-effects convention this used to have
 * inline (SPEC.md Phase 11). */
export async function fetchWorldResponse(): Promise<WorldResponse | null> {
  try {
    const res = await fetch("/api/world");
    if (!res.ok) return null;
    return (await res.json()) as WorldResponse;
  } catch {
    return null;
  }
}

/** Loads the village's world state once at startup: /api/world when
 * connected, else SAMPLE_WORLD. Call alongside src/listening-source.ts's
 * initListeningSource, passing isVillageConnected() once that's resolved
 * (see this file's doc comment for why `connected` is an argument rather
 * than read here). `pending`, when given, is a fetchWorldResponse() call
 * already started earlier (see its own doc comment) — reused here instead
 * of starting a second, redundant request. */
export async function initWorldState(connected: boolean, pending?: Promise<WorldResponse | null>): Promise<void> {
  if (!connected) {
    rawState = SAMPLE_WORLD.state;
    visitorNames = SAMPLE_WORLD.visitorNames;
    ownerTz = SAMPLE_WORLD.ownerTz;
    return;
  }
  const payload = await (pending ?? fetchWorldResponse());
  if (!payload) return; // degrade silently — rawState stays whatever it already was (EMPTY_WORLD on first load)
  rawState = payload.state;
  visitorNames = payload.visitorNames;
  ownerTz = payload.ownerTz;
}

// Phase 12: Chronicle replay override (src/sidebar.ts's Chronicle tab). While
// set, every getEffectiveWorld() call below — and everything built on it,
// world-render.ts's draw calls via getWeather/getTimeOfDay/getFestivals/
// getVisitors, and listening-source.ts's getActivity/getMoodEnergy alike —
// reads `state` pruned against the fixed `nowMs` instead of the live
// rawState/Date.now(). No rendering fork needed: this is the one function
// every reader already goes through. `nowMs` is fixed, not the real clock,
// because it's the moment a past day's Timed<T> entries were pruned against
// when they were live, not "now" for real. `replayVisitorNames` is a
// separate map (not a swap of `visitorNames` below) since a replayed day's
// visitor may not be among today's live visitors at all.
let replay: { state: WorldState; nowMs: number; visitorNames: Record<string, string> } | null = null;

// Bumped on every setReplayState call (start/step/stop) — src/main.ts's
// frame() polls this to know when to call rebuildVisitors() again.
// visitorNpcs (unlike every other per-frame read in this file) is built once
// and cached rather than recomputed every frame, so nothing else would
// otherwise notice a replay stepping to a state with different visitors.
let worldVersion = 0;

export function getWorldVersion(): number {
  return worldVersion;
}

/** Starts/updates (non-null) or ends (null) a Chronicle replay override.
 * `visitorNames` defaults to {} — every caller providing a non-null `state`
 * should also pass its own (worker/chronicle.ts's ChronicleResponse.
 * visitorNames, or SAMPLE_CHRONICLE.visitorNames offline), so a replayed
 * visitor's name resolves instead of falling back to a bare artist id. */
export function setReplayState(state: WorldState | null, nowMs: number, visitorNames: Record<string, string> = {}): void {
  replay = state ? { state, nowMs, visitorNames } : null;
  worldVersion++;
}

/** The live-right-now world: effectiveWorld() run again on the client (see
 * SPEC.md Phase 11) even though GET /api/world already pruned server-side —
 * a tab left open keeps its own clock moving, so an entry still live at
 * fetch time can expire before the tab is closed. Cheap to recompute per
 * call: WorldState never holds more than a handful of entries (see
 * shared/world.ts's MAX_FESTIVALS and friends). Reads through the Phase 12
 * replay override above when one is active. */
export function getEffectiveWorld(): EffectiveWorld {
  if (replay) return effectiveWorld(replay.state, replay.nowMs);
  return effectiveWorld(rawState, Date.now());
}

export function getOwnerTz(): string {
  return ownerTz;
}

/** The clock this render frame should treat as "now": a Chronicle replay's
 * fixed nowMs while one is active (see setReplayState above), else the real
 * clock. Same replay-or-live split getEffectiveWorld() already makes, split
 * out so callers that need a raw timestamp (not a WorldState) — world-render.
 * ts's world-effects draw, via getTimeOfDay/getSceneHour below — don't have
 * to reach into the replay override directly. */
export function getSceneClockMs(): number {
  return replay ? replay.nowMs : Date.now();
}

/** This moment's time-of-day: the agent's override if still live, else the
 * scene clock's real dawn/day/dusk/night in ownerTz (shared/world.ts's
 * timeOfDayFor). Uses getSceneClockMs() rather than Date.now() so a
 * Chronicle replay of a past day shows that day's time of day, not the real
 * current one. */
export function getTimeOfDay(): TimeOfDayId {
  return getEffectiveWorld().timeOfDay?.value ?? timeOfDayFor(getSceneClockMs(), ownerTz);
}

/** The scene clock's fractional owner-local hour (e.g. 14.5 for 2:30pm) —
 * minutes folded in as a fraction, for callers that need finer granularity
 * than timeOfDayFor's dawn/day/dusk/night buckets. Reuses shared/world.ts's
 * cached hourFormatterFor(tz) rather than constructing an Intl.DateTimeFormat
 * per call, same reasoning as timeOfDayFor's own use of it. */
export function getSceneHour(): number {
  const d = new Date(getSceneClockMs());
  const parts = hourFormatterFor(ownerTz).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour + minute / 60;
}

/** undefined (rather than "clear") when there's no live weather override —
 * callers treat that the same as "clear" (no particles/tint to draw). */
export function getWeather(): WeatherId | undefined {
  return getEffectiveWorld().weather?.value;
}

export interface FestivalInfo {
  slotId: string;
  name: string;
}

export function getFestivals(): FestivalInfo[] {
  return getEffectiveWorld().festivals.map((f) => f.value);
}

export function getFestivalForSlot(slotId: string): FestivalInfo | undefined {
  return getFestivals().find((f) => f.slotId === slotId);
}

export interface VisitorInfo {
  slotId: string;
  artistId: string;
  /** Resolved from visitorNames; falls back to the bare id in the
   * unexpected case a visitor's name didn't resolve server-side. */
  name: string;
}

export function getVisitors(): VisitorInfo[] {
  const names = replay ? replay.visitorNames : visitorNames;
  return getEffectiveWorld().visitors.map((v) => ({
    slotId: v.value.slotId,
    artistId: v.value.artistId,
    name: names[v.value.artistId] ?? v.value.artistId,
  }));
}

export function getVisitorForSlot(slotId: string): VisitorInfo | undefined {
  return getVisitors().find((v) => v.slotId === slotId);
}
