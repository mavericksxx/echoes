// The genre sidebar: opens when a character is tapped. A fixed right-side
// panel on desktop (the map stays visible and interactive beside it) and a
// full-height slide-up sheet on phones. Built entirely with DOM, not canvas.
//
// Sections are data-driven ({id, label, render}) so later phases can add
// Character (Phase 7), History (Phase 8), This week (Phase 9) without
// restructuring this file — they'd just push another entry onto SECTIONS.

import { SLOTS, type Slot } from "../data/loader";
import { drawPortrait, type ImageMap } from "./render";
import {
  SAMPLE_BRIEF,
  SAMPLE_HOKAGE_REPLY,
  SAMPLE_NOW,
  SAMPLE_PLAYLISTS,
  getSamplePlaylist,
  type Persona,
  type SampleBriefNewArtist,
  type Song,
} from "./sample-data";
import {
  activitySource,
  getActivity,
  getArtists,
  getNowPlaying,
  getPersona,
  getSamplePlaysLogged,
  getSongs,
  isVillageConnected,
  isVillageLive,
  villageSongsLive,
  type ArtistEntry,
} from "./listening-source";
import { coverPlaceholderGradient } from "./cover-art";
import { getLiveNowPlaying } from "./now-playing-card";

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
  /** Called when "Enter district" is clicked — the caller (main.ts) owns the
   * village⇄district scene transition. */
  onEnterDistrict: (slotId: string) => void;
  /** Phase 10: called after a Hokage reply names a focusSlots district — the
   * caller (main.ts) owns the camera and decides whether/how to pan (it's a
   * no-op outside village view; see main.ts's panCameraTo). */
  onFocusSlot: (slotId: string) => void;
}

/** Extra options for openSidebar beyond "which slot" — used when opening from
 * within a district (residents) or deciding whether "Enter district" makes
 * sense (only from the village, not from inside the district already). */
export interface OpenSidebarOptions {
  /** Jump straight to this section (e.g. "songs") instead of the default. */
  section?: string;
  /** Pre-filter the Songs tab to this artist (tapping a resident) — an
   * artist id when one's available (real data), else the bare display name
   * (sample data). See matchesArtistFilter() below. */
  filterArtist?: string;
  /** Show the "Enter district" button — true only when opened from the village. */
  showEnter?: boolean;
}

// ---- module state ----
let root: HTMLElement;
let backdrop: HTMLElement;
let hooks: SidebarHooks;
let portraitCanvas: HTMLCanvasElement;
let nameEl: HTMLElement;
let genrePill: HTMLElement;
let locationEl: HTMLElement;
let dialogueEl: HTMLElement;
let tablistEl: HTMLElement;
let panelHost: HTMLElement;
let closeBtn: HTMLButtonElement;
let enterBtn: HTMLButtonElement;

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

/** Songs Artist filter matching: real tracks carry `artistIds` (every artist
 * on the track, features included), so a filter set from an artist row/
 * resident tap (an id) matches by membership rather than exact equality on
 * `artist`'s comma-joined display string — a track like "Kendrick Lamar,
 * SZA" would never equal the filter "Kendrick Lamar" and silently vanish
 * from the filtered view otherwise. Falls back to comparing `artist`
 * directly for sample data (no artistIds) and for the Songs tab's own
 * "Filter by artist" dropdown, whose values are display strings, not ids. */
function matchesArtistFilter(song: Song, filter: string): boolean {
  if (!filter) return true;
  if (song.artistIds) return song.artistIds.includes(filter) || song.artist === filter;
  return song.artist === filter;
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

  // Real tracks carry no play count, only rank (Spotify's top-tracks
  // endpoint gives neither plays nor a timestamp) — show whichever the song
  // has, same fallback order as buildArtistRow's plays/rank/"asleep" badge.
  const plays = document.createElement("span");
  plays.className = "song-row__plays";
  if (song.plays !== undefined) plays.textContent = `${song.plays} plays`;
  else if (song.rank !== undefined) plays.textContent = `#${song.rank}`;

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
 * with textContent (not innerHTML) since the artist name is data, not markup.
 * Sample rows show a play count; real rows (no play counts from Spotify)
 * show a rank, or "asleep" for a faded/absent-this-range artist. */
function buildArtistRow(artist: ArtistEntry, onSelect: () => void): HTMLButtonElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "artist-row";
  if (artist.faded) row.classList.add("artist-row--faded");

  const name = document.createElement("span");
  name.className = "artist-row__name";
  name.textContent = artist.name;

  const meta = document.createElement("span");
  meta.className = "artist-row__plays";
  if (artist.plays !== undefined) meta.textContent = `${artist.plays} plays`;
  else if (artist.faded) meta.textContent = "asleep";
  else if (artist.rank != null) meta.textContent = `#${artist.rank}`;

  row.append(name, meta);
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
  const slotId = ctx.slot.district.id;
  const live = isVillageLive();
  const { level, share } = getActivity(slotId);

  const pill = document.createElement("span");
  pill.className = `activity-pill activity-pill--${level}`;
  pill.textContent = ACTIVITY_LABEL[level] ?? level;
  container.appendChild(pill);

  // Phase 8b: a subtle note on whether the activity/share above (and every
  // other district's, for consistency — worker/village.ts never mixes
  // sources per slot) is real listening history or today's Spotify
  // rank-weighted estimate.
  if (live) {
    const sourceNote = document.createElement("p");
    sourceNote.className = "activity-source-note";
    sourceNote.textContent =
      activitySource() === "history" ? "Activity from your play history" : "Activity from your Spotify top artists";
    container.appendChild(sourceNote);
  }

  const stats = document.createElement("div");
  stats.className = "overview-stats";
  const shareStat = document.createElement("div");
  shareStat.className = "overview-stat";
  shareStat.innerHTML = `<strong>${Math.round(share * 100)}%</strong><span>of plays</span>`;
  const secondStat = document.createElement("div");
  secondStat.className = "overview-stat";
  // Spotify gives ranks, not play counts — the "plays logged" stat only
  // makes sense for the sample fallback (see src/listening-source.ts).
  if (live) {
    secondStat.innerHTML = `<strong>${getArtists(slotId).length}</strong><span>artists placed</span>`;
  } else {
    secondStat.innerHTML = `<strong>${getSamplePlaysLogged(slotId)}</strong><span>plays logged</span>`;
  }
  stats.append(shareStat, secondStat);
  container.appendChild(stats);

  const artists = getArtists(slotId).slice(0, 3);
  if (artists.length) {
    const heading = document.createElement("p");
    heading.className = "sidebar-heading";
    heading.textContent = "Top artists";
    container.appendChild(heading);
    const list = document.createElement("div");
    list.className = "artist-list";
    artists.forEach((a) => list.appendChild(buildArtistRow(a, () => ctx.switchToSongs(a.id ?? a.name))));
    container.appendChild(list);
  }

  const npHeading = document.createElement("p");
  npHeading.className = "sidebar-heading";
  npHeading.textContent = "Now playing";
  container.appendChild(npHeading);

  const now = getNowPlaying(slotId);
  const empty = document.createElement("p");
  empty.className = "sidebar-empty";
  if (now) {
    container.appendChild(buildNowPlayingCard(now));
  } else if (live) {
    // Phase 5b: live currently-playing exists now, but it resolves to exactly
    // one district (worker/now-playing.ts's slotId) — so only that district's
    // panel has something to show, and the rest are genuinely quiet rather
    // than unimplemented. Deliberately a plain line, not buildNowPlayingCard:
    // the live payload carries title/artist only, and the card wants the full
    // Song shape (cover art, Spotify link) that the sample path has.
    const liveNow = getLiveNowPlaying();
    empty.textContent =
      liveNow && liveNow.slotId === slotId
        ? `${liveNow.song} — ${liveNow.artist}`
        : "Nothing playing in this district right now.";
    container.appendChild(empty);
  } else {
    empty.textContent = "Nothing playing right now.";
    container.appendChild(empty);
  }
}

// ---------------------------------------------------------------------------
// Songs
// ---------------------------------------------------------------------------
function renderSongs(container: HTMLElement, ctx: SectionContext): void {
  // Real top tracks once connected+live (Phase 3.5), sample data otherwise —
  // see src/listening-source.ts's getSongs() doc comment.
  const live = isVillageLive();
  const songs = getSongs(ctx.slot.district.id);
  // No "Recently played" sort without real timestamps — if a stale "recent"
  // selection carried over from before this district went live, fall back
  // to the default rather than sorting on an option that's no longer shown.
  if (live && songsSort === "recent") songsSort = "plays";

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
  // A filter set from an artist row/resident tap on real data is an artist
  // id (see matchesArtistFilter's doc comment above), which is never one of
  // the display-string options built below — left alone, `artistSelect.value
  // = songsArtistFilter` fails to match anything, so the browser silently
  // resets the *displayed* selection to "All artists" while the list stays
  // filtered, and — since the control's value is already "" at that point —
  // clicking "All artists" fires no change event, stranding the filter with
  // no way to clear it. A synthetic option keyed by that id (rebuilt fresh
  // every render, so it never accumulates or survives a district switch —
  // see renderSection's panelHost.innerHTML reset) fixes both: the control
  // shows the real active filter, and re-selecting "All artists" now
  // actually changes the control's value.
  if (songsArtistFilter && !artists.includes(songsArtistFilter)) {
    const activeArtist = getArtists(ctx.slot.district.id).find((a) => a.id === songsArtistFilter);
    if (activeArtist) artistSelect.append(new Option(activeArtist.name, songsArtistFilter));
  }
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
  // Real tracks have no timestamp, so "Recently played" isn't just a no-op
  // when live — it's dropped from the list entirely — and the default sort
  // is rank order (Spotify's own top-tracks ordering), labeled to match.
  sortSelect.append(new Option(live ? "Top tracks" : "Most played", "plays"));
  if (!live) sortSelect.append(new Option("Recently played", "recent"));
  sortSelect.append(new Option("Title", "title"));
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
      matchesArtistFilter(s, songsArtistFilter) &&
      (!songsAlbumFilter || s.album === songsAlbumFilter) &&
      (!q || s.title.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q)),
  );
  filtered = [...filtered].sort((a, b) => {
    if (songsSort === "recent") return Date.parse(b.lastPlayed ?? "") - Date.parse(a.lastPlayed ?? "");
    if (songsSort === "title") return a.title.localeCompare(b.title);
    // Default sort ("Most played" sample / "Top tracks" live): plays when
    // present, else rank order (real data has no play count — see Song's
    // doc comment in src/sample-data.ts).
    if (a.plays !== undefined || b.plays !== undefined) return (b.plays ?? 0) - (a.plays ?? 0);
    return (a.rank ?? 0) - (b.rank ?? 0);
  });

  const list = document.createElement("div");
  list.className = "song-list";
  // The #1 hanko stamp (style.css) only means something when the list is
  // actually plays/rank-sorted — skip it when the visitor sorted by title
  // or recency instead, so the seal never stamps a row that isn't really #1.
  if (songsSort !== "plays") list.classList.add("song-list--unranked");
  if (filtered.length === 0) {
    const empty = document.createElement("p");
    empty.className = "sidebar-empty";
    if (songs.length) {
      empty.textContent = "No songs match those filters.";
    } else if (live && !villageSongsLive()) {
      // Distinct from "genuinely no top tracks" below — the tracks stage
      // itself failed server-side (see worker/village.ts's songsLive flag).
      empty.textContent = "Song data is temporarily unavailable.";
    } else if (live) {
      // Bucketing never widens the fetch to fill this in (SPEC.md) — a
      // resident with no top-50 track this range just has an empty tab.
      empty.textContent = "No top tracks in this range.";
    } else {
      empty.textContent = "No plays yet — this district is quiet.";
    }
    list.appendChild(empty);
  } else {
    filtered.forEach((s) => {
      const row = buildSongRow(s);
      const sub = row.querySelector<HTMLElement>(".song-row__meta");
      if (sub) {
        sub.textContent = s.lastPlayed
          ? `${s.artist} — ${s.album} — ${fmtRelative(s.lastPlayed)}`
          : `${s.artist} — ${s.album}`;
      }
      list.appendChild(row);
    });
  }
  container.appendChild(list);
}

// ---------------------------------------------------------------------------
// Artists
// ---------------------------------------------------------------------------
function renderArtists(container: HTMLElement, ctx: SectionContext): void {
  const artists = getArtists(ctx.slot.district.id);

  if (artists.length === 0) {
    const empty = document.createElement("p");
    empty.className = "sidebar-empty";
    empty.textContent = "No plays yet — this district is quiet.";
    container.appendChild(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "artist-list";
  artists.forEach((a) => list.appendChild(buildArtistRow(a, () => ctx.switchToSongs(a.id ?? a.name))));
  container.appendChild(list);
}

// ---------------------------------------------------------------------------
// Character (Phase 7b) — personality + dialogue lines flavored by this
// slot's own top artists (worker/persona.ts), or src/sample-data.ts's
// handwritten personas offline. Null (no personality yet, or a genuinely
// quiet slot) renders a plain empty state, same convention as every other
// section here — never a loading spinner, since a persona either already
// came back with /api/village or it didn't this time.
// ---------------------------------------------------------------------------
function renderCharacter(container: HTMLElement, ctx: SectionContext): void {
  const persona = getPersona(ctx.slot.district.id);
  if (!persona) {
    const empty = document.createElement("p");
    empty.className = "sidebar-empty";
    empty.textContent = isVillageLive()
      ? "No personality generated for this district yet."
      : "This district hasn't found its voice yet.";
    container.appendChild(empty);
    return;
  }

  const heading = document.createElement("p");
  heading.className = "sidebar-heading";
  heading.textContent = "Personality";
  container.appendChild(heading);

  const personality = document.createElement("p");
  personality.className = "character-personality";
  personality.textContent = persona.personality;
  container.appendChild(personality);

  if (persona.dialogue.length > 0) {
    const dialogueHeading = document.createElement("p");
    dialogueHeading.className = "sidebar-heading";
    dialogueHeading.textContent = "Says";
    container.appendChild(dialogueHeading);

    const list = document.createElement("ul");
    list.className = "character-dialogue";
    persona.dialogue.forEach((line) => {
      const item = document.createElement("li");
      item.textContent = line;
      list.appendChild(item);
    });
    container.appendChild(list);
  }
}

// ---------------------------------------------------------------------------
// History (Phase 8b)
// ---------------------------------------------------------------------------
interface HistoryDailyResponse {
  ownerTz: string;
  days: string[]; // 30 owner-local day strings (YYYY-MM-DD), oldest first
  collectingSince: number | null;
  bySlot: Record<string, number[]>;
  unslottedByDay: number[];
}

// Fetched once at load (like src/history-stats.ts) — the log only grows on
// a 15-min cron, so there's nothing to gain from refetching per era change
// or per sidebar open. `undefined` means "not fetched yet", `null` means
// "fetch failed" — both render the same "not available" message below.
let historyDaily: HistoryDailyResponse | null | undefined;

async function fetchHistoryDaily(): Promise<HistoryDailyResponse | null> {
  try {
    const res = await fetch("/api/history/daily");
    if (!res.ok) return null;
    return (await res.json()) as HistoryDailyResponse;
  } catch {
    return null;
  }
}

function loadHistoryDaily(): void {
  void fetchHistoryDaily().then((data) => {
    historyDaily = data;
    // If the visitor is already looking at the History tab when this
    // resolves, refresh it in place instead of leaving it on "loading".
    if (currentSlot && activeSectionId === "history") renderSection("history");
  });
}

function renderHistory(container: HTMLElement, ctx: SectionContext): void {
  if (historyDaily === undefined) {
    const loading = document.createElement("p");
    loading.className = "sidebar-empty";
    loading.textContent = "Loading history…";
    container.appendChild(loading);
    return;
  }
  if (historyDaily === null) {
    const failed = document.createElement("p");
    failed.className = "sidebar-empty";
    failed.textContent = "History isn't available right now.";
    container.appendChild(failed);
    return;
  }

  const { days, bySlot, unslottedByDay, collectingSince, ownerTz } = historyDaily;
  const counts = bySlot[ctx.slot.district.id] ?? new Array(days.length).fill(0);
  // Compare owner-local day strings directly (both "YYYY-MM-DD", so string
  // order is chronological order) rather than converting collectingSince
  // back to a Date — this must line up with the exact same owner-local
  // calendar the Worker bucketed `days` into.
  const collectingSinceDay =
    collectingSince !== null
      ? new Intl.DateTimeFormat("en-CA", { timeZone: ownerTz, year: "numeric", month: "2-digit", day: "2-digit" }).format(
          new Date(collectingSince),
        )
      : null;

  const caption = document.createElement("p");
  caption.className = "history-caption";
  caption.textContent = "Last 30 owner-local days";
  container.appendChild(caption);

  const max = Math.max(1, ...counts);
  const bars = document.createElement("div");
  bars.className = "history-bars";
  days.forEach((day, i) => {
    const bar = document.createElement("span");
    bar.className = "history-bar";
    const count = counts[i] ?? 0;
    const noData = collectingSinceDay !== null ? day < collectingSinceDay : true;
    const unplaced = !noData && count === 0 && (unslottedByDay[i] ?? 0) > 0;
    if (noData) {
      bar.classList.add("history-bar--nodata");
      bar.title = `${day}: no data`;
    } else if (unplaced) {
      bar.classList.add("history-bar--unplaced");
      bar.title = `${day}: plays not yet placed`;
    } else if (count === 0) {
      bar.classList.add("history-bar--zero");
      bar.title = `${day}: 0 plays`;
    } else {
      bar.style.height = `${Math.max(8, Math.round((count / max) * 100))}%`;
      bar.title = `${day}: ${count} play${count === 1 ? "" : "s"}`;
    }
    bars.appendChild(bar);
  });
  container.appendChild(bars);

  if (collectingSinceDay === null) {
    const empty = document.createElement("p");
    empty.className = "sidebar-empty";
    empty.textContent = "Listening history: just started collecting.";
    container.appendChild(empty);
  }
}

// ---------------------------------------------------------------------------
// Wrapped (Phase 8.5)
// ---------------------------------------------------------------------------
// A Wrapped-style read on the listener's *whole* history — not filtered to
// whichever character's sidebar happens to be open (SPEC.md's Phase 8.5) —
// over a real arbitrary range, unlike /api/top-artists's fixed Spotify
// buckets. See worker/wrapped.ts for the response shape and its
// history/spotify source split.
type WrappedRange = "week" | "month" | "year" | "all";

const WRAPPED_RANGES: WrappedRange[] = ["week", "month", "year", "all"];
const WRAPPED_RANGE_LABELS: Record<WrappedRange, string> = {
  week: "This week",
  month: "Month",
  year: "Year",
  all: "All time",
};

interface WrappedTrackOut {
  id: string;
  name: string;
  artists: string;
  art: string | null;
  plays: number | null;
  rank: number | null;
}
interface WrappedArtistOut {
  id: string;
  name: string;
  image: string | null;
  plays: number | null;
  rank: number | null;
}
interface WrappedGenreOut {
  slotId: string;
  plays: number;
}
interface WrappedPayload {
  range: WrappedRange;
  source: "history" | "spotify";
  collectingSince: number | null;
  totalPlays: number | null;
  approxMinutes: number | null;
  topTracks: WrappedTrackOut[];
  topArtists: WrappedArtistOut[];
  topGenres: WrappedGenreOut[];
  unclassifiedPlays: number;
}

let wrappedRange: WrappedRange = "month";
// Cached per range, including a failed fetch ("error") — same
// never-auto-retry convention as historyDaily above; switching ranges and
// back doesn't re-fetch either.
const wrappedCache = new Map<WrappedRange, WrappedPayload | "error">();
const wrappedInFlight = new Set<WrappedRange>();

function formatWrappedDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** Slot id -> the character's display name, matching renderHeader's
 * `slot.character.name`. Looked up defensively (never throws, unlike
 * data/loader.ts's getSlot) since a genre's slot_id in D1 could in
 * principle outlive a roster change — same caution as
 * worker/history-daily.ts's bySlot guard. */
function slotDisplayName(slotId: string): string {
  return SLOTS.find((s) => s.district.id === slotId)?.character.name ?? slotId;
}

async function fetchWrapped(range: WrappedRange): Promise<WrappedPayload | null> {
  try {
    const res = await fetch(`/api/wrapped?range=${range}`);
    if (!res.ok) return null;
    return (await res.json()) as WrappedPayload;
  } catch {
    return null;
  }
}

function loadWrapped(range: WrappedRange): void {
  if (wrappedCache.has(range) || wrappedInFlight.has(range)) return;
  wrappedInFlight.add(range);
  void fetchWrapped(range).then((data) => {
    wrappedInFlight.delete(range);
    wrappedCache.set(range, data ?? "error");
    // If the visitor is still on the Wrapped tab looking at this same range
    // when the fetch resolves, refresh it in place instead of leaving it on
    // "loading" (same pattern as loadHistoryDaily above).
    if (currentSlot && activeSectionId === "wrapped" && wrappedRange === range) renderSection("wrapped");
  });
}

function buildWrappedSongRow(track: WrappedTrackOut): HTMLElement {
  const row = document.createElement("div");
  row.className = "song-row";

  const cover = document.createElement("div");
  cover.className = "song-row__cover";
  if (track.art) {
    const img = document.createElement("img");
    img.className = "song-row__cover-img";
    img.src = track.art;
    img.alt = "";
    img.loading = "lazy";
    cover.appendChild(img);
  } else {
    cover.style.background = coverPlaceholderGradient(`${track.name}|${track.artists}`);
  }

  const info = document.createElement("div");
  info.className = "song-row__info";
  const title = document.createElement("p");
  title.className = "song-row__title";
  title.textContent = track.name;
  const meta = document.createElement("p");
  meta.className = "song-row__meta";
  meta.textContent = track.artists;
  info.append(title, meta);

  // Same plays/rank fallback as buildSongRow above: history gives plays,
  // the Spotify fallback gives only rank.
  const plays = document.createElement("span");
  plays.className = "song-row__plays";
  if (track.plays !== null) plays.textContent = `${track.plays} plays`;
  else if (track.rank !== null) plays.textContent = `#${track.rank}`;

  row.append(cover, info, plays);
  return row;
}

function buildWrappedArtistRow(artist: WrappedArtistOut): HTMLElement {
  const row = document.createElement("div");
  row.className = "ta-row";

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
  // Reuses .ta-row__genres purely for its "small line under the name" style
  // — holds the plays/rank fallback text here, not genres.
  const sub = document.createElement("p");
  sub.className = "ta-row__genres";
  sub.textContent = artist.plays !== null ? `${artist.plays} plays` : artist.rank !== null ? `#${artist.rank}` : " ";
  meta.append(name, sub);

  row.append(art, meta);
  return row;
}

function buildWrappedGenreRow(genre: WrappedGenreOut): HTMLElement {
  const row = document.createElement("div");
  row.className = "artist-row";

  const name = document.createElement("span");
  name.className = "artist-row__name";
  name.textContent = slotDisplayName(genre.slotId);

  const plays = document.createElement("span");
  plays.className = "artist-row__plays";
  plays.textContent = `${genre.plays} plays`;

  row.append(name, plays);
  return row;
}

function renderWrappedContent(container: HTMLElement, data: WrappedPayload): void {
  if (data.source === "spotify") {
    const note = document.createElement("p");
    note.className = "activity-source-note";
    note.textContent = "From Spotify's own top lists — not enough logged plays yet";
    container.appendChild(note);
  }

  // SPEC.md's Phase 8.5: shown always, regardless of source or how thin this
  // particular range's data is — never fabricated, never hidden.
  const collecting = document.createElement("p");
  collecting.className = "history-caption";
  collecting.textContent =
    data.collectingSince !== null
      ? `Collecting since ${formatWrappedDate(data.collectingSince)}`
      : "Just started collecting — no history yet";
  container.appendChild(collecting);

  const isEmpty = data.topTracks.length === 0 && data.topArtists.length === 0 && data.topGenres.length === 0;

  if (data.source === "history" && data.totalPlays !== null && data.approxMinutes !== null && !isEmpty) {
    const stats = document.createElement("div");
    stats.className = "overview-stats";
    const playsStat = document.createElement("div");
    playsStat.className = "overview-stat";
    playsStat.innerHTML = `<strong>${data.totalPlays}</strong><span>plays</span>`;
    const minutesStat = document.createElement("div");
    minutesStat.className = "overview-stat";
    // "duration_ms" is a track's catalog length, not time actually listened
    // (worker/wrapped.ts) — the "≈" and "approx." label are load-bearing,
    // not decorative.
    minutesStat.innerHTML = `<strong>≈ ${data.approxMinutes}</strong><span>min (approx.)</span>`;
    stats.append(playsStat, minutesStat);
    container.appendChild(stats);
  }

  if (isEmpty) {
    const empty = document.createElement("p");
    empty.className = "sidebar-empty";
    empty.textContent = "No listening yet for this range.";
    container.appendChild(empty);
    return;
  }

  if (data.topTracks.length) {
    const heading = document.createElement("p");
    heading.className = "sidebar-heading";
    heading.textContent = "Top songs";
    container.appendChild(heading);
    const list = document.createElement("div");
    list.className = "song-list";
    data.topTracks.forEach((t) => list.appendChild(buildWrappedSongRow(t)));
    container.appendChild(list);
  }

  if (data.topArtists.length) {
    const heading = document.createElement("p");
    heading.className = "sidebar-heading";
    heading.textContent = "Top artists";
    container.appendChild(heading);
    const list = document.createElement("div");
    list.className = "artist-list";
    data.topArtists.forEach((a) => list.appendChild(buildWrappedArtistRow(a)));
    container.appendChild(list);
  }

  if (data.topGenres.length) {
    const heading = document.createElement("p");
    heading.className = "sidebar-heading";
    heading.textContent = "Top genres";
    container.appendChild(heading);
    const list = document.createElement("div");
    list.className = "artist-list";
    data.topGenres.forEach((g) => list.appendChild(buildWrappedGenreRow(g)));
    container.appendChild(list);
  }

  // Same "not yet placed" language as the History tab's unplaced-day bars
  // (renderHistory above) — a play can be logged before genre-resolution.ts
  // gets to its artist, so topGenres/unclassifiedPlays never add up to
  // totalPlays exactly, and that gap shouldn't read as missing data.
  if (data.unclassifiedPlays > 0) {
    const note = document.createElement("p");
    note.className = "activity-source-note";
    note.textContent = `${data.unclassifiedPlays} play${data.unclassifiedPlays === 1 ? "" : "s"} not yet placed in a genre`;
    container.appendChild(note);
  }
}

function renderWrapped(container: HTMLElement): void {
  const rangePicker = document.createElement("div");
  rangePicker.className = "ta-range";
  rangePicker.setAttribute("role", "tablist");
  rangePicker.setAttribute("aria-label", "Wrapped range");
  WRAPPED_RANGES.forEach((range) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ta-range-btn";
    btn.classList.toggle("is-active", range === wrappedRange);
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", String(range === wrappedRange));
    btn.textContent = WRAPPED_RANGE_LABELS[range];
    btn.addEventListener("click", () => {
      if (range === wrappedRange) return;
      wrappedRange = range;
      renderSection("wrapped");
    });
    rangePicker.appendChild(btn);
  });
  container.appendChild(rangePicker);

  loadWrapped(wrappedRange);
  const cached = wrappedCache.get(wrappedRange);

  if (cached === undefined) {
    const loading = document.createElement("p");
    loading.className = "sidebar-empty";
    loading.textContent = "Loading Wrapped…";
    container.appendChild(loading);
    return;
  }
  if (cached === "error") {
    const failed = document.createElement("p");
    failed.className = "sidebar-empty";
    failed.textContent = "Wrapped isn't available right now.";
    container.appendChild(failed);
    return;
  }

  renderWrappedContent(container, cached);
}

// ---------------------------------------------------------------------------
// Playlists (Phase 8.6, first cut — sidebar only; see SPEC.md's Phase 8.6
// note: buildings-on-the-map are deferred, and a playlist merely *followed*
// (not owned or collaborated on) never appears — worker/playlists.ts can't
// get its track content, so it's dropped server-side rather than shown
// half-working). Global, same convention as Wrapped above (deliberately
// ignores ctx.slot) — a playlist isn't scoped to one character's district.
// ---------------------------------------------------------------------------
interface PlaylistOut {
  id: string;
  name: string;
  image: string | null;
  trackCount: number;
  collaborative: boolean;
}
type PlaylistsPayload =
  | { connected: false }
  | { connected: true; live: false; reason: "paused" | "needs-reconnect" }
  | { connected: true; live: true; playlists: PlaylistOut[]; cachedAt: string };

interface PlaylistCastArtist {
  id: string;
  name: string;
  trackCount: number;
}
interface PlaylistCastSlot {
  slotId: string;
  share: number;
  topArtists: PlaylistCastArtist[];
}
type PlaylistDetailPayload =
  | { connected: false }
  // "not-found": worker/playlists.ts returns this when the id isn't in the
  // owner's own filtered playlist list — treated the same as the generic
  // couldn't-load message below (renderPlaylistDetail's `!cached.live`
  // branch), no dedicated copy needed for a case a visitor can't otherwise
  // reach except a stale list (a playlist made private/deleted after the
  // list loaded).
  | { connected: true; live: false; reason: "paused" | "needs-reconnect" | "not-found" }
  | {
      connected: true;
      live: true;
      id: string;
      trackCount: number;
      tracksSeen: number;
      truncated: boolean;
      cast: PlaylistCastSlot[];
      geminiLimited: boolean;
      geminiError: string | null;
      cachedAt: string;
    };

// Which playlist's cast the tab is currently showing, if any — cleared
// (back to the list) whenever a different one is selected or "back" is hit.
let selectedPlaylist: { id: string; name: string; trackCount: number } | null = null;

// Fetched once and reused across opens (same never-auto-retry convention as
// historyDaily/wrappedCache above) — the owner's playlist list doesn't
// change often enough to justify refetching every time this tab is opened.
let playlistsCache: PlaylistsPayload | "error" | undefined;
let playlistsInFlight = false;
const playlistDetailCache = new Map<string, PlaylistDetailPayload | "error">();
const playlistDetailInFlight = new Set<string>();

async function fetchPlaylists(): Promise<PlaylistsPayload | null> {
  try {
    const res = await fetch("/api/playlists");
    if (!res.ok) return null;
    return (await res.json()) as PlaylistsPayload;
  } catch {
    return null;
  }
}

function loadPlaylists(): void {
  if (playlistsCache !== undefined || playlistsInFlight) return;
  playlistsInFlight = true;
  void fetchPlaylists().then((data) => {
    playlistsInFlight = false;
    playlistsCache = data ?? "error";
    if (currentSlot && activeSectionId === "playlists") renderSection("playlists");
  });
}

async function fetchPlaylistDetail(id: string): Promise<PlaylistDetailPayload | null> {
  try {
    const res = await fetch(`/api/playlists/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    return (await res.json()) as PlaylistDetailPayload;
  } catch {
    return null;
  }
}

function loadPlaylistDetail(id: string): void {
  if (playlistDetailCache.has(id) || playlistDetailInFlight.has(id)) return;
  playlistDetailInFlight.add(id);
  void fetchPlaylistDetail(id).then((data) => {
    playlistDetailInFlight.delete(id);
    playlistDetailCache.set(id, data ?? "error");
    if (currentSlot && activeSectionId === "playlists" && selectedPlaylist?.id === id) renderSection("playlists");
  });
}

/** A minimal shape both PlaylistOut (real) and SamplePlaylist (offline)
 * satisfy — the row only ever needs a cover/name/count to render. */
interface PlaylistRowData {
  id: string;
  name: string;
  trackCount: number;
  image?: string | null;
}

function buildPlaylistRow(playlist: PlaylistRowData, onSelect: () => void): HTMLElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "playlist-row";

  const cover = document.createElement("span");
  cover.className = "song-row__cover";
  if (playlist.image) {
    const img = document.createElement("img");
    img.className = "song-row__cover-img";
    img.src = playlist.image;
    img.alt = "";
    img.loading = "lazy";
    cover.appendChild(img);
  } else {
    cover.style.background = coverPlaceholderGradient(playlist.id);
  }

  const info = document.createElement("span");
  info.className = "song-row__info";
  const title = document.createElement("span");
  title.className = "song-row__title";
  title.textContent = playlist.name;
  const meta = document.createElement("span");
  meta.className = "song-row__meta";
  meta.textContent = `${playlist.trackCount} track${playlist.trackCount === 1 ? "" : "s"}`;
  info.append(title, meta);

  row.append(cover, info);
  row.addEventListener("click", onSelect);
  return row;
}

/** One slot's share of a playlist, shown with the same genre-character
 * portrait as the sidebar header (drawPortrait into a small canvas) — reuses
 * .ta-row's layout (art + name/subtitle), same repurposing Wrapped's
 * buildWrappedArtistRow already does for a non-artist row. */
function buildCastRow(cast: { slotId: string; share: number; topArtists: { name: string }[] }): HTMLElement {
  const slot = SLOTS.find((s) => s.district.id === cast.slotId);
  const row = document.createElement("div");
  row.className = "ta-row";

  const art = document.createElement("div");
  art.className = "ta-row__art";
  const portrait = document.createElement("canvas");
  portrait.width = 40;
  portrait.height = 40;
  const pctx = portrait.getContext("2d");
  if (pctx && slot) drawPortrait(pctx, images, slot.character);
  art.appendChild(portrait);

  const meta = document.createElement("div");
  meta.className = "ta-row__meta";
  const name = document.createElement("p");
  name.className = "ta-row__name";
  name.textContent = slot ? slot.character.name : cast.slotId;
  const sub = document.createElement("p");
  sub.className = "ta-row__genres";
  sub.textContent = cast.topArtists.length ? cast.topArtists.map((a) => a.name).join(", ") : "—";
  meta.append(name, sub);

  const share = document.createElement("span");
  share.className = "artist-row__plays";
  share.textContent = `${Math.round(cast.share * 100)}%`;

  row.append(art, meta, share);
  return row;
}

function renderCastList(
  container: HTMLElement,
  cast: { slotId: string; share: number; topArtists: { name: string }[] }[],
  trackCount: number,
  tracksSeen: number,
  truncated: boolean,
): void {
  if (cast.length === 0) {
    const empty = document.createElement("p");
    empty.className = "sidebar-empty";
    empty.textContent = "No tracks placed in a genre yet.";
    container.appendChild(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "artist-list";
  cast.forEach((c) => list.appendChild(buildCastRow(c)));
  container.appendChild(list);

  if (truncated) {
    const note = document.createElement("p");
    note.className = "activity-source-note";
    note.textContent = `Showing the first ${tracksSeen} of ${trackCount} tracks.`;
    container.appendChild(note);
  }
}

function renderPlaylistBack(container: HTMLElement): void {
  const back = document.createElement("button");
  back.type = "button";
  back.className = "playlist-back";
  back.textContent = "← All playlists";
  back.addEventListener("click", () => {
    selectedPlaylist = null;
    renderSection("playlists");
  });
  container.appendChild(back);
}

function renderPlaylistDetail(container: HTMLElement, playlist: { id: string; name: string; trackCount: number }): void {
  renderPlaylistBack(container);

  const heading = document.createElement("p");
  heading.className = "sidebar-heading";
  heading.textContent = playlist.name;
  container.appendChild(heading);

  // Sample playlists carry their cast inline — no fetch, same "sample mode
  // keeps working" rule as every other tab (src/listening-source.ts).
  const sample = getSamplePlaylist(playlist.id);
  if (sample) {
    renderCastList(container, sample.cast, sample.trackCount, sample.trackCount, false);
    return;
  }

  loadPlaylistDetail(playlist.id);
  const cached = playlistDetailCache.get(playlist.id);

  if (cached === undefined) {
    const loading = document.createElement("p");
    loading.className = "sidebar-empty";
    loading.textContent = "Loading cast…";
    container.appendChild(loading);
    return;
  }
  if (cached === "error" || !cached.connected) {
    const failed = document.createElement("p");
    failed.className = "sidebar-empty";
    failed.textContent = "Couldn't load this playlist right now.";
    container.appendChild(failed);
    return;
  }
  if (!cached.live) {
    const msg = document.createElement("p");
    msg.className = "sidebar-empty";
    msg.textContent =
      cached.reason === "needs-reconnect"
        ? "Reconnect Spotify to see this playlist (new permissions needed)."
        : "Live playlist data is paused right now.";
    container.appendChild(msg);
    return;
  }

  renderCastList(container, cached.cast, cached.trackCount, cached.tracksSeen, cached.truncated);

  if (cached.geminiLimited) {
    const note = document.createElement("p");
    note.className = "activity-source-note";
    note.textContent = "Some artists used a lower-confidence genre guess (today's AI limit was reached).";
    container.appendChild(note);
  }
}

function selectPlaylist(playlist: { id: string; name: string; trackCount: number }): void {
  selectedPlaylist = playlist;
  renderSection("playlists");
}

function renderPlaylists(container: HTMLElement): void {
  if (selectedPlaylist) {
    renderPlaylistDetail(container, selectedPlaylist);
    return;
  }

  loadPlaylists();
  const cached = playlistsCache;

  if (cached === undefined) {
    const loading = document.createElement("p");
    loading.className = "sidebar-empty";
    loading.textContent = "Loading playlists…";
    container.appendChild(loading);
    return;
  }
  if (cached === "error") {
    const failed = document.createElement("p");
    failed.className = "sidebar-empty";
    failed.textContent = "Playlists aren't available right now.";
    container.appendChild(failed);
    return;
  }

  // Not connected at all: a couple of handwritten sample playlists (SPEC.md's
  // Phase 8.6 first-cut note) — same "sample mode keeps working" rule as
  // every other tab.
  if (!cached.connected) {
    const list = document.createElement("div");
    list.className = "song-list";
    SAMPLE_PLAYLISTS.forEach((p) => list.appendChild(buildPlaylistRow(p, () => selectPlaylist(p))));
    container.appendChild(list);
    return;
  }

  if (!cached.live) {
    const msg = document.createElement("p");
    msg.className = "sidebar-empty";
    msg.textContent =
      cached.reason === "needs-reconnect"
        ? "Reconnect Spotify to see your playlists (new permissions needed)."
        : "Live playlist data is paused right now.";
    container.appendChild(msg);
    return;
  }

  if (cached.playlists.length === 0) {
    const empty = document.createElement("p");
    empty.className = "sidebar-empty";
    empty.textContent = "No playlists you own or collaborate on yet.";
    container.appendChild(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "song-list";
  cached.playlists.forEach((p) => list.appendChild(buildPlaylistRow(p, () => selectPlaylist(p))));
  container.appendChild(list);
}

// ---------------------------------------------------------------------------
// Weekly brief (Phase 9 — SPEC.md's "Weekly notice board"). One fetch shared
// by two sections: the global Notice board (headline/notes/movers, ignores
// ctx.slot, same convention as Wrapped/Playlists above) and each character's
// per-slot "This week" line (uses ctx.slot, more like Character/History).
// ---------------------------------------------------------------------------
interface WeeklyBriefMoverOut {
  slotId: string;
  playsThisWeek: number;
  playsLastWeek: number;
}
interface WeeklyBriefNewArtistOut {
  id: string;
  name: string;
  slotId: string | null;
  plays: number;
}
interface WeeklyBriefOut {
  weekStart: string;
  headline: string;
  notes: string[];
  slotNotes: Record<string, string>;
  movers: WeeklyBriefMoverOut[];
  topNewArtists: WeeklyBriefNewArtistOut[];
  generatedAt: string;
}
interface WeeklyBriefResponse {
  brief: WeeklyBriefOut | null;
}

// Fetched once and reused across opens (same never-auto-retry convention as
// historyDaily/wrappedCache above) — the brief only ever changes on a
// once-a-week cron write, so there's nothing to gain from refetching every
// time either tab is opened.
let weeklyBriefCache: WeeklyBriefResponse | "error" | undefined;
let weeklyBriefInFlight = false;

async function fetchWeeklyBrief(): Promise<WeeklyBriefResponse | null> {
  try {
    const res = await fetch("/api/weekly-brief");
    if (!res.ok) return null;
    return (await res.json()) as WeeklyBriefResponse;
  } catch {
    return null;
  }
}

function loadWeeklyBrief(): void {
  if (weeklyBriefCache !== undefined || weeklyBriefInFlight) return;
  weeklyBriefInFlight = true;
  void fetchWeeklyBrief().then((data) => {
    weeklyBriefInFlight = false;
    weeklyBriefCache = data ?? "error";
    // If the visitor is still on one of the two brief-fed tabs when this
    // resolves, refresh it in place instead of leaving it on "loading" (same
    // pattern as loadHistoryDaily/loadWrapped above).
    if (currentSlot && (activeSectionId === "notice-board" || activeSectionId === "this-week")) renderSection(activeSectionId);
  });
}

function formatWeekStart(weekStart: string): string {
  const ms = Date.parse(`${weekStart}T00:00:00Z`);
  return Number.isNaN(ms) ? weekStart : formatWrappedDate(ms);
}

function buildMoverRow(mover: WeeklyBriefMoverOut): HTMLElement {
  const row = document.createElement("div");
  row.className = "artist-row";

  const name = document.createElement("span");
  name.className = "artist-row__name";
  name.textContent = slotDisplayName(mover.slotId);

  const delta = mover.playsThisWeek - mover.playsLastWeek;
  const deltaText = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : "±0";
  const plays = document.createElement("span");
  plays.className = "artist-row__plays";
  plays.textContent = `${mover.playsThisWeek} (${deltaText})`;

  row.append(name, plays);
  return row;
}

function buildNewArtistRow(artist: WeeklyBriefNewArtistOut | SampleBriefNewArtist): HTMLElement {
  const row = document.createElement("div");
  row.className = "artist-row";

  const name = document.createElement("span");
  name.className = "artist-row__name";
  name.textContent = artist.slotId ? `${artist.name} · ${slotDisplayName(artist.slotId)}` : artist.name;

  const plays = document.createElement("span");
  plays.className = "artist-row__plays";
  plays.textContent = `${artist.plays} play${artist.plays === 1 ? "" : "s"}`;

  row.append(name, plays);
  return row;
}

/** Shared by the real payload and SAMPLE_BRIEF — both already carry exactly
 * these fields, so the render logic never has to branch beyond "which one
 * did I get". */
interface BriefContent {
  weekStart: string;
  headline: string;
  notes: string[];
  slotNotes: Record<string, string>;
  movers: { slotId: string; playsThisWeek: number; playsLastWeek: number }[];
  topNewArtists: (WeeklyBriefNewArtistOut | SampleBriefNewArtist)[];
}

function renderBriefContent(container: HTMLElement, brief: BriefContent): void {
  const headline = document.createElement("p");
  headline.className = "notice-board-headline";
  headline.textContent = brief.headline;
  container.appendChild(headline);

  const posted = document.createElement("p");
  posted.className = "history-caption";
  posted.textContent = `Week of ${formatWeekStart(brief.weekStart)}`;
  container.appendChild(posted);

  if (brief.notes.length > 0) {
    const list = document.createElement("ul");
    list.className = "character-dialogue";
    brief.notes.forEach((note) => {
      const item = document.createElement("li");
      item.textContent = note;
      list.appendChild(item);
    });
    container.appendChild(list);
  }

  const movers = [...brief.movers].sort((a, b) => Math.abs(b.playsThisWeek - b.playsLastWeek) - Math.abs(a.playsThisWeek - a.playsLastWeek));
  if (movers.length > 0) {
    const heading = document.createElement("p");
    heading.className = "sidebar-heading";
    heading.textContent = "This week vs last";
    container.appendChild(heading);
    const list = document.createElement("div");
    list.className = "artist-list";
    movers.slice(0, 6).forEach((m) => list.appendChild(buildMoverRow(m)));
    container.appendChild(list);
  }

  if (brief.topNewArtists.length > 0) {
    const heading = document.createElement("p");
    heading.className = "sidebar-heading";
    heading.textContent = "New this week";
    container.appendChild(heading);
    const list = document.createElement("div");
    list.className = "artist-list";
    brief.topNewArtists.forEach((a) => list.appendChild(buildNewArtistRow(a)));
    container.appendChild(list);
  }
}

function renderNoticeBoard(container: HTMLElement): void {
  // Sample mode is decided by *connected*, not *live* — the brief is a D1
  // historical read, not a live Spotify poll, so "connected but paused"
  // should still show real (if possibly stale) data, same as Wrapped.
  if (!isVillageConnected()) {
    renderBriefContent(container, SAMPLE_BRIEF);
    return;
  }

  loadWeeklyBrief();
  const cached = weeklyBriefCache;

  if (cached === undefined) {
    const loading = document.createElement("p");
    loading.className = "sidebar-empty";
    loading.textContent = "Loading the notice board…";
    container.appendChild(loading);
    return;
  }
  if (cached === "error" || !cached.brief) {
    const empty = document.createElement("p");
    empty.className = "sidebar-empty";
    empty.textContent = "The notice board is empty — the first brief arrives after a full week of history.";
    container.appendChild(empty);
    return;
  }

  renderBriefContent(container, cached.brief);
}

function renderThisWeek(container: HTMLElement, ctx: SectionContext): void {
  if (!isVillageConnected()) {
    const note = SAMPLE_BRIEF.slotNotes[ctx.slot.district.id];
    if (!note) {
      const empty = document.createElement("p");
      empty.className = "sidebar-empty";
      empty.textContent = "Nothing on the notice board for this district this week.";
      container.appendChild(empty);
      return;
    }
    const p = document.createElement("p");
    p.className = "character-personality";
    p.textContent = note;
    container.appendChild(p);
    return;
  }

  loadWeeklyBrief();
  const cached = weeklyBriefCache;

  if (cached === undefined) {
    const loading = document.createElement("p");
    loading.className = "sidebar-empty";
    loading.textContent = "Loading this week's notes…";
    container.appendChild(loading);
    return;
  }
  if (cached === "error" || !cached.brief) {
    const empty = document.createElement("p");
    empty.className = "sidebar-empty";
    empty.textContent = "No weekly notes yet — the first brief arrives after a full week of history.";
    container.appendChild(empty);
    return;
  }

  const note = cached.brief.slotNotes[ctx.slot.district.id];
  if (!note) {
    const empty = document.createElement("p");
    empty.className = "sidebar-empty";
    empty.textContent = "Nothing on the notice board for this district this week.";
    container.appendChild(empty);
    return;
  }
  const p = document.createElement("p");
  p.className = "character-personality";
  p.textContent = note;
  container.appendChild(p);
}

// ---------------------------------------------------------------------------
// Hokage (Phase 10 — SPEC.md's "Talk to the Hokage"). Global, same
// deliberately-ignores-ctx.slot convention as Wrapped/Playlists/Notice board
// above — a visitor's question isn't scoped to whichever character's header
// happens to be showing. Conversation state lives at module scope (not
// reset on sidebar close/reopen, unlike the Songs filters) so switching tabs
// or characters mid-conversation doesn't lose it — only a full page reload
// does, same "in memory on the client" rule SPEC.md's task calls for.
// ---------------------------------------------------------------------------
interface HokageTurn {
  role: "user" | "model";
  text: string;
}
interface HokageResponse {
  reply: string;
  focusSlots: string[];
  remaining: number;
  limited?: boolean;
}

// Mirrors worker/hokage.ts's own MAX_MESSAGES/QUESTION_DAILY_CAP — kept in
// sync by hand (small, stable constants on both sides) rather than shared
// across the fetch boundary.
const HOKAGE_MAX_HISTORY_TURNS = 8;
const HOKAGE_DAILY_QUESTION_CAP = 10;

const HOKAGE_SUGGESTIONS = [
  "What have I been listening to this week?",
  "Who's my most-played artist lately?",
  "Any brand-new artists I've picked up recently?",
  "Tell me about the Emo/Alt district.",
];

let hokageHistory: HokageTurn[] = [];
// null until the first real response tells us the true count — the input
// row shows HOKAGE_DAILY_QUESTION_CAP itself until then (see renderHokage).
let hokageRemaining: number | null = null;
let hokageBusy = false;
let hokageError = false;
let hokageLimited = false;

async function fetchHokage(messages: HokageTurn[]): Promise<HokageResponse | null> {
  try {
    const res = await fetch("/api/hokage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    if (!res.ok) return null;
    return (await res.json()) as HokageResponse;
  } catch {
    return null;
  }
}

/** Refocuses the chat input after a state change re-renders the tab (the
 * whole panel's DOM is rebuilt each time — see renderSection) — mirrors
 * why renderSongs' controls need rerenderPreservingFocus, but simpler:
 * nothing here re-renders mid-keystroke (typing itself never triggers a
 * render), only on send/receive, and the field is always empty right after
 * one of those, so there's no caret position worth restoring. A no-op while
 * the input is disabled (busy/out of questions) — focus() on a disabled
 * field is silently ignored by the browser anyway. */
function focusHokageInput(): void {
  panelHost.querySelector<HTMLInputElement>(".hokage-input")?.focus();
}

function sendHokageMessage(rawText: string): void {
  const text = rawText.trim();
  if (!text || hokageBusy) return;

  hokageHistory.push({ role: "user", text });
  hokageBusy = true;
  hokageError = false;
  hokageLimited = false;
  renderSection("hokage");
  focusHokageInput();

  if (!isVillageConnected()) {
    // Sample mode: one scripted reply, no network call (SAMPLE_BRIEF's
    // convention) — see src/sample-data.ts's SAMPLE_HOKAGE_REPLY doc comment.
    hokageHistory.push({ role: "model", text: SAMPLE_HOKAGE_REPLY.reply });
    hokageBusy = false;
    renderSection("hokage");
    focusHokageInput();
    hooks.onFocusSlot(SAMPLE_HOKAGE_REPLY.focusSlot);
    return;
  }

  const sent = hokageHistory.slice(-HOKAGE_MAX_HISTORY_TURNS);
  void fetchHokage(sent).then((data) => {
    hokageBusy = false;
    if (!data) {
      hokageError = true;
      renderSection("hokage");
      focusHokageInput();
      return;
    }
    hokageHistory.push({ role: "model", text: data.reply });
    hokageRemaining = data.remaining;
    hokageLimited = Boolean(data.limited);
    renderSection("hokage");
    focusHokageInput();
    if (data.focusSlots.length > 0) hooks.onFocusSlot(data.focusSlots[0]!);
  });
}

function buildHokageBubble(turn: HokageTurn): HTMLElement {
  const bubble = document.createElement("div");
  bubble.className = `hokage-bubble hokage-bubble--${turn.role}`;
  bubble.textContent = turn.text;
  return bubble;
}

function renderHokage(container: HTMLElement): void {
  container.classList.add("hokage-panel");

  const log = document.createElement("div");
  log.className = "hokage-log";
  if (hokageHistory.length === 0) {
    const intro = document.createElement("p");
    intro.className = "sidebar-empty";
    intro.textContent = "Ask the Hokage anything about your listening.";
    log.appendChild(intro);
  } else {
    hokageHistory.forEach((turn) => log.appendChild(buildHokageBubble(turn)));
  }
  if (hokageBusy) {
    const thinking = document.createElement("div");
    thinking.className = "hokage-bubble hokage-bubble--model hokage-bubble--thinking";
    thinking.textContent = "The Hokage is thinking…";
    log.appendChild(thinking);
  }
  if (hokageError) {
    const err = document.createElement("p");
    err.className = "hokage-note hokage-note--error";
    err.textContent = "Couldn't reach the Hokage just now — try again in a moment.";
    log.appendChild(err);
  }
  container.appendChild(log);

  if (hokageHistory.length === 0) {
    const chips = document.createElement("div");
    chips.className = "hokage-chips";
    HOKAGE_SUGGESTIONS.forEach((q) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "hokage-chip";
      chip.textContent = q;
      chip.addEventListener("click", () => sendHokageMessage(q));
      chips.appendChild(chip);
    });
    container.appendChild(chips);
  }

  if (hokageLimited) {
    const limited = document.createElement("p");
    limited.className = "hokage-note hokage-note--limited";
    limited.textContent = "The Hokage needs to rest — full answers will return soon.";
    container.appendChild(limited);
  }

  const remainingValue = hokageRemaining ?? HOKAGE_DAILY_QUESTION_CAP;
  const remainingLine = document.createElement("p");
  remainingLine.className = "hokage-remaining";
  remainingLine.textContent = `${remainingValue} question${remainingValue === 1 ? "" : "s"} left today`;
  container.appendChild(remainingLine);

  const disabled = hokageBusy || remainingValue <= 0;
  const form = document.createElement("form");
  form.className = "hokage-inputrow";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "hokage-input";
  input.placeholder = remainingValue <= 0 ? "Come back tomorrow…" : "Ask the Hokage…";
  input.maxLength = 500;
  input.disabled = disabled;
  input.setAttribute("aria-label", "Ask the Hokage a question");

  const send = document.createElement("button");
  send.type = "submit";
  send.className = "hokage-send";
  send.textContent = "Send";
  send.disabled = disabled;

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    sendHokageMessage(input.value);
  });

  form.append(input, send);
  container.appendChild(form);

  log.scrollTop = log.scrollHeight;
}

const SECTIONS: Section[] = [
  { id: "overview", label: "Overview", render: renderOverview },
  { id: "songs", label: "Songs", render: renderSongs },
  { id: "artists", label: "Artists", render: renderArtists },
  { id: "character", label: "Character", render: renderCharacter },
  { id: "history", label: "History", render: renderHistory },
  // Per-slot, like Character/History above (SPEC.md's Phase 9).
  { id: "this-week", label: "This week", render: renderThisWeek },
  // Global — deliberately ignores `ctx.slot` (SPEC.md's Phase 8.5: this is
  // the listener's whole Wrapped, not filtered to whichever character's
  // sidebar happens to be open).
  { id: "wrapped", label: "Wrapped", render: (container) => renderWrapped(container) },
  // Global, same reason as Wrapped above (SPEC.md's Phase 8.6).
  { id: "playlists", label: "Playlists", render: (container) => renderPlaylists(container) },
  // Global, same reason as Wrapped/Playlists above (SPEC.md's Phase 9) — the
  // village's notice board marker (src/main.ts) opens straight to this tab.
  { id: "notice-board", label: "Notice board", render: (container) => renderNoticeBoard(container) },
  // Global, same reason as Wrapped/Playlists/Notice board above (SPEC.md's
  // Phase 10) — a visitor's question isn't scoped to one character either.
  { id: "hokage", label: "Hokage", render: (container) => renderHokage(container) },
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

/** One dialogue line to show in the header's info card — picked at random
 * each time the sidebar opens for this slot (flavor text, not data a
 * visitor would ever need to compare across opens), null if the slot has no
 * persona yet. */
function pickDialogueLine(persona: Persona | null): string | null {
  if (!persona || persona.dialogue.length === 0) return null;
  const i = Math.floor(Math.random() * persona.dialogue.length);
  return persona.dialogue[i] ?? null;
}

function renderHeader(slot: Slot): void {
  const portraitCtx = portraitCanvas.getContext("2d");
  if (portraitCtx) drawPortrait(portraitCtx, images, slot.character);
  nameEl.textContent = slot.character.name;
  genrePill.textContent = slot.district.genre;
  locationEl.textContent = slot.district.location;

  // Phase 7b: a line of this character's dialogue (worker/persona.ts / the
  // sample-data fallback), shown right in the header so it's visible the
  // instant the sidebar opens — before a visitor even reaches the Character
  // tab below. Hidden entirely rather than left blank when there's none.
  const line = pickDialogueLine(getPersona(slot.district.id));
  dialogueEl.textContent = line ? `“${line}”` : "";
  dialogueEl.hidden = !line;
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
  dialogueEl = document.createElement("p");
  dialogueEl.className = "sidebar__dialogue";
  headerText.append(nameEl, meta, dialogueEl);

  enterBtn = document.createElement("button");
  enterBtn.type = "button";
  enterBtn.className = "sidebar__enter";
  enterBtn.textContent = "Enter district";
  enterBtn.addEventListener("click", () => {
    if (currentSlot) hooks.onEnterDistrict(currentSlot.district.id);
  });

  header.append(portraitCanvas, headerText, enterBtn);

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

  // Phase 3.5: the official Spotify logo (public/brand/spotify-logo-white.png,
  // downloaded from Spotify's own press assets — see SPEC.md's Phase 3.5
  // section), placed once here in the sidebar chrome rather than per song
  // row, per SPEC.md's cover-art attribution rules. The logo is a white
  // asset, so on the mission-scroll paper ground it sits on a small dark
  // plate (.sidebar__spotify-badge) instead — same asset, unmodified, just
  // given a background it stays legible on.
  const footer = document.createElement("div");
  footer.className = "sidebar__footer";
  const footerLabel = document.createElement("span");
  footerLabel.textContent = "Data from";
  const footerBadge = document.createElement("span");
  footerBadge.className = "sidebar__spotify-badge";
  const footerLogo = document.createElement("img");
  footerLogo.className = "sidebar__spotify-logo";
  footerLogo.src = "/brand/spotify-logo-white.png";
  footerLogo.alt = "Spotify";
  footerLogo.width = 78;
  footerLogo.height = 23;
  footerBadge.appendChild(footerLogo);
  footer.append(footerLabel, footerBadge);

  root.append(grabber, closeBtn, header, tablistEl, panelHost, footer);
  backdrop.addEventListener("click", () => close());

  loadHistoryDaily();
}

export function openSidebar(slot: Slot, opts: OpenSidebarOptions = {}): void {
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
  if (opts.filterArtist !== undefined) {
    songsArtistFilter = opts.filterArtist;
    songsSearch = "";
    songsAlbumFilter = "";
  }
  if (isFirstOpen) activeSectionId = "overview";
  if (opts.section) activeSectionId = opts.section;
  enterBtn.hidden = !opts.showEnter;
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

/** Re-renders whichever section is currently showing, if the sidebar is
 * open — used by main.ts's era-change subscription so an open panel doesn't
 * keep showing the previous era's activity/artists/songs after
 * src/listening-source.ts's village data has already moved on. A no-op if
 * the sidebar is closed (nothing to refresh). */
export function refreshSidebarContent(): void {
  if (!currentSlot) return;
  // Phase 8b: an era change can fetch an entirely different artist roster —
  // if the Songs tab's artist filter (an id, set from a resident/artist row
  // tap — see renderSongs's synthetic-option comment above) no longer
  // exists in the new era, drop it. Left alone, the control would silently
  // reset its *displayed* value to "All artists" while songsArtistFilter
  // stayed pointed at the vanished id, filtering the list down to nothing
  // with no visible way to clear it.
  if (songsArtistFilter && !getArtists(currentSlot.district.id).some((a) => a.id === songsArtistFilter)) {
    songsArtistFilter = "";
  }
  renderSection(activeSectionId);
}
