// Phase 8a: small, unobtrusive "Collecting since ... · N plays logged"
// readout for the play-event log (worker/history.ts). Deliberately minimal
// — Phase 8.5 (Wrapped) is the real payoff for this data; this just proves
// it's running. Fetched once on load, not polled: the log only grows on a
// 15-min cron, so there's nothing to gain from refreshing more often than a
// page load/reload already does.

interface HistoryStatsResponse {
  collectingSince: number | null;
  plays: number;
  lastPlayedAt: number | null;
  lastSyncAt: string | null;
}

let readoutEl: HTMLElement;

function formatDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

async function fetchStats(): Promise<HistoryStatsResponse | null> {
  try {
    const res = await fetch("/api/history/stats");
    if (!res.ok) return null;
    return (await res.json()) as HistoryStatsResponse;
  } catch {
    return null;
  }
}

export async function initHistoryStats(): Promise<void> {
  readoutEl = document.getElementById("historyReadout")!;

  const stats = await fetchStats();
  if (!stats) return; // request failed — say nothing rather than guess

  // Empty state handled honestly (SPEC.md): before any data exists, say so
  // rather than showing "0 plays logged" as if it were a real result.
  if (stats.plays === 0 || stats.collectingSince === null) {
    readoutEl.textContent = "Listening history: just started collecting";
  } else {
    const playsLabel = stats.plays === 1 ? "play" : "plays";
    readoutEl.textContent = `Collecting since ${formatDate(stats.collectingSince)} · ${stats.plays} ${playsLabel} logged`;
  }
  readoutEl.hidden = false;
}
