// Echoes — Phase 1 entry point. Wires together the district, roster, and
// whole-village views on top of hard-coded sample listening data.
// Ported from prototypes/konoha-demo/main.js.

import "./style.css";
import type { Point } from "../data/types";
import { ASSET_MANIFEST, SLOTS, VILLAGE, assetUrl } from "../data/loader";
import { getListening, pickWeightedSlotId, type SlotListening } from "./sample-data";
import { makeNpc, setCaption, startPerform, updateNpc, type Direction, type Npc } from "./npc";
import { drawNpc, getWalkFrames, hitTestNpc, loadImages, type ImageMap } from "./render";

const NOW_PLAYING_INTERVAL_MS = 8000;
const VILLAGE_EVENT_INTERVAL_MS = 5000;
const DESKTOP_QUERY = "(min-width: 720px)";
const MAX_INTEGER_SCALE = 4;
const DIRS: Direction[] = ["down", "left", "up", "right"];

type Mode = "district" | "roster" | "village";

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id} in index.html`);
  return found as T;
}

const canvas = el<HTMLCanvasElement>("game");
const ctx2d = canvas.getContext("2d");
if (!ctx2d) throw new Error("Canvas 2D context unavailable");
// Re-bound with an explicit (non-nullable) type: narrowing a `const` from a
// null check doesn't carry into functions declared further down the file.
const ctx: CanvasRenderingContext2D = ctx2d;
ctx.imageSmoothingEnabled = false;

const stageArea = el<HTMLDivElement>("stageArea");
const stageWrap = el<HTMLDivElement>("stageWrap");
const recolorNote = el<HTMLParagraphElement>("recolorNote");
const villageCaption = el<HTMLParagraphElement>("villageCaption");
const roster = el<HTMLDivElement>("roster");
const districtToolbar = el<HTMLDivElement>("districtToolbar");
const districtGenre = el<HTMLSpanElement>("districtGenre");
const districtName = el<HTMLSpanElement>("districtName");
const prevBtn = el<HTMLButtonElement>("prevBtn");
const nextBtn = el<HTMLButtonElement>("nextBtn");
const viewTabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".view-tab"));

const card = el<HTMLDivElement>("card");
const cardBackdrop = el<HTMLDivElement>("cardBackdrop");
const cardClose = el<HTMLButtonElement>("cardClose");
const cardName = el<HTMLHeadingElement>("cardName");
const cardGenre = el<HTMLSpanElement>("cardGenre");
const cardLocation = el<HTMLSpanElement>("cardLocation");
const cardNowPlaying = el<HTMLParagraphElement>("cardNowPlaying");
const cardActivity = el<HTMLParagraphElement>("cardActivity");
const cardArtists = el<HTMLDivElement>("cardArtists");
const cardNote = el<HTMLParagraphElement>("cardNote");

let images: ImageMap = {};
let mode: Mode = "district";
let currentIdx = 0;
let currentNativeWidth = SLOTS[0]!.district.bgSize[0];

const districtNpcs: Npc[] = SLOTS.map((slot) => makeNpc(slot.character, slot.district));

const villageNpcs: Npc[] = SLOTS.map((slot, i) => {
  const anchor = VILLAGE.anchors[i % VILLAGE.anchors.length]!;
  const offset = i >= VILLAGE.anchors.length ? 34 : 0;
  const home: Point = { x: anchor[0] + offset, y: anchor[1] + (offset ? 12 : 0) };
  const patrol: Point[] = [
    home,
    { x: home.x - 30, y: home.y - 15 },
    { x: home.x + 30, y: home.y + 10 },
    { x: home.x - 10, y: home.y + 25 },
  ];
  const npc = makeNpc(slot.character, slot.district, home, patrol);
  npc.x = home.x;
  npc.y = home.y;
  return npc;
});

function isDesktop(): boolean {
  return window.matchMedia(DESKTOP_QUERY).matches;
}

/** Fits the stage to the available width, preferring an integer multiple of
 * the map's native pixel width so the pixel art stays crisp. Falls back to a
 * fractional fit (never cropping) on screens narrower than the native size. */
function computeStageWidthPx(nativeW: number, available: number): number {
  if (available <= nativeW) return Math.max(1, Math.floor(available));
  const scale = Math.min(MAX_INTEGER_SCALE, Math.floor(available / nativeW));
  return nativeW * Math.max(1, scale);
}

function fitStage(nativeW: number): void {
  const available = stageArea.clientWidth;
  stageWrap.style.width = `${computeStageWidthPx(nativeW, available)}px`;
}

function setCanvasSize(w: number, h: number): void {
  canvas.width = w;
  canvas.height = h;
  currentNativeWidth = w;
  fitStage(w);
}

function applyDistrict(i: number): void {
  currentIdx = ((i % SLOTS.length) + SLOTS.length) % SLOTS.length;
  const { character, district } = SLOTS[currentIdx]!;
  setCanvasSize(district.bgSize[0], district.bgSize[1]);
  districtGenre.textContent = district.genre;
  districtName.textContent = character.name;
  recolorNote.hidden = !district.recolored;
  if (district.recolored) recolorNote.textContent = "Recolored from Konoha Village.";
  hideCard();
}

function setMode(next: Mode): void {
  mode = next;
  viewTabs.forEach((btn) => btn.classList.toggle("is-active", btn.dataset.view === mode));
  districtToolbar.hidden = mode !== "district";
  villageCaption.hidden = mode !== "village";
  stageArea.hidden = mode === "roster";
  roster.hidden = mode !== "roster";
  recolorNote.hidden = true; // re-shown by applyDistrict() below when relevant
  hideCard();

  if (mode === "village") {
    setCanvasSize(VILLAGE.mapSize[0], VILLAGE.mapSize[1]);
  } else if (mode === "district") {
    applyDistrict(currentIdx);
  }
}

// ---------------------------------------------------------------------------
// Roster: a lightweight animated preview grid, independent of the NPC state
// machine (each cell just cycles through walk directions and a special pose).
// ---------------------------------------------------------------------------
interface RosterCell {
  character: (typeof SLOTS)[number]["character"];
  ctx: CanvasRenderingContext2D;
  offset: number;
}
const rosterCells: RosterCell[] = [];

function buildRoster(): void {
  SLOTS.forEach((slot, i) => {
    const cell = document.createElement("div");
    cell.className = "rcell";

    const preview = document.createElement("canvas");
    preview.width = 64;
    preview.height = 64;

    const genreLabel = document.createElement("span");
    genreLabel.className = "rcell__genre";
    genreLabel.textContent = slot.district.genre;

    const nameLabel = document.createElement("span");
    nameLabel.className = "rcell__name";
    nameLabel.textContent = slot.character.name;

    cell.append(preview, genreLabel, nameLabel);
    cell.addEventListener("click", () => {
      setMode("district");
      applyDistrict(i);
    });
    roster.appendChild(cell);

    const cellCtx = preview.getContext("2d");
    if (!cellCtx) return;
    cellCtx.imageSmoothingEnabled = false;
    rosterCells.push({ character: slot.character, ctx: cellCtx, offset: Math.random() * 6 });
  });
}

function renderRoster(ts: number): void {
  const t = ts / 1000;
  rosterCells.forEach(({ character, ctx: cellCtx, offset }) => {
    const lt = t + offset;
    const cycle = lt % 8;
    let img: HTMLImageElement;
    let rect: [number, number, number, number];

    if (cycle > 6.5) {
      img = images[character.battleSheet]!;
      const idx = Math.floor((cycle - 6.5) / 0.45) % character.specials.length;
      rect = character.specials[idx] ?? character.idle;
    } else {
      img = images[character.sheet]!;
      const dir = DIRS[Math.floor(cycle / 1.625) % 4]!;
      const frames = getWalkFrames(character.anims, dir);
      rect = frames[Math.floor(lt * character.fps) % frames.length] ?? character.idle;
    }

    const [sx, sy, ex, ey] = rect;
    const sw = ex - sx;
    const sh = ey - sy;
    const k = Math.min(1, 60 / sw, 60 / sh);
    cellCtx.clearRect(0, 0, 64, 64);
    cellCtx.drawImage(
      img,
      sx,
      sy,
      sw,
      sh,
      Math.round(32 - (sw * k) / 2),
      Math.round(62 - sh * k),
      sw * k,
      sh * k,
    );
  });
}

// ---------------------------------------------------------------------------
// District view
// ---------------------------------------------------------------------------
function renderDistrict(): void {
  const { district } = SLOTS[currentIdx]!;
  const npc = districtNpcs[currentIdx]!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  if (district.recolorFilter) ctx.filter = district.recolorFilter;
  ctx.drawImage(images[district.bg]!, 0, 0);
  ctx.restore();

  if (district.recolorFilter) ctx.filter = district.recolorFilter;
  drawNpc(ctx, images, npc, canvas.width);
  ctx.filter = "none";
}

// ---------------------------------------------------------------------------
// Whole-village view — every character together on the Konoha map. Which
// character performs next is picked by sample listening share, so busier
// slots show up more often (see src/sample-data.ts).
// ---------------------------------------------------------------------------
let lastVillageEvent = 0;

function tickVillage(now: number, dt: number): void {
  if (now - lastVillageEvent > VILLAGE_EVENT_INTERVAL_MS) {
    lastVillageEvent = now;
    const slotId = pickWeightedSlotId();
    const npc = villageNpcs.find((n) => n.district.id === slotId);
    if (npc && (npc.state === "idle" || npc.state === "walk")) {
      setCaption(npc, `Now playing: ${npc.district.artist} – ${npc.district.song}`, 3.2);
      startPerform(npc, "idle");
    }
  }
  villageNpcs.forEach((npc) =>
    updateNpc(npc, dt, now, { isActive: false, nowPlayingIntervalMs: Number.POSITIVE_INFINITY }),
  );
}

function renderVillage(): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(images[VILLAGE.mapImage]!, 0, 0);
  const sorted = [...villageNpcs].sort((a, b) => a.y - b.y);
  sorted.filter((n) => !n.caption).forEach((n) => drawNpc(ctx, images, n, canvas.width));
  sorted.filter((n) => n.caption).forEach((n) => drawNpc(ctx, images, n, canvas.width));
}

// ---------------------------------------------------------------------------
// Info card (bottom sheet on phones, popover on desktop)
// ---------------------------------------------------------------------------
function describeState(npc: Npc): string {
  switch (npc.state) {
    case "idle":
    case "walk":
      return "Wandering the district.";
    case "traveling_home":
    case "performing":
    case "traveling_back":
      return "Performing right now.";
  }
}

function renderArtists(listening: SlotListening | undefined): void {
  cardArtists.innerHTML = "";

  if (!listening || listening.topArtists.length === 0) {
    const empty = document.createElement("p");
    empty.className = "sheet__share-label";
    empty.textContent = "No plays yet — this district is quiet.";
    cardArtists.appendChild(empty);
    return;
  }

  const heading = document.createElement("p");
  heading.className = "sheet__artists-heading";
  heading.textContent = "Top artists";
  cardArtists.appendChild(heading);

  listening.topArtists.forEach((artist) => {
    const row = document.createElement("div");
    row.className = "sheet__artist-row";
    const name = document.createElement("span");
    name.className = "sheet__artist-name";
    name.textContent = artist.name;
    const plays = document.createElement("span");
    plays.className = "sheet__artist-plays";
    plays.textContent = `${artist.plays} plays`;
    row.append(name, plays);
    cardArtists.appendChild(row);
  });

  const track = document.createElement("div");
  track.className = "sheet__share-track";
  const fill = document.createElement("div");
  fill.className = "sheet__share-fill";
  fill.style.width = `${Math.round(listening.playShare * 100)}%`;
  track.appendChild(fill);

  const shareLabel = document.createElement("p");
  shareLabel.className = "sheet__share-label";
  shareLabel.textContent = `${Math.round(listening.playShare * 100)}% of plays`;

  cardArtists.append(track, shareLabel);
}

function showCard(npc: Npc, canvasRect: DOMRect): void {
  const { character, district } = npc;
  cardName.textContent = character.name;
  cardGenre.textContent = district.genre;
  cardLocation.textContent = district.location;
  cardNowPlaying.innerHTML = `Now playing: <em>${district.artist} – ${district.song}</em>`;
  cardActivity.textContent = describeState(npc);
  renderArtists(getListening(district.id));

  cardNote.hidden = !district.note;
  if (district.note) cardNote.textContent = district.note;

  card.classList.add("is-open");
  card.setAttribute("aria-hidden", "false");

  if (isDesktop()) {
    const stageRect = stageArea.getBoundingClientRect();
    const scaleK = canvasRect.width / canvas.width;
    const anchorX = canvasRect.left + npc.x * scaleK - stageRect.left;
    const anchorY = canvasRect.top + (npc.y - 60) * scaleK - stageRect.top;
    const cardWidth = card.offsetWidth || 280;
    const left = Math.max(8, Math.min(stageRect.width - cardWidth - 8, anchorX - cardWidth / 2));
    card.style.left = `${left}px`;
    card.style.top = `${Math.max(8, anchorY)}px`;
  } else {
    card.style.left = "";
    card.style.top = "";
    cardBackdrop.classList.add("is-open");
  }
}

function hideCard(): void {
  card.classList.remove("is-open");
  card.setAttribute("aria-hidden", "true");
  cardBackdrop.classList.remove("is-open");
}

canvas.addEventListener("click", (ev) => {
  const rect = canvas.getBoundingClientRect();
  const wx = (ev.clientX - rect.left) * (canvas.width / rect.width);
  const wy = (ev.clientY - rect.top) * (canvas.height / rect.height);

  const pool: Npc[] =
    mode === "village" ? villageNpcs : mode === "district" ? [districtNpcs[currentIdx]!] : [];
  const hit = pool.find((npc) => hitTestNpc(npc, wx, wy));

  if (hit) showCard(hit, rect);
  else hideCard();
});

cardClose.addEventListener("click", hideCard);
cardBackdrop.addEventListener("click", hideCard);
prevBtn.addEventListener("click", () => applyDistrict(currentIdx - 1));
nextBtn.addEventListener("click", () => applyDistrict(currentIdx + 1));

viewTabs.forEach((btn) => {
  btn.addEventListener("click", () => {
    const next = btn.dataset.view as Mode | undefined;
    if (next) setMode(next);
  });
});

window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    hideCard();
    return;
  }
  if (mode !== "district") return;
  if (ev.key === "ArrowLeft") applyDistrict(currentIdx - 1);
  else if (ev.key === "ArrowRight") applyDistrict(currentIdx + 1);
});

window.addEventListener("resize", () => fitStage(currentNativeWidth));
window.addEventListener("orientationchange", () => fitStage(currentNativeWidth));

// ---------------------------------------------------------------------------
// Main loop — district NPCs keep wandering in the background regardless of
// the active view, so switching back to a district preserves its state.
// ---------------------------------------------------------------------------
let lastTs: number | null = null;

function frame(ts: number): void {
  if (lastTs === null) lastTs = ts;
  const dt = Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;

  districtNpcs.forEach((npc, i) =>
    updateNpc(npc, dt, ts, {
      isActive: mode === "district" && i === currentIdx,
      nowPlayingIntervalMs: NOW_PLAYING_INTERVAL_MS,
    }),
  );

  if (mode === "village") {
    tickVillage(ts, dt);
    renderVillage();
  } else if (mode === "roster") {
    renderRoster(ts);
  } else {
    renderDistrict();
  }

  requestAnimationFrame(frame);
}

const urlsByKey = Object.fromEntries(
  Object.keys(ASSET_MANIFEST).map((key) => [key, assetUrl(key)]),
);

loadImages(urlsByKey).then((loaded) => {
  images = loaded;
  buildRoster();
  setMode("district");
  requestAnimationFrame(frame);
});
