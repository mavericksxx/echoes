// The genre sidebar: opens when a character is tapped. A fixed right-side
// panel on desktop (the map stays visible and interactive beside it) and a
// full-height slide-up sheet on phones. Built entirely with DOM, not canvas.
//
// Sections are data-driven ({id, label, render}) so later phases can add
// Character (Phase 7), History (Phase 8), This week (Phase 9) without
// restructuring this file — they'd just push another entry onto SECTIONS.

import type { Slot } from "../data/loader";
import { drawPortrait, type ImageMap } from "./render";
import {
  activityLevel,
  getListening,
  nowPlayingSong,
  SAMPLE_NOW,
  topArtists,
  totalPlays,
  type ArtistTotal,
  type Song,
} from "./sample-data";
import { coverPlaceholderGradient } from "./cover-art";

let images: ImageMap = {};
export function setSidebarImages(loaded: ImageMap): void {
  images = loaded;
}

interface SectionContext {
  slot: Slot;
  switchToSongs: (filterArtist?: string) => void;
}

interface Section {
  id: string;
  label: string;
  render: (container: HTMLElement, ctx: SectionContext) => void;
}

interface SidebarHooks {
  /** Called after the panel closes, so the caller can e.g. return focus to the map. */
  onClose: () => void;
}

// ---- module state ----
let root: HTMLElement;
let backdrop: HTMLElement;
let hooks: SidebarHooks;
let portraitCanvas: HTMLCanvasElement;
let nameEl: HTMLElement;
let genrePill: HTMLElement;
let locationEl: HTMLElement;
let tablistEl: HTMLElement;
let panelHost: HTMLElement;
let closeBtn: HTMLButtonElement;

let currentSlot: Slot | null = null;
let activeSectionId = "overview";

// Songs tab filter/sort state, reset each time a different character opens.
let songsSearch = "";
let songsArtistFilter = "";
let songsAlbumFilter = "";
let songsSort: "plays" | "recent" | "title" = "plays";

function fmtRelative(iso: string): string {
  const days = Math.round((SAMPLE_NOW - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks} week${weeks > 1 ? "s" : ""} ago`;
  const months = Math.round(days / 30);
  return `${months} month${months > 1 ? "s" : ""} ago`;
}

function buildSongRow(song: Song): HTMLElement {
  const isLink = Boolean(song.spotifyUrl);
  const row = document.createElement(isLink ? "a" : "div");
  row.className = "song-row";
  if (isLink) {
    const a = row as HTMLAnchorElement;
    a.href = song.spotifyUrl!;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }

  const cover = document.createElement("div");
  cover.className = "song-row__cover";
  if (song.coverUrl) {
    const img = document.createElement("img");
    img.className = "song-row__cover-img";
    img.src = song.coverUrl;
    img.alt = "";
    img.loading = "lazy";
    cover.appendChild(img);
  } else {
    cover.style.background = coverPlaceholderGradient(`${song.title}|${song.artist}`);
  }

  const info = document.createElement("div");
  info.className = "song-row__info";
  const title = document.createElement("p");
  title.className = "song-row__title";
  title.textContent = song.title;
  const meta = document.createElement("p");
  meta.className = "song-row__meta";
  meta.textContent = `${song.artist} — ${song.album}`;
  info.append(title, meta);

  const plays = document.createElement("span");
  plays.className = "song-row__plays";
  plays.textContent = `${song.plays} plays`;

  row.append(cover, info, plays);
  return row;
}

/** The Overview tab's "now playing" card — a small panel with a cover, the
 * track's title/artist, and a purely decorative equalizer glyph (a visual
 * "this is playing" cue, not audio-driven). */
function buildNowPlayingCard(song: Song): HTMLElement {
  const card = document.createElement("div");
  card.className = "nowplaying-card";

  const cover = document.createElement("div");
  cover.className = "np-cover";
  if (song.coverUrl) {
    const img = document.createElement("img");
    img.className = "np-cover-img";
    img.src = song.coverUrl;
    img.alt = "";
    img.loading = "lazy";
    cover.appendChild(img);
  } else {
    cover.style.background = coverPlaceholderGradient(`${song.title}|${song.artist}`);
  }

  const meta = document.createElement("div");
  meta.className = "np-meta";
  const title = document.createElement("p");
  title.className = "np-title";
  title.textContent = song.title;
  const sub = document.createElement("p");
  sub.className = "np-sub";
  sub.textContent = song.artist;
  meta.append(title, sub);

  const eq = document.createElement("span");
  eq.className = "eq";
  eq.setAttribute("aria-hidden", "true");
  eq.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));

  card.append(cover, meta, eq);
  return card;
}

/** Shared artist row for Overview's "top artists" and the Artists tab — built
 * with textContent (not innerHTML) since the artist name is data, not markup. */
function buildArtistRow(artist: ArtistTotal, onSelect: () => void): HTMLButtonElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "artist-row";

  const name = document.createElement("span");
  name.className = "artist-row__name";
  name.textContent = artist.name;

  const plays = document.createElement("span");
  plays.className = "artist-row__plays";
  plays.textContent = `${artist.plays} plays`;

  row.append(name, plays);
  row.addEventListener("click", onSelect);
  return row;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
const ACTIVITY_LABEL: Record<string, string> = {
  dormant: "Dormant",
  quiet: "Quiet",
  active: "Active",
  festival: "Festival",
};

function renderOverview(container: HTMLElement, ctx: SectionContext): void {
  const listening = getListening(ctx.slot.district.id);
  const level = activityLevel(listening?.playShare ?? 0);

  const pill = document.createElement("span");
  pill.className = `activity-pill activity-pill--${level}`;
  pill.textContent = ACTIVITY_LABEL[level] ?? level;
  container.appendChild(pill);

  const stats = document.createElement("div");
  stats.className = "overview-stats";
  const share = document.createElement("div");
  share.className = "overview-stat";
  share.innerHTML = `<strong>${Math.round((listening?.playShare ?? 0) * 100)}%</strong><span>of plays</span>`;
  const plays = document.createElement("div");
  plays.className = "overview-stat";
  plays.innerHTML = `<strong>${totalPlays(listening)}</strong><span>plays logged</span>`;
  stats.append(share, plays);
  container.appendChild(stats);

  const artists = topArtists(listening).slice(0, 3);
  if (artists.length) {
    const heading = document.createElement("p");
    heading.className = "sidebar-heading";
    heading.textContent = "Top artists";
    container.appendChild(heading);
    const list = document.createElement("div");
    list.className = "artist-list";
    artists.forEach((a) => list.appendChild(buildArtistRow(a, () => ctx.switchToSongs(a.name))));
    container.appendChild(list);
  }

  const npHeading = document.createElement("p");
  npHeading.className = "sidebar-heading";
  npHeading.textContent = "Now playing";
  container.appendChild(npHeading);

  const now = nowPlayingSong(listening);
  if (now) {
    container.appendChild(buildNowPlayingCard(now));
  } else {
    const empty = document.createElement("p");
    empty.className = "sidebar-empty";
    empty.textContent = "Nothing playing right now.";
    container.appendChild(empty);
  }
}

// ---------------------------------------------------------------------------
// Songs
// ---------------------------------------------------------------------------
function renderSongs(container: HTMLElement, ctx: SectionContext): void {
  const listening = getListening(ctx.slot.district.id);
  const songs = listening?.songs ?? [];

  const controls = document.createElement("div");
  controls.className = "songs-controls";

  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Search songs";
  search.className = "songs-search";
  search.value = songsSearch;
  search.setAttribute("aria-label", "Search songs");

  const artists = Array.from(new Set(songs.map((s) => s.artist))).sort();
  const artistSelect = document.createElement("select");
  artistSelect.className = "songs-filter songs-filter--artist";
  artistSelect.setAttribute("aria-label", "Filter by artist");
  artistSelect.append(new Option("All artists", ""));
  artists.forEach((a) => artistSelect.append(new Option(a, a)));
  artistSelect.value = songsArtistFilter;

  const albums = Array.from(new Set(songs.map((s) => s.album))).sort();
  const albumSelect = document.createElement("select");
  albumSelect.className = "songs-filter songs-filter--album";
  albumSelect.setAttribute("aria-label", "Filter by album");
  albumSelect.append(new Option("All albums", ""));
  albums.forEach((a) => albumSelect.append(new Option(a, a)));
  albumSelect.value = songsAlbumFilter;

  const sortSelect = document.createElement("select");
  sortSelect.className = "songs-filter songs-filter--sort";
  sortSelect.setAttribute("aria-label", "Sort songs");
  sortSelect.append(
    new Option("Most played", "plays"),
    new Option("Recently played", "recent"),
    new Option("Title", "title"),
  );
  sortSelect.value = songsSort;

  // renderSection() rebuilds this whole tab's DOM (filtering/sorting isn't
  // incremental), which would otherwise steal focus out of whichever control
  // the user is still using — re-find and refocus it (and, for the text
  // search box, restore the caret) after every rerender.
  function rerenderPreservingFocus(selector: string, restoreCaret: boolean): void {
    const prev = panelHost.querySelector<HTMLInputElement>(selector);
    const caret = restoreCaret ? (prev?.selectionStart ?? null) : null;
    renderSection(activeSectionId);
    const next = panelHost.querySelector<HTMLInputElement>(selector);
    next?.focus();
    if (restoreCaret && caret !== null) next?.setSelectionRange(caret, caret);
  }

  search.addEventListener("input", () => {
    songsSearch = search.value;
    rerenderPreservingFocus(".songs-search", true);
  });
  artistSelect.addEventListener("change", () => {
    songsArtistFilter = artistSelect.value;
    rerenderPreservingFocus(".songs-filter--artist", false);
  });
  albumSelect.addEventListener("change", () => {
    songsAlbumFilter = albumSelect.value;
    rerenderPreservingFocus(".songs-filter--album", false);
  });
  sortSelect.addEventListener("change", () => {
    songsSort = sortSelect.value as typeof songsSort;
    rerenderPreservingFocus(".songs-filter--sort", false);
  });

  controls.append(search, artistSelect, albumSelect, sortSelect);
  container.appendChild(controls);

  const q = songsSearch.trim().toLowerCase();
  let filtered = songs.filter(
    (s) =>
      (!songsArtistFilter || s.artist === songsArtistFilter) &&
      (!songsAlbumFilter || s.album === songsAlbumFilter) &&
      (!q || s.title.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q)),
  );
  filtered = [...filtered].sort((a, b) => {
    if (songsSort === "plays") return b.plays - a.plays;
    if (songsSort === "recent") return Date.parse(b.lastPlayed) - Date.parse(a.lastPlayed);
    return a.title.localeCompare(b.title);
  });

  const list = document.createElement("div");
  list.className = "song-list";
  if (filtered.length === 0) {
    const empty = document.createElement("p");
    empty.className = "sidebar-empty";
    empty.textContent = songs.length
      ? "No songs match those filters."
      : "No plays yet — this district is quiet.";
    list.appendChild(empty);
  } else {
    filtered.forEach((s) => {
      const row = buildSongRow(s);
      const sub = row.querySelector<HTMLElement>(".song-row__meta");
      if (sub) sub.textContent = `${s.artist} — ${s.album} — ${fmtRelative(s.lastPlayed)}`;
      list.appendChild(row);
    });
  }
  container.appendChild(list);
}

// ---------------------------------------------------------------------------
// Artists
// ---------------------------------------------------------------------------
function renderArtists(container: HTMLElement, ctx: SectionContext): void {
  const listening = getListening(ctx.slot.district.id);
  const artists = topArtists(listening);

  if (artists.length === 0) {
    const empty = document.createElement("p");
    empty.className = "sidebar-empty";
    empty.textContent = "No plays yet — this district is quiet.";
    container.appendChild(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "artist-list";
  artists.forEach((a) => list.appendChild(buildArtistRow(a, () => ctx.switchToSongs(a.name))));
  container.appendChild(list);
}

const SECTIONS: Section[] = [
  { id: "overview", label: "Overview", render: renderOverview },
  { id: "songs", label: "Songs", render: renderSongs },
  { id: "artists", label: "Artists", render: renderArtists },
];

// ---------------------------------------------------------------------------
// Tablist + panel rendering
// ---------------------------------------------------------------------------
// The panel host is a single persistent DOM node whose *content* swaps per
// section, so every tab's aria-controls points at the same real id — three
// separate panel elements (only one ever visible) would need aria-controls
// on the inactive tabs to reference ids that don't currently exist.
const PANEL_ID = "sidebar-panel";

function renderTablist(): void {
  tablistEl.innerHTML = "";
  SECTIONS.forEach((section) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "sidebar-tab";
    tab.id = `tab-${section.id}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", PANEL_ID);
    tab.setAttribute("aria-selected", String(section.id === activeSectionId));
    tab.tabIndex = section.id === activeSectionId ? 0 : -1;
    tab.textContent = section.label;
    tab.addEventListener("click", () => renderSection(section.id));
    tablistEl.appendChild(tab);
  });
}

function focusTab(index: number): void {
  const tabs = Array.from(tablistEl.querySelectorAll<HTMLButtonElement>(".sidebar-tab"));
  const clamped = (index + tabs.length) % tabs.length;
  const section = SECTIONS[clamped];
  if (!section) return;
  // renderSection() rebuilds the tablist's buttons, so `tabs[clamped]` would
  // be a detached node by the time we could focus it — re-query afterward.
  renderSection(section.id);
  const freshTabs = tablistEl.querySelectorAll<HTMLButtonElement>(".sidebar-tab");
  freshTabs[clamped]?.focus();
}

function renderSection(sectionId: string): void {
  activeSectionId = sectionId;
  if (!currentSlot) return;
  renderTablist();
  panelHost.innerHTML = "";
  panelHost.id = PANEL_ID;
  panelHost.setAttribute("aria-labelledby", `tab-${sectionId}`);
  const section = SECTIONS.find((s) => s.id === sectionId) ?? SECTIONS[0]!;
  section.render(panelHost, {
    slot: currentSlot,
    switchToSongs: (artist) => {
      songsArtistFilter = artist ?? "";
      songsSearch = "";
      songsAlbumFilter = "";
      renderSection("songs");
    },
  });
}

function renderHeader(slot: Slot): void {
  const portraitCtx = portraitCanvas.getContext("2d");
  if (portraitCtx) drawPortrait(portraitCtx, images, slot.character);
  nameEl.textContent = slot.character.name;
  genrePill.textContent = slot.district.genre;
  locationEl.textContent = slot.district.location;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function initSidebar(rootEl: HTMLElement, backdropEl: HTMLElement, h: SidebarHooks) {
  root = rootEl;
  backdrop = backdropEl;
  hooks = h;

  root.innerHTML = "";
  const grabber = document.createElement("div");
  grabber.className = "sidebar__grabber";
  grabber.setAttribute("aria-hidden", "true");

  closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "sidebar__close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => close());

  const header = document.createElement("div");
  header.className = "sidebar__header";
  portraitCanvas = document.createElement("canvas");
  portraitCanvas.className = "sidebar__portrait";
  portraitCanvas.width = 64;
  portraitCanvas.height = 64;
  const headerText = document.createElement("div");
  headerText.className = "sidebar__header-text";
  nameEl = document.createElement("h2");
  nameEl.className = "sidebar__name";
  const meta = document.createElement("div");
  meta.className = "sidebar__meta";
  genrePill = document.createElement("span");
  genrePill.className = "pill";
  locationEl = document.createElement("span");
  locationEl.className = "sidebar__location";
  meta.append(genrePill, locationEl);
  headerText.append(nameEl, meta);
  header.append(portraitCanvas, headerText);

  tablistEl = document.createElement("div");
  tablistEl.className = "sidebar-tablist";
  tablistEl.setAttribute("role", "tablist");
  tablistEl.setAttribute("aria-label", "District details");
  tablistEl.addEventListener("keydown", (ev) => {
    const tabs = Array.from(tablistEl.querySelectorAll<HTMLButtonElement>(".sidebar-tab"));
    const idx = tabs.findIndex((t) => t === document.activeElement);
    if (ev.key === "ArrowRight") {
      ev.stopPropagation();
      focusTab(idx + 1);
    } else if (ev.key === "ArrowLeft") {
      ev.stopPropagation();
      focusTab(idx - 1);
    } else if (ev.key === "Home") {
      ev.stopPropagation();
      focusTab(0);
    } else if (ev.key === "End") {
      ev.stopPropagation();
      focusTab(tabs.length - 1);
    }
  });

  panelHost = document.createElement("div");
  panelHost.className = "sidebar-panel";
  panelHost.setAttribute("role", "tabpanel");
  panelHost.tabIndex = 0;

  const footer = document.createElement("div");
  footer.className = "sidebar__footer";
  footer.textContent = "Data from Spotify";
  footer.title = "Real Spotify attribution logo/branding lands in Phase 2";

  root.append(grabber, closeBtn, header, tablistEl, panelHost, footer);
  backdrop.addEventListener("click", () => close());
}

export function openSidebar(slot: Slot): void {
  const isFirstOpen = !root.classList.contains("is-open");
  const districtChanged = isFirstOpen || currentSlot?.district.id !== slot.district.id;
  currentSlot = slot;
  // A fresh open resets everything, including landing back on Overview.
  // Switching to a different character while the panel stays open resets the
  // Songs search/filters (they were scoped to the old district) but leaves
  // whichever tab the user was on alone.
  if (districtChanged) {
    songsSearch = "";
    songsArtistFilter = "";
    songsAlbumFilter = "";
    songsSort = "plays";
  }
  if (isFirstOpen) activeSectionId = "overview";
  renderHeader(slot);
  renderSection(activeSectionId);

  root.hidden = false;
  backdrop.hidden = false;
  requestAnimationFrame(() => {
    root.classList.add("is-open");
    backdrop.classList.add("is-open");
  });
  root.setAttribute("aria-hidden", "false");

  if (isFirstOpen) {
    const activeTab = tablistEl.querySelector<HTMLButtonElement>('[aria-selected="true"]');
    (activeTab ?? closeBtn).focus();
  }
}

export function close(): void {
  if (!root.classList.contains("is-open")) return;
  root.classList.remove("is-open");
  backdrop.classList.remove("is-open");
  root.setAttribute("aria-hidden", "true");
  currentSlot = null;
  window.setTimeout(() => {
    if (!root.classList.contains("is-open")) {
      root.hidden = true;
      backdrop.hidden = true;
    }
  }, 250);
  hooks.onClose();
}

export function isSidebarOpen(): boolean {
  return root.classList.contains("is-open");
}

export function sidebarSlotId(): string | null {
  return currentSlot?.district.id ?? null;
}
