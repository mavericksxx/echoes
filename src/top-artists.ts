// "Your top artists" panel + connection status chip (Phase 2). Fetches
// /api/top-artists on load; sample listening data (src/sample-data.ts)
// keeps driving the village/sidebar regardless of what this returns — this
// panel is additive, not a replacement, until Phase 3 wires real data into
// the districts themselves. No login UI: the chip and panel only ever
// *reflect* connection state, they never offer a way to connect.

import { coverPlaceholderGradient } from "./cover-art";

type TimeRange = "short_term" | "medium_term" | "long_term";

interface TopArtistOut {
  id: string;
  name: string;
  genres: string[];
  image: string | null;
  rank: number;
}

type TopArtistsResponse =
  | { connected: false }
  | { connected: true; live: boolean; range: string; artists: TopArtistOut[]; cachedAt: string | null };

const RANGES: TimeRange[] = ["short_term", "medium_term", "long_term"];
const RANGE_LABELS: Record<TimeRange, string> = {
  short_term: "Recent",
  medium_term: "6 months",
  long_term: "All time",
};

let statusChip: HTMLElement;
let toggleBtn: HTMLButtonElement;
let panel: HTMLElement;
let backdrop: HTMLElement;
let currentRange: TimeRange = "medium_term";
let lastConnected = false;

function setStatusChip(state: "not-connected" | "connected" | "paused"): void {
  statusChip.classList.remove("status-chip--connected", "status-chip--paused");
  if (state === "connected") {
    statusChip.classList.add("status-chip--connected");
    statusChip.textContent = "Connected";
  } else if (state === "paused") {
    statusChip.classList.add("status-chip--paused");
    statusChip.textContent = "Live paused";
  } else {
    // Phase 3: the whole village (districts, residents, activity) now runs
    // on this same connection state (see src/listening-source.ts) — make
    // the chip say what's actually on screen, not just the raw auth state.
    statusChip.textContent = "Sample data";
  }
}

function buildRangeTabs(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "ta-range";
  wrap.setAttribute("role", "tablist");
  wrap.setAttribute("aria-label", "Time range");
  RANGES.forEach((range) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ta-range-btn";
    btn.classList.toggle("is-active", range === currentRange);
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", String(range === currentRange));
    btn.textContent = RANGE_LABELS[range];
    btn.addEventListener("click", () => {
      if (range === currentRange) return;
      currentRange = range;
      void loadAndRender();
    });
    wrap.appendChild(btn);
  });
  return wrap;
}

function buildArtistRow(artist: TopArtistOut): HTMLElement {
  const row = document.createElement("div");
  row.className = "ta-row";

  const rank = document.createElement("span");
  rank.className = "ta-row__rank";
  rank.textContent = String(artist.rank);

  const art = document.createElement("div");
  art.className = "ta-row__art";
  if (artist.image) {
    const img = document.createElement("img");
    img.src = artist.image;
    img.alt = "";
    img.loading = "lazy";
    art.appendChild(img);
  } else {
    art.style.background = coverPlaceholderGradient(artist.id);
  }

  const meta = document.createElement("div");
  meta.className = "ta-row__meta";
  const name = document.createElement("p");
  name.className = "ta-row__name";
  name.textContent = artist.name;
  const genres = document.createElement("p");
  genres.className = "ta-row__genres";
  genres.textContent = artist.genres.length ? artist.genres.slice(0, 2).join(", ") : " ";
  meta.append(name, genres);

  row.append(rank, art, meta);
  return row;
}

function renderPanel(data: TopArtistsResponse): void {
  panel.innerHTML = "";

  const header = document.createElement("div");
  header.className = "ta-panel-header";
  const heading = document.createElement("p");
  heading.className = "ta-heading";
  heading.textContent = "Your top artists";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "icon-btn ta-close";
  close.setAttribute("aria-label", "Close");
  close.textContent = "×";
  close.addEventListener("click", closePanel);
  header.append(heading, close);
  panel.appendChild(header);

  if (!data.connected) {
    const empty = document.createElement("p");
    empty.className = "sidebar-empty";
    empty.textContent = "Not connected.";
    panel.appendChild(empty);
    return;
  }

  panel.appendChild(buildRangeTabs());

  if (!data.live && data.artists.length === 0) {
    const empty = document.createElement("p");
    empty.className = "sidebar-empty";
    empty.textContent = "Live updates are paused — retrying automatically.";
    panel.appendChild(empty);
    return;
  }

  if (data.artists.length === 0) {
    const empty = document.createElement("p");
    empty.className = "sidebar-empty";
    empty.textContent = "No top artists yet for this range.";
    panel.appendChild(empty);
    return;
  }

  const list = document.createElement("div");
  data.artists.forEach((artist) => list.appendChild(buildArtistRow(artist)));
  panel.appendChild(list);
}

async function fetchTopArtists(range: TimeRange): Promise<TopArtistsResponse> {
  try {
    const res = await fetch(`/api/top-artists?range=${range}`);
    if (!res.ok) return { connected: true, live: false, range, artists: [], cachedAt: null };
    return (await res.json()) as TopArtistsResponse;
  } catch {
    // Network error reaching our own Worker — treat like "live paused"
    // rather than surfacing a raw fetch error.
    return { connected: true, live: false, range, artists: [], cachedAt: null };
  }
}

async function loadAndRender(): Promise<void> {
  const data = await fetchTopArtists(currentRange);

  if (!data.connected) {
    setStatusChip("not-connected");
    toggleBtn.hidden = true;
    lastConnected = false;
    closePanel();
  } else {
    setStatusChip(data.live ? "connected" : "paused");
    toggleBtn.hidden = false;
    lastConnected = true;
  }

  if (isPanelOpen() || !lastConnected) renderPanel(data);
}

function isPanelOpen(): boolean {
  return !panel.hidden;
}

function openPanel(): void {
  panel.hidden = false;
  backdrop.hidden = false;
  toggleBtn.setAttribute("aria-expanded", "true");
  panel.setAttribute("aria-hidden", "false");
  void loadAndRender();
}

function closePanel(): void {
  panel.hidden = true;
  backdrop.hidden = true;
  toggleBtn.setAttribute("aria-expanded", "false");
  panel.setAttribute("aria-hidden", "true");
}

export function initTopArtists(): void {
  statusChip = document.getElementById("statusChip")!;
  toggleBtn = document.getElementById("topArtistsBtn") as HTMLButtonElement;
  panel = document.getElementById("topArtistsPanel")!;
  backdrop = document.getElementById("topArtistsBackdrop")!;

  toggleBtn.addEventListener("click", () => {
    if (isPanelOpen()) closePanel();
    else openPanel();
  });
  backdrop.addEventListener("click", closePanel);
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && isPanelOpen()) closePanel();
  });

  void loadAndRender();
}
