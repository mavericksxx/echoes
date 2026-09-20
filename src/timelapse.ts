// "Replay the last 24h" time-lapse (Chronicle section, src/sidebar.ts) — the
// village lights up and dims hour by hour, driven by GET /api/history/hourly's
// real per-slot hourly play counts (worker/history-hourly.ts). Feeds a
// synthetic WorldState per hour into src/world-state.ts's setReplayState
// override (owner "timelapse") — deliberately reusing that one seam instead
// of a rendering fork. `timeOfDay` is left unset and `nowMs` is set to that
// hour's own epoch ms, so world-state.ts's existing getSceneHour/getTimeOfDay
// machinery (read every frame by world-render.ts's world-effects draw) makes
// the lighting/sky follow the clock by itself — this file never touches
// rendering directly.

import { SLOTS } from "../data/loader";
import { activityLevel, type ActivityLevel } from "../shared/activity";
import type { Timed, WorldState } from "../shared/world";
import { setReplayState } from "./world-state";
import { SAMPLE_LISTENING } from "./sample-data";

const HOURS = 24;
// ~6-8 Hz (SPEC's step rate for this replay) — fast enough to read as a
// time-lapse, slow enough that each setReplayState call's worldVersion bump
// (which triggers src/main.ts's rebuildVisitors/makeNpc/pathfinding work)
// doesn't fire every render frame.
const STEP_MS = 150;

interface HistoryHourlyResponse {
  ownerTz: string;
  hours: string[]; // 24 "HH:00" labels, oldest first — display only
  bySlot: Record<string, number[]>;
  unslottedByHour: number[];
  gapSuspected: boolean;
}

async function fetchHistoryHourly(): Promise<HistoryHourlyResponse | null> {
  try {
    const res = await fetch("/api/history/hourly");
    if (!res.ok) return null;
    return (await res.json()) as HistoryHourlyResponse;
  } catch {
    return null;
  }
}

// Sample-mode fallback (every accessor in this app keeps working offline):
// synthesize 24 hourly buckets deterministically from SAMPLE_LISTENING's
// existing shares times a fixed daily curve — quiet overnight, busiest in
// the evening. Index 0 is 23 hours ago, index 23 is the current hour, same
// convention the real endpoint uses.
const SAMPLE_DAILY_CURVE = [
  0.1, 0.05, 0.05, 0.05, 0.08, 0.15, 0.25, 0.4, 0.55, 0.6, 0.65, 0.7, 0.75, 0.7, 0.65, 0.7, 0.85, 0.95, 1, 1, 0.9, 0.7,
  0.4, 0.2,
];

function buildSampleHourly(): HistoryHourlyResponse {
  const hours = SAMPLE_DAILY_CURVE.map((_, h) => `${String(h).padStart(2, "0")}:00`);
  const bySlot: Record<string, number[]> = {};
  for (const s of SAMPLE_LISTENING) {
    bySlot[s.slotId] = SAMPLE_DAILY_CURVE.map((curve) => Math.round(curve * s.playShare * 100));
  }
  return {
    ownerTz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    hours,
    bySlot,
    unslottedByHour: new Array(HOURS).fill(0),
    gapSuspected: false,
  };
}

interface HourStep {
  nowMs: number;
  label: string; // "HH:00", for the caption
  state: WorldState;
  busiestSlotId: string | null; // for the "N busiest hours" camera pan below
}

/** Builds this hour's synthetic WorldState: each slot's activityLevel from
 * its share of that hour's total plays (shared/activity.ts's
 * activityLevel), as a Timed<ActivityLevel> live at `nowMs`. No festivals/
 * visitors/moods — this replay only ever drives district brightness. */
function buildHourStep(data: HistoryHourlyResponse, hourEpochs: number[], i: number): HourStep {
  const nowMs = hourEpochs[i]!;
  const setOn = new Date(nowMs).toISOString();
  const expiresOn = new Date(nowMs + 2 * 60 * 60 * 1000).toISOString(); // must outlive nowMs (effectiveWorld's isLive check)

  const slotIds = SLOTS.map((s) => s.district.id);
  const hourCounts = slotIds.map((slotId) => data.bySlot[slotId]?.[i] ?? 0);
  const total = hourCounts.reduce((sum, n) => sum + n, 0) + (data.unslottedByHour[i] ?? 0);

  const activity: Record<string, Timed<ActivityLevel>> = {};
  let busiestSlotId: string | null = null;
  let busiestCount = 0;
  slotIds.forEach((slotId, idx) => {
    const count = hourCounts[idx]!;
    const share = total > 0 ? count / total : 0;
    activity[slotId] = { value: activityLevel(share), setOn, expiresOn };
    if (count > busiestCount) {
      busiestCount = count;
      busiestSlotId = slotId;
    }
  });

  return {
    nowMs,
    label: data.hours[i] ?? "",
    state: { festivals: [], visitors: [], moods: {}, activity },
    busiestSlotId,
  };
}

/** slotId -> district genre label ("Rock/Metal", "Hip-Hop", …), for the
 * "Yesterday 14:00 - Rock/Metal busiest" caption. */
function slotGenre(slotId: string): string {
  return SLOTS.find((s) => s.district.id === slotId)?.district.genre ?? slotId;
}

export interface TimelapseCallbacks {
  /** Same shape as sidebar.ts's Chronicle onReplayCaption hook — the clock
   * readout, or null to clear. */
  onCaption: (text: string | null) => void;
  /** Called only for the 2-3 busiest hours (see startTimelapse's doc
   * comment) — a no-op outside village view already, via the same
   * main.ts panCameraToSlot this hook wraps for Chronicle replay. */
  onFocusSlot: (slotId: string) => void;
  /** Called after every step and on stop, so the sidebar button can show
   * progress and flip back to "Replay". */
  onStepChange: (stepIndex: number, totalSteps: number) => void;
}

interface ActiveTimelapse {
  steps: HourStep[];
  stepIndex: number;
  busiestIndices: Set<number>;
  callbacks: TimelapseCallbacks;
  timer: ReturnType<typeof setTimeout> | null;
}

let active: ActiveTimelapse | null = null;

export function isTimelapseActive(): boolean {
  return active !== null;
}

/** At most the 3 busiest hours (by total plays across slots) get a camera
 * pan — panning on every step would be dizzying over a 24-step, ~3.5s
 * playback. Ties/all-quiet hours just mean fewer than 3 get picked. */
function pickBusiestIndices(steps: HourStep[], data: HistoryHourlyResponse): Set<number> {
  const totals = steps.map((_, i) => {
    const slotIds = SLOTS.map((s) => s.district.id);
    return slotIds.reduce((sum, slotId) => sum + (data.bySlot[slotId]?.[i] ?? 0), 0) + (data.unslottedByHour[i] ?? 0);
  });
  return new Set(
    totals
      .map((total, i) => ({ total, i }))
      .filter((t) => t.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 3)
      .map((t) => t.i),
  );
}

function scheduleStep(): void {
  const t = active;
  if (!t) return;
  t.timer = setTimeout(() => {
    if (active !== t) return; // stopped/superseded while waiting
    if (t.stepIndex >= t.steps.length - 1) {
      stopTimelapse();
      return;
    }
    t.stepIndex++;
    applyStep(t);
    scheduleStep();
  }, STEP_MS);
}

function applyStep(t: ActiveTimelapse): void {
  const step = t.steps[t.stepIndex]!;
  setReplayState(step.state, step.nowMs, {}, "timelapse");
  if (t.busiestIndices.has(t.stepIndex) && step.busiestSlotId) {
    t.callbacks.onFocusSlot(step.busiestSlotId);
  }
  const genre = step.busiestSlotId ? slotGenre(step.busiestSlotId) : null;
  t.callbacks.onCaption(genre ? `Yesterday ${step.label} — ${genre} busiest` : `Yesterday ${step.label}`);
  t.callbacks.onStepChange(t.stepIndex, t.steps.length - 1);
}

/** Starts (or restarts) the time-lapse: fetches (or synthesizes, offline)
 * the last 24h of per-slot play counts, builds one WorldState per hour, and
 * steps through them at STEP_MS, taking over the shared replay slot as
 * owner "timelapse". No-op if one's already running — the caller (sidebar's
 * button) is expected to call stopTimelapse() first if it wants to restart. */
export async function startTimelapse(connected: boolean, callbacks: TimelapseCallbacks): Promise<void> {
  if (active) return;
  const data = connected ? await fetchHistoryHourly() : buildSampleHourly();
  if (!data) return; // fetch failed — caller's button stays as "Replay last 24h"

  const requestNowMs = Date.now();
  const hourEpochs = Array.from({ length: HOURS }, (_, i) => requestNowMs - (HOURS - 1 - i) * 60 * 60 * 1000);
  const steps = Array.from({ length: HOURS }, (_, i) => buildHourStep(data, hourEpochs, i));

  active = {
    steps,
    stepIndex: 0,
    busiestIndices: pickBusiestIndices(steps, data),
    callbacks,
    timer: null,
  };
  applyStep(active);
  scheduleStep();
}

/** Ends the active time-lapse (if any) and restores the live world state —
 * a no-op if Chronicle (or nothing) currently owns the replay slot, same
 * owner-token guard setReplayState itself enforces. */
export function stopTimelapse(): void {
  if (!active) return;
  const callbacks = active.callbacks;
  if (active.timer !== null) clearTimeout(active.timer);
  const totalSteps = active.steps.length - 1;
  active = null;
  setReplayState(null, 0, {}, "timelapse");
  callbacks.onCaption(null);
  callbacks.onStepChange(0, totalSteps);
}
