// Now-playing card (Phase 5a) — a small, display-only HUD card, top-right,
// showing the owner's live currently-playing track (cover art, title,
// artist). No transport controls: the user explicitly asked for a view, not
// a player (SPEC.md). Hidden entirely when nothing is playing; fades in/out
// via .is-visible (the global prefers-reduced-motion rule in style.css
// already collapses that transition to near-instant).
//
// Polling is adaptive, not a flat interval (SPEC.md's rate-limit decision):
// ~10s while playing, 30-60s while idle, and — when the current track is
// nearly over — the next poll is scheduled for just after it should end
// (using progressMs/durationMs) instead of firing another blind ~10s poll
// that could land on either side of the actual transition. Polling also
// stops entirely while the tab is hidden (document.visibilityState) and
// resumes on focus — nothing is gained by polling a tab nobody is looking
// at, and worker/now-playing.ts's own shared cache is what actually bounds
// real Spotify calls regardless of how any one tab behaves.

import { coverPlaceholderGradient } from "./cover-art";

const PLAYING_POLL_MS = 10_000;
const IDLE_POLL_MS = 45_000; // within SPEC.md's 30-60s idle range
const SKIP_AHEAD_BUFFER_MS = 1_500; // land just after, not exactly at, track end
const HIDE_TRANSITION_MS = 260; // slightly longer than style.css's --duration-base fade

interface NowPlayingTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  coverUrl: string | null;
  spotifyUrl: string;
  durationMs: number;
  progressMs: number;
}

type NowPlayingResponse = { playing: boolean; track: NowPlayingTrack | null };

const NOT_PLAYING: NowPlayingResponse = { playing: false, track: null };

let card: HTMLElement;
let link: HTMLAnchorElement;
let coverEl: HTMLDivElement;
let titleEl: HTMLElement;
let artistEl: HTMLElement;

let isShown = false;
let lastTrackId: string | null = null;
let pollTimer: number | undefined;
let hideTimer: number | undefined;

function clearPollTimer(): void {
  if (pollTimer !== undefined) window.clearTimeout(pollTimer);
  pollTimer = undefined;
}

async function fetchNowPlaying(): Promise<NowPlayingResponse> {
  try {
    const res = await fetch("/api/now-playing");
    if (!res.ok) return NOT_PLAYING;
    return (await res.json()) as NowPlayingResponse;
  } catch {
    // Network error reaching our own Worker — same as "nothing playing".
    return NOT_PLAYING;
  }
}

function renderTrack(track: NowPlayingTrack): void {
  // Same track as last render — skip the DOM/image churn (a fresh <img src>
  // would flicker/reload the cover every ~10s for no reason).
  if (track.id === lastTrackId) return;
  lastTrackId = track.id;

  link.href = track.spotifyUrl;
  titleEl.textContent = track.title;
  artistEl.textContent = track.artist;

  coverEl.innerHTML = "";
  if (track.coverUrl) {
    // Cover art unmodified — no crop/filter/overlay, hotlinked straight from
    // i.scdn.co, never re-hosted (SPEC.md's Spotify attribution rules; same
    // treatment as src/sidebar.ts and src/top-artists.ts).
    const img = document.createElement("img");
    img.className = "now-playing-card__cover-img";
    img.src = track.coverUrl;
    img.alt = "";
    img.loading = "lazy";
    coverEl.appendChild(img);
  } else {
    coverEl.style.background = coverPlaceholderGradient(`${track.title}|${track.artist}`);
  }
}

function showCard(): void {
  if (isShown) return;
  isShown = true;
  window.clearTimeout(hideTimer);
  card.hidden = false;
  card.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => card.classList.add("is-visible"));
}

function hideCard(): void {
  if (!isShown) return;
  isShown = false;
  lastTrackId = null; // the next play (even a repeat of the same track) should re-render
  card.classList.remove("is-visible");
  card.setAttribute("aria-hidden", "true");
  hideTimer = window.setTimeout(() => {
    if (!isShown) card.hidden = true;
  }, HIDE_TRANSITION_MS);
}

/** How long to wait before the next poll, given what this one returned. See
 * this file's doc comment for the skip-ahead reasoning. */
function nextDelayMs(data: NowPlayingResponse): number {
  if (!data.playing || !data.track) return IDLE_POLL_MS;
  const remaining = data.track.durationMs - data.track.progressMs;
  if (remaining >= 0 && remaining < PLAYING_POLL_MS) {
    return Math.max(remaining + SKIP_AHEAD_BUFFER_MS, 1_000);
  }
  return PLAYING_POLL_MS;
}

function scheduleNext(delayMs: number): void {
  clearPollTimer();
  if (document.visibilityState === "hidden") return; // resumed by the visibilitychange listener below
  pollTimer = window.setTimeout(() => void poll(), delayMs);
}

async function poll(): Promise<void> {
  const data = await fetchNowPlaying();
  if (data.playing && data.track) {
    renderTrack(data.track);
    showCard();
  } else {
    hideCard();
  }
  scheduleNext(nextDelayMs(data));
}

export function initNowPlayingCard(): void {
  card = document.getElementById("nowPlayingCard")!;

  link = document.createElement("a");
  link.className = "now-playing-card__link";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.setAttribute("aria-label", "Open in Spotify");

  coverEl = document.createElement("div");
  coverEl.className = "now-playing-card__cover";

  const meta = document.createElement("div");
  meta.className = "now-playing-card__meta";
  titleEl = document.createElement("p");
  titleEl.className = "now-playing-card__title";
  artistEl = document.createElement("p");
  artistEl.className = "now-playing-card__artist";
  meta.append(titleEl, artistEl);

  link.append(coverEl, meta);
  card.appendChild(link);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      clearPollTimer();
      void poll();
    } else {
      clearPollTimer();
    }
  });

  if (document.visibilityState !== "hidden") void poll();
}
