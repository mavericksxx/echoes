// Phase 7a's fixed mood roster — the one place both the Worker
// (worker/gemini.ts, which tags each artist with one via Gemini) and the
// frontend (src/listening-source.ts, src/residents.ts, src/npc.ts, which
// read a slot's aggregate mood back off /api/village) agree on the exact
// set, mirroring how shared/activity.ts is the single source of truth for
// ActivityLevel across the same Worker/frontend split.

export const MOOD_IDS = ["calm", "melancholy", "upbeat", "intense", "dreamy"] as const;
export type MoodId = (typeof MOOD_IDS)[number];
