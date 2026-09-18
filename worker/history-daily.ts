// GET /api/history/daily — D1-only: per-slot play counts for each of the
// last 30 *owner-local* days (SPEC.md's Phase 8b sidebar History section,
// src/sidebar.ts's renderHistory). "Owner-local day" deliberately means the
// one owner's calendar day (wrangler.jsonc's OWNER_TZ var), not each
// visitor's own timezone — a district's daily bar strip should read the
// same to everyone looking at it, and there's exactly one owner (same
// single-row convention as spotify_token).
//
// Day boundaries are computed with the Worker's own Intl.DateTimeFormat
// against OWNER_TZ (en-CA formats as YYYY-MM-DD, convenient for both
// grouping and string date-comparison) and every raw play_event row in a
// generous window is bucketed into owner-local days in JS, rather than
// trying to express "owner-local midnight" as a SQL WHERE clause.

import type { Env } from "./index";
import { SLOTS } from "../data/loader";

const DAYS = 30;
// A play right at the edge of the 30-day window can still land in-window
// once bucketed to the owner's timezone (which may be hours ahead/behind
// this Worker's own clock) — fetch a couple of extra days of raw rows and
// let the day-index lookup below drop anything that still falls outside the
// 30 owner-local days actually returned.
const FETCH_SAFETY_MARGIN_DAYS = 2;

const SLOT_IDS = SLOTS.map((s) => s.district.id);

export interface HistoryDailyPayload {
  ownerTz: string;
  /** 30 owner-local day strings (YYYY-MM-DD), oldest first. */
  days: string[];
  /** epoch ms of the earliest logged play, or null before any data exists —
   * same value as /api/history/stats's collectingSince, for a frontend to
   * tell "before we were collecting" from "we were collecting and got zero". */
  collectingSince: number | null;
  /** slotId -> 30 play counts, aligned index-for-index with `days`. */
  bySlot: Record<string, number[]>;
  /** Plays each day whose primary artist has no slot yet — aligned with
   * `days`. Lets the frontend say "not yet placed" instead of implying a
   * quiet day when some of it just isn't classified yet. */
  unslottedByDay: number[];
}

interface RawPlayRow {
  played_at: number;
  slot_id: string | null;
}

/** The last `count` owner-local day strings ending today, oldest first. */
function ownerLocalDays(fmt: Intl.DateTimeFormat, nowMs: number, count: number): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    out.push(fmt.format(new Date(nowMs - i * 24 * 60 * 60 * 1000)));
  }
  return out;
}

export async function handleHistoryDaily(env: Env): Promise<Response> {
  const dayFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: env.OWNER_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const now = Date.now();
  const days = ownerLocalDays(dayFmt, now, DAYS);
  const dayIndex = new Map(days.map((d, i) => [d, i]));

  const fromMs = now - (DAYS + FETCH_SAFETY_MARGIN_DAYS) * 24 * 60 * 60 * 1000;

  const [{ results }, collectingSinceRow] = await Promise.all([
    env.DB.prepare(
      `SELECT pe.played_at AS played_at, ac.slot_id AS slot_id
       FROM play_event pe
       LEFT JOIN artist_cache ac ON ac.artist_id = pe.primary_artist_id
       WHERE pe.played_at >= ?`,
    )
      .bind(fromMs)
      .all<RawPlayRow>(),
    env.DB.prepare("SELECT MIN(played_at) AS min_played FROM play_event").first<{ min_played: number | null }>(),
  ]);

  const bySlot: Record<string, number[]> = {};
  for (const slotId of SLOT_IDS) bySlot[slotId] = new Array(DAYS).fill(0);
  const unslottedByDay = new Array(DAYS).fill(0);

  for (const row of results) {
    const dayStr = dayFmt.format(new Date(row.played_at));
    const idx = dayIndex.get(dayStr);
    if (idx === undefined) continue; // outside the 30 owner-local days after bucketing (the safety margin's job)
    if (row.slot_id) {
      // Guard against a slot_id that isn't one of today's SLOT_IDS (a
      // roster change, or any other inconsistency) — bySlot[row.slot_id]
      // would otherwise be undefined and the increment below would throw.
      const dayCounts = bySlot[row.slot_id];
      if (dayCounts) dayCounts[idx]!++;
    } else {
      unslottedByDay[idx]!++;
    }
  }

  const payload: HistoryDailyPayload = {
    ownerTz: env.OWNER_TZ,
    days,
    collectingSince: collectingSinceRow?.min_played ?? null,
    bySlot,
    unslottedByDay,
  };
  return Response.json(payload);
}
