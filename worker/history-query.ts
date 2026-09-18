// Phase 8b: the one shared aggregation over `play_event`, used by both
// worker/village.ts (history-driven activity/share) and — once a run has
// enough data — anywhere else that needs "how many plays landed in each
// slot over some window". Joins to `artist_cache` at query time rather than
// trusting any slot frozen at play time, for the same reason
// migrations/0004_play_event.sql's play_event has no slot_id column: a
// slot is a re-classifiable inference, so every play should always reflect
// the artist's *current* best classification.
//
// Aggregates by `primary_artist_id` only — never `artist_ids` via
// json_each — so a track with three artists still casts exactly one vote,
// same as Spotify's own top-artists semantics. Counts plays, not
// duration_ms: Spotify's API exposes no real listened-duration signal (see
// worker/history.ts's doc comment), so a duration-weighted share would just
// be weighting by catalog track length, not by actual listening.

import type { Env } from "./index";

export interface SlotPlaysResult {
  /** Play counts per slot id — only slots with at least one play in the
   * window appear as keys. */
  bySlot: Record<string, number>;
  /** Sum of bySlot's values: plays whose primary artist has a resolved slot. */
  slottedPlays: number;
  /** Every play in the window, slotted or not — the denominator for a
   * caller's "how much of this window is actually classified" figure. */
  totalPlays: number;
}

interface SlotPlaysRow {
  slot_id: string;
  plays: number;
}

/** Aggregates `play_event` rows with `fromMs <= played_at <= toMs` into
 * per-slot play counts, plus the totals needed to judge how much of the
 * window is actually classified yet. */
export async function slotPlaysBetween(env: Env, fromMs: number, toMs: number): Promise<SlotPlaysResult> {
  const [slotRows, totalRow] = await Promise.all([
    env.DB.prepare(
      `SELECT ac.slot_id AS slot_id, COUNT(*) AS plays
       FROM play_event pe
       JOIN artist_cache ac ON ac.artist_id = pe.primary_artist_id
       WHERE pe.played_at >= ? AND pe.played_at <= ? AND ac.slot_id IS NOT NULL
       GROUP BY ac.slot_id`,
    )
      .bind(fromMs, toMs)
      .all<SlotPlaysRow>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM play_event WHERE played_at >= ? AND played_at <= ?`)
      .bind(fromMs, toMs)
      .first<{ n: number }>(),
  ]);

  const bySlot: Record<string, number> = {};
  let slottedPlays = 0;
  for (const row of slotRows.results) {
    bySlot[row.slot_id] = row.plays;
    slottedPlays += row.plays;
  }
  return { bySlot, slottedPlays, totalPlays: totalRow?.n ?? 0 };
}
