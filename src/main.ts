// Echoes — Phase 1 entry point. Wires together the whole-village view
// (default), single-district view, and the all-characters roster on top of
// hard-coded sample listening data. Ported from prototypes/konoha-demo/main.js.

import "./style.css";
import type { Point } from "../data/types";
import { ASSET_MANIFEST, SLOTS, VILLAGE, assetSize, assetUrl, getSlot } from "../data/loader";
import { getListening, nowPlayingSong, pickWeightedSlotId } from "./sample-data";
import {
  makeNpc,
  setCaption,
  startPerform,
  updateNpc,
  type Direction,
  type Npc,
  type NowPlayingInfo,
} from "./npc";
import { drawNpc, drawSelectionRing, getWalkFrames, hitTestNpc, loadImages, type ImageMap } from "./render";
import { bakeRecolor } from "./recolor";
import {
  close as closeSidebar,
  initSidebar,
  isSidebarOpen,
  openSidebar,
  setSidebarImages,
  sidebarSlotId,
} from "./sidebar";

const NOW_PLAYING_INTERVAL_MS = 8000;
const VILLAGE_EVENT_INTERVAL_MS = 5000;
const DESKTOP_QUERY = "(min-width: 900px)";
const ZOOM_PHONE = 2;
const ZOOM_DESKTOP = 3;
const PAN_KEY_SPEED = 260; // world px/sec for arrow-key panning in village view
const DRAG_THRESHOLD = 6; // css px before a pointer-down counts as a drag, not a tap
const DIRS: Direction[] = ["down", "left", "up", "right"];

type Mode = "village" | "district" | "roster";

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

const stageArea = el<HTMLDivElement>("stageArea");
const recolorNote = el<HTMLParagraphElement>("recolorNote");
const villageCaption = el<HTMLParagraphElement>("villageCaption");
const roster = el<HTMLDivElement>("roster");
const districtToolbar = el<HTMLDivElement>("districtToolbar");
const districtGenre = el<HTMLSpanElement>("districtGenre");
const districtName = el<HTMLSpanElement>("districtName");
const prevBtn = el<HTMLButtonElement>("prevBtn");
const nextBtn = el<HTMLButtonElement>("nextBtn");
const viewTabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".view-tab"));

const sidebarRoot = el<HTMLElement>("sidebar");
const sidebarBackdrop = el<HTMLDivElement>("sidebarBackdrop");
initSidebar(sidebarRoot, sidebarBackdrop, { onClose: () => canvas.focus() });

let images: ImageMap = {};
let mode: Mode = "village"; // default view: the whole village, everyone present
let currentIdx = 0; // which district src/roster navigation currently points at

const districtNpcs: Npc[] = SLOTS.map((slot) => makeNpc(slot.character, slot.district));

const villageNpcs: Npc[] = SLOTS.map((slot) => {
  const anchor = VILLAGE.anchors[slot.character.id];
  if (!anchor) throw new Error(`village.json has no anchor for "${slot.character.id}"`);
  const patrol: Point[] = [
    anchor,
    { x: anchor.x - 30, y: anchor.y - 15 },
    { x: anchor.x + 30, y: anchor.y + 10 },
    { x: anchor.x - 10, y: anchor.y + 25 },
  ];
  const npc = makeNpc(slot.character, slot.district, anchor, patrol);
  npc.x = anchor.x;
  npc.y = anchor.y;
  return npc;
});

function getNowPlayingFor(slotId: string): NowPlayingInfo | null {
  const song = nowPlayingSong(getListening(slotId));
  return song ? { artist: song.artist, song: song.title } : null;
}

// Pre-baked recolored copies of a district's bg/sheet/battleSheet, built once
// after images load (see bakeRecolors) instead of calling ctx.filter per frame.
const recoloredImagesByDistrict = new Map<string, ImageMap>();

function bakeRecolors(): void {
  for (const { character, district } of SLOTS) {
    if (!district.recolorFilter) continue;
    const overrides: ImageMap = { ...images };
    const bg = images[district.bg];
    if (bg instanceof HTMLImageElement) overrides[district.bg] = bakeRecolor(bg, district.recolorFilter);
    const sheet = images[character.sheet];
    if (sheet instanceof HTMLImageElement) {
      overrides[character.sheet] = bakeRecolor(sheet, district.recolorFilter);
    }
    const battle = images[character.battleSheet];
    if (battle instanceof HTMLImageElement) {
      overrides[character.battleSheet] = bakeRecolor(battle, district.recolorFilter);
    }
    recoloredImagesByDistrict.set(district.id, overrides);
  }
}

// ---------------------------------------------------------------------------
// Camera: canvas backing size = container size / integer zoom, so the
// browser's own upscaling (image-rendering: pixelated) lands on exact pixels.
// Drawing happens in world space with ctx.translate(-camX, -camY), clamped to
// map bounds so the camera never shows outside the art.
// ---------------------------------------------------------------------------
let camX = 0;
let camY = 0;
let mapW = 1;
let mapH = 1;
let viewW = 1;
let viewH = 1;

function isDesktop(): boolean {
  return window.matchMedia(DESKTOP_QUERY).matches;
}

function currentZoom(): number {
  return isDesktop() ? ZOOM_DESKTOP : ZOOM_PHONE;
}

function clampAxis(cam: number, size: number, view: number): number {
  if (size <= view) return (size - view) / 2;
  return Math.max(0, Math.min(size - view, cam));
}

function clampCamera(): void {
  camX = clampAxis(camX, mapW, viewW);
  camY = clampAxis(camY, mapH, viewH);
}

function setMapSize(key: string): void {
  const [w, h] = assetSize(key);
  mapW = w;
  mapH = h;
}

/** Resizes the canvas's backing store to an integer fraction of its
 * container, then re-stretches it via CSS to an exact integer multiple —
 * never a fractional scale, and never larger than the container (no crop). */
function fitCanvas(): void {
  const zoom = currentZoom();
  const rect = stageArea.getBoundingClientRect();
  const availW = Math.max(zoom, Math.floor(rect.width));
  const availH = Math.max(zoom, Math.floor(rect.height));
  viewW = Math.max(1, Math.floor(availW / zoom));
  viewH = Math.max(1, Math.floor(availH / zoom));
  canvas.width = viewW;
  canvas.height = viewH;
  canvas.style.width = `${viewW * zoom}px`;
  canvas.style.height = `${viewH * zoom}px`;
  ctx.imageSmoothingEnabled = false;
  clampCamera();
}

function centerCamera(): void {
  camX = (mapW - viewW) / 2;
  camY = (mapH - viewH) / 2;
  clampCamera();
}

function screenToWorld(clientX: number, clientY: number): Point {
  const rect = canvas.getBoundingClientRect();
  const zoom = currentZoom();
  return { x: (clientX - rect.left) / zoom + camX, y: (clientY - rect.top) / zoom + camY };
}

// ---------------------------------------------------------------------------
// Mode / district switching
// ---------------------------------------------------------------------------
function applyDistrict(i: number): void {
  currentIdx = ((i % SLOTS.length) + SLOTS.length) % SLOTS.length;
  const { character, district } = SLOTS[currentIdx]!;
  setMapSize(district.bg);
  fitCanvas();
  const npc = districtNpcs[currentIdx]!;
  camX = clampAxis(npc.x - viewW / 2, mapW, viewW);
  camY = clampAxis(npc.y - viewH / 2, mapH, viewH);
  districtGenre.textContent = district.genre;
  districtName.textContent = character.name;
  recolorNote.hidden = !district.recolored;
  if (district.recolored) recolorNote.textContent = "Recolored from Konoha Village.";
}

function followActiveDistrictNpc(dt: number): void {
  const npc = districtNpcs[currentIdx]!;
  const targetX = clampAxis(npc.x - viewW / 2, mapW, viewW);
  const targetY = clampAxis(npc.y - viewH / 2, mapH, viewH);
  const t = Math.min(1, dt * 4);
  camX += (targetX - camX) * t;
  camY += (targetY - camY) * t;
}

function setMode(next: Mode): void {
  mode = next;
  viewTabs.forEach((btn) => btn.classList.toggle("is-active", btn.dataset.view === mode));
  districtToolbar.hidden = mode !== "district";
  villageCaption.hidden = mode !== "village";
  stageArea.hidden = mode === "roster";
  roster.hidden = mode !== "roster";
  recolorNote.hidden = true; // re-shown by applyDistrict() below when relevant

  if (mode === "village") {
    setMapSize(VILLAGE.mapImage);
    fitCanvas();
    centerCamera();
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
    let img: HTMLImageElement | HTMLCanvasElement;
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
  const imgs = (district.recolorFilter && recoloredImagesByDistrict.get(district.id)) || images;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(-camX, -camY);
  ctx.drawImage(imgs[district.bg]!, 0, 0);
  if (sidebarSlotId() === district.id) drawSelectionRing(ctx, npc);
  drawNpc(ctx, imgs, npc, mapW);
  ctx.restore();
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
    const info = getNowPlayingFor(slotId);
    if (npc && info && (npc.state === "idle" || npc.state === "walk")) {
      setCaption(npc, `Now playing: ${info.artist} – ${info.song}`, 3.2);
      startPerform(npc, "idle");
    }
  }
  villageNpcs.forEach((npc) =>
    updateNpc(npc, dt, now, {
      isActive: false,
      nowPlayingIntervalMs: Number.POSITIVE_INFINITY,
      getNowPlaying: () => getNowPlayingFor(npc.district.id),
    }),
  );
}

function renderVillage(): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(-camX, -camY);
  ctx.drawImage(images[VILLAGE.mapImage]!, 0, 0);

  const sorted = [...villageNpcs].sort((a, b) => a.y - b.y);
  const selected = sidebarSlotId();
  if (selected) {
    const selectedNpc = sorted.find((n) => n.district.id === selected);
    if (selectedNpc) drawSelectionRing(ctx, selectedNpc);
  }
  sorted.filter((n) => !n.caption).forEach((n) => drawNpc(ctx, images, n, mapW));
  sorted.filter((n) => n.caption).forEach((n) => drawNpc(ctx, images, n, mapW));
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Pointer input: drag-to-pan (village only) and tap-to-open-sidebar (village
// + district). A short drag threshold tells a pan apart from a tap.
// ---------------------------------------------------------------------------
interface DragState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startCamX: number;
  startCamY: number;
  moved: boolean;
}
let drag: DragState | null = null;

function handleTap(clientX: number, clientY: number): void {
  const world = screenToWorld(clientX, clientY);
  const pool: Npc[] =
    mode === "village" ? villageNpcs : mode === "district" ? [districtNpcs[currentIdx]!] : [];
  const hit = pool.find((npc) => hitTestNpc(npc, world.x, world.y));
  if (hit) openSidebar(getSlot(hit.district.id));
  else if (isSidebarOpen()) closeSidebar();
}

canvas.addEventListener("pointerdown", (ev) => {
  if (mode === "roster") return;
  canvas.setPointerCapture(ev.pointerId);
  drag = {
    pointerId: ev.pointerId,
    startClientX: ev.clientX,
    startClientY: ev.clientY,
    startCamX: camX,
    startCamY: camY,
    moved: false,
  };
});

canvas.addEventListener("pointermove", (ev) => {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  const dx = ev.clientX - drag.startClientX;
  const dy = ev.clientY - drag.startClientY;
  if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) drag.moved = true;
  if (mode === "village" && drag.moved) {
    const zoom = currentZoom();
    camX = drag.startCamX - dx / zoom;
    camY = drag.startCamY - dy / zoom;
    clampCamera();
  }
});

function endDrag(ev: PointerEvent): void {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  const wasTap = !drag.moved;
  drag = null;
  if (wasTap) handleTap(ev.clientX, ev.clientY);
}
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", () => {
  drag = null;
});

// ---------------------------------------------------------------------------
// Keyboard: Esc closes the sidebar from anywhere; arrow keys pan the village
// camera or step through districts, but never while a form field has focus
// (so typing in the Songs search/filter controls doesn't also move the map).
// ---------------------------------------------------------------------------
const heldPanKeys = new Set<string>();
const ARROW_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

function isFormField(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  if (!node) return false;
  return (
    node.tagName === "INPUT" ||
    node.tagName === "SELECT" ||
    node.tagName === "TEXTAREA" ||
    node.isContentEditable
  );
}

window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    if (isSidebarOpen()) closeSidebar();
    return;
  }
  if (isFormField(ev.target)) return;

  if (mode === "village" && ARROW_KEYS.has(ev.key)) {
    heldPanKeys.add(ev.key);
    ev.preventDefault();
    return;
  }
  if (mode === "district") {
    if (ev.key === "ArrowLeft") applyDistrict(currentIdx - 1);
    else if (ev.key === "ArrowRight") applyDistrict(currentIdx + 1);
  }
});
window.addEventListener("keyup", (ev) => heldPanKeys.delete(ev.key));

function applyKeyPan(dt: number): void {
  if (mode !== "village" || heldPanKeys.size === 0) return;
  const step = PAN_KEY_SPEED * dt;
  if (heldPanKeys.has("ArrowLeft")) camX -= step;
  if (heldPanKeys.has("ArrowRight")) camX += step;
  if (heldPanKeys.has("ArrowUp")) camY -= step;
  if (heldPanKeys.has("ArrowDown")) camY += step;
  clampCamera();
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
prevBtn.addEventListener("click", () => applyDistrict(currentIdx - 1));
nextBtn.addEventListener("click", () => applyDistrict(currentIdx + 1));

viewTabs.forEach((btn) => {
  btn.addEventListener("click", () => {
    const next = btn.dataset.view as Mode | undefined;
    if (next) setMode(next);
  });
});

const resizeObserver = new ResizeObserver(() => fitCanvas());
resizeObserver.observe(stageArea);
window.addEventListener("orientationchange", () => fitCanvas());
window.matchMedia(DESKTOP_QUERY).addEventListener("change", () => fitCanvas());

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
      getNowPlaying: () => getNowPlayingFor(npc.district.id),
    }),
  );

  if (mode === "village") {
    applyKeyPan(dt);
    tickVillage(ts, dt);
    renderVillage();
  } else if (mode === "roster") {
    renderRoster(ts);
  } else {
    followActiveDistrictNpc(dt);
    renderDistrict();
  }

  requestAnimationFrame(frame);
}

const urlsByKey = Object.fromEntries(
  Object.keys(ASSET_MANIFEST).map((key) => [key, assetUrl(key)]),
);

loadImages(urlsByKey).then((loaded) => {
  images = loaded;
  setSidebarImages(images);
  bakeRecolors();
  buildRoster();
  setMode("village");
  requestAnimationFrame(frame);
});
