// Phase 8b: the single global "era" (Spotify's `time_range` values) that
// drives both /api/village and src/top-artists.ts's panel. Before this each
// had its own independent range state, so a visitor could have the village
// showing one window of their listening while the top-artists panel showed
// another — SPEC.md's "the village and the top-artists panel never show
// different eras". Persisted per viewer in localStorage so a reload keeps
// whichever era they last picked.

export type Era = "short_term" | "medium_term" | "long_term";

export const ERAS: Era[] = ["short_term", "medium_term", "long_term"];

export const ERA_LABELS: Record<Era, string> = {
  short_term: "4 weeks",
  medium_term: "6 months",
  long_term: "All time",
};

const STORAGE_KEY = "echoes.era";
const DEFAULT_ERA: Era = "medium_term";

function isEra(value: string | null): value is Era {
  return value === "short_term" || value === "medium_term" || value === "long_term";
}

function loadEra(): Era {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isEra(stored)) return stored;
  } catch {
    // Private browsing / blocked storage — the era still works for this
    // session, it just won't be remembered next visit.
  }
  return DEFAULT_ERA;
}

let currentEra: Era = loadEra();
const listeners = new Set<(era: Era) => void>();

export function getEra(): Era {
  return currentEra;
}

/** Sets the global era and notifies every subscriber (src/top-artists.ts's
 * own re-render, main.ts's village refetch + resident rebuild). A no-op if
 * `era` is already current, so re-selecting the active tab never triggers a
 * redundant /api/village refetch. */
export function setEra(era: Era): void {
  if (era === currentEra) return;
  currentEra = era;
  try {
    localStorage.setItem(STORAGE_KEY, era);
  } catch {
    // Best-effort only — the era still applies for this session.
  }
  listeners.forEach((fn) => fn(era));
}

export function onEraChange(fn: (era: Era) => void): void {
  listeners.add(fn);
}
