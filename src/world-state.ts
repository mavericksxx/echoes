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

async function fetchWorld(): Promise<void> {
  try {
    const res = await fetch("/api/world");
    if (!res.ok) return;
    const payload = (await res.json()) as WorldResponse;
    rawState = payload.state;
    visitorNames = payload.visitorNames;
    ownerTz = payload.ownerTz;
  } catch {
    // Degrade silently to no effects (SPEC.md Phase 11) — rawState stays
    // whatever it already was (EMPTY_WORLD on first load).
  }
}

/** Loads the village's world state once at startup: /api/world when
 * connected, else SAMPLE_WORLD. Call alongside src/listening-source.ts's
 * initListeningSource, passing isVillageConnected() once that's resolved
 * (see this file's doc comment for why `connected` is an argument rather
 * than read here). */
export async function initWorldState(connected: boolean): Promise<void> {
  if (!connected) {
    rawState = SAMPLE_WORLD.state;
    visitorNames = SAMPLE_WORLD.visitorNames;
    ownerTz = SAMPLE_WORLD.ownerTz;
    return;
  }
  await fetchWorld();
}

/** The live-right-now world: effectiveWorld() run again on the client (see
 * SPEC.md Phase 11) even though GET /api/world already pruned server-side —
 * a tab left open keeps its own clock moving, so an entry still live at
 * fetch time can expire before the tab is closed. Cheap to recompute per
 * call: WorldState never holds more than a handful of entries (see
 * shared/world.ts's MAX_FESTIVALS and friends). */
export function getEffectiveWorld(): EffectiveWorld {
  return effectiveWorld(rawState, Date.now());
}

export function getOwnerTz(): string {
  return ownerTz;
}

/** This moment's time-of-day: the agent's override if still live, else the
 * real clock in ownerTz (shared/world.ts's timeOfDayFor). */
export function getTimeOfDay(): TimeOfDayId {
  return getEffectiveWorld().timeOfDay?.value ?? timeOfDayFor(Date.now(), ownerTz);
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
  return getEffectiveWorld().visitors.map((v) => ({
    slotId: v.value.slotId,
    artistId: v.value.artistId,
    name: visitorNames[v.value.artistId] ?? v.value.artistId,
  }));
}

export function getVisitorForSlot(slotId: string): VisitorInfo | undefined {
  return getVisitors().find((v) => v.slotId === slotId);
}
