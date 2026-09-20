// GET /api/history/hourly — D1-only: per-slot play counts for each of the
// last 24 *owner-local* hours (the sidebar's Chronicle "replay the last 24h"
// time-lapse, src/timelapse.ts). Closely modelled on worker/history-daily.ts
// (same OWNER_TZ Intl bucketing, same LEFT JOIN artist_cache pattern), just
// bucketed by hour instead of by day.

import type { Env } from "./index";
import { SLOTS } from "../data/loader";

const HOURS = 24;
// Same reasoning as history-daily.ts's FETCH_SAFETY_MARGIN_DAYS: a play
// right at the edge of the 24h window can still land in-window once
// bucketed to the owner's timezone — fetch a bit of extra raw rows and let
// the hour-index lookup below drop anything still outside the 24 hours
// actually returned.
const FETCH_SAFETY_MARGIN_MS = 2 * 60 * 60 * 1000;

const SLOT_IDS = SLOTS.map((s) => s.district.id);

export interface HistoryHourlyPayload {
  ownerTz: string;
  /** 24 owner-local hour labels ("HH:00"), oldest first. */
  hours: string[];
  /** slotId -> 24 play counts, aligned index-for-index with `hours`. */
  bySlot: Record<string, number[]>;
  /** Plays each hour whose primary artist has no slot yet — aligned with
   * `hours`, same "not yet placed" meaning as history-daily.ts's
   * unslottedByDay. */
  unslottedByHour: number[];
  /** True if any history_sync row in the last 24h flagged gap_suspected —
   * recently-played caps at 50 items, so a heavy day genuinely has holes.
   * Carried through honestly so the UI caption never claims completeness. */
  gapSuspected: boolean;
}

interface RawPlayRow {
  played_at: number;
  slot_id: string | null;
}

/** The last `count` hour-start epoch-ms values ending at the hour
 * containing `nowMs`, oldest first — an "hour" here just means "this many
 * ms before now", bucketed into owner-local calendar hours below via
 * bucketKey/hourIndex, same as history-daily.ts's day math. */
function ownerLocalHourStarts(nowMs: number, count: number): number[] {
  const out: number[] = [];
  for (let i = count - 1; i >= 0; i--) {
    out.push(nowMs - i * 60 * 60 * 1000);
  }
  return out;
}

/** "HH:00" for `ms` in `tz`, via hourFmt (hour + minute parts; minute is
 * ignored here — this is a bucket label, not a precise timestamp). */
function hourLabel(hourFmt: Intl.DateTimeFormat, ms: number): string {
  const hour = hourFmt.formatToParts(new Date(ms)).find((p) => p.type === "hour")?.value ?? "00";
  return `${hour}:00`;
}

export async function handleHistoryHourly(env: Env): Promise<Response> {
  const hourFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: env.OWNER_TZ,
    hour: "2-digit",
    hourCycle: "h23",
  });
  // Combined date+hour key, used only to bucket rows into one of the 24
  // slots below — distinct owner-local calendar hours, not just "HH" (which
  // would collide across days).
  const bucketFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: env.OWNER_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const bucketKey = (ms: number): string => bucketFmt.format(new Date(ms));

  const now = Date.now();
  const hourStarts = ownerLocalHourStarts(now, HOURS);
  const hours = hourStarts.map((ms) => hourLabel(hourFmt, ms));
  const hourIndex = new Map(hourStarts.map((ms, i) => [bucketKey(ms), i]));

  const fromMs = now - HOURS * 60 * 60 * 1000 - FETCH_SAFETY_MARGIN_MS;

  const [{ results }, gapRow] = await Promise.all([
    env.DB.prepare(
      `SELECT pe.played_at AS played_at, ac.slot_id AS slot_id
       FROM play_event pe
       LEFT JOIN artist_cache ac ON ac.artist_id = pe.primary_artist_id
       WHERE pe.played_at >= ?`,
    )
      .bind(fromMs)
      .all<RawPlayRow>(),
    env.DB.prepare(
      "SELECT 1 AS hit FROM history_sync WHERE gap_suspected = 1 AND ran_at >= ? LIMIT 1",
    )
      .bind(new Date(fromMs).toISOString())
      .first<{ hit: number }>(),
  ]);

  const bySlot: Record<string, number[]> = {};
  for (const slotId of SLOT_IDS) bySlot[slotId] = new Array(HOURS).fill(0);
  const unslottedByHour = new Array(HOURS).fill(0);

  for (const row of results) {
    const idx = hourIndex.get(bucketKey(row.played_at));
    if (idx === undefined) continue; // outside the 24 owner-local hours after bucketing (the safety margin's job)
    if (row.slot_id) {
      // Guard against a slot_id that isn't one of today's SLOT_IDS (a
      // roster change, or any other inconsistency) — bySlot[row.slot_id]
      // would otherwise be undefined and the increment below would throw.
      const hourCounts = bySlot[row.slot_id];
      if (hourCounts) hourCounts[idx]!++;
    } else {
      unslottedByHour[idx]!++;
    }
  }

  const payload: HistoryHourlyPayload = {
    ownerTz: env.OWNER_TZ,
    hours,
    bySlot,
    unslottedByHour,
    gapSuspected: Boolean(gapRow),
  };
  return Response.json(payload);
}
