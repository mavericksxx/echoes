// Shared "activity level" semantics — the one place both the frontend
// (src/sample-data.ts, for the offline/sample fallback) and the Worker
// (worker/village.ts, for real Spotify-derived listening share) agree on
// what dormant/quiet/active/festival mean, and what each looks like. Pure
// data/logic, no DOM and no Worker-only globals, so both tsconfigs (root
// include: ["src","data","shared"]; worker include: ".", reaching this via
// a relative import) can type-check it.

export type ActivityLevel = "dormant" | "quiet" | "active" | "festival";

/** Same thresholds Phase 1/2.5 used for the sample data, now the single
 * source of truth: a slot's share of total listening (0..1) buckets into
 * one of four activity levels. */
export function activityLevel(playShare: number): ActivityLevel {
  if (playShare <= 0) return "dormant";
  if (playShare < 0.05) return "quiet";
  if (playShare < 0.2) return "active";
  return "festival";
}

/** What an activity level looks/feels like in a district's interior (see
 * src/main.ts's renderDistrict + src/residents.ts's crowd helpers) — kept as
 * one small table, documented here, rather than scattered magic numbers:
 *  - `overlay`: a CSS color drawn as a full-bg wash (null = no wash).
 *  - `crowdExtra`: extra non-interactive background villagers.
 *  - `festivalProps`: whether to draw festival bunting/lanterns.
 *  - `performChanceMul`: multiplies the leader's spontaneous "perform" chance
 *    (see npc.ts's UpdateOptions.performChanceMul).
 */
export interface ActivityTreatment {
  overlay: string | null;
  crowdExtra: number;
  festivalProps: boolean;
  performChanceMul: number;
}

export const ACTIVITY_TREATMENT: Record<ActivityLevel, ActivityTreatment> = {
  dormant: { overlay: "rgba(6, 10, 16, 0.5)", crowdExtra: 0, festivalProps: false, performChanceMul: 0 },
  quiet: { overlay: "rgba(6, 10, 16, 0.24)", crowdExtra: 0, festivalProps: false, performChanceMul: 0.6 },
  active: { overlay: null, crowdExtra: 1, festivalProps: false, performChanceMul: 1 },
  festival: { overlay: "rgba(255, 191, 110, 0.16)", crowdExtra: 2, festivalProps: true, performChanceMul: 1.8 },
};
