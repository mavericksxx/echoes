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
import { drawCaptions, drawNpc, drawSelectionRing, getWalkFrames, hitTestNpc, loadImages, type ImageMap } from "./render";
import { bakeRecolor } from "./recolor";
import {
  close as closeSidebar,
  initSidebar,
  isSidebarOpen,
  openSidebar,
  setSidebarImages,
  sidebarSlotId,
} from "./sidebar";
import { initTopArtists } from "./top-artists";

const NOW_PLAYING_INTERVAL_MS = 8000;
const VILLAGE_EVENT_INTERVAL_MS = 5000;
const DESKTOP_QUERY = "(min-width: 900px)";
const DISTRICT_ZOOM_PHONE = 2;
const DISTRICT_ZOOM_DESKTOP = 3;
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

// Screen-space overlay for "now playing" caption pills — a separate canvas
// so its text renders at full device-pixel resolution (crisp, not pixelated)
// regardless of #game's low-res, integer-zoomed backing store. Sized and
// positioned in fitCanvas() to exactly cover #game's rendered box.
const captionCanvas = el<HTMLCanvasElement>("captionLayer");
const captionCtx = captionCanvas.getContext("2d");

const stageArea = el<HTMLDivElement>("stageArea");
const recolorNote = el<HTMLParagraphElement>("recolorNote");
const villageCaption = el<HTMLParagraphElement>("villageCaption");
const roster = el<HTMLDivElement>("roster");
const districtToolbar = el<HTMLDivElement>("districtToolbar");
const districtGenre = el<HTMLSpanElement>("districtGenre");
const districtName = el<HTMLSpanElement>("districtName");
const prevBtn = el<HTMLButtonElement>("prevBtn");
const nextBtn = el<HTMLButtonElement>("nextBtn");
const zoomInBtn = el<HTMLButtonElement>("zoomInBtn");
const zoomOutBtn = el<HTMLButtonElement>("zoomOutBtn");
const viewTabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".view-tab"));

const sidebarRoot = el<HTMLElement>("sidebar");
const sidebarBackdrop = el<HTMLDivElement>("sidebarBackdrop");
initSidebar(sidebarRoot, sidebarBackdrop, { onClose: () => canvas.focus() });
initTopArtists();

let images: ImageMap = {};
let mode: Mode = "village"; // default view: the whole village, everyone present
let currentIdx = 0; // which district src/roster navigation currently points at

// Keyboard NPC cursor: which NPC Tab has cycled to (in interactionPool()
// order) while the canvas has focus. Cleared on every mode switch since the
// pool it indexes into changes.
let keyboardCursor = 0;
let keyboardSelectedSlotId: string | null = null;
function resetKeyboardCursor(): void {
  keyboardCursor = 0;
  keyboardSelectedSlotId = null;
}

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
/** The zoom `fitCanvas()` last actually used — cached rather than
 * recomputed on every pointer event so a drag gesture can't shift scale
 * mid-motion, and so screenToWorld() always agrees with the canvas's own
 * current CSS size. */
let zoom = 1;

function isDesktop(): boolean {
  return window.matchMedia(DESKTOP_QUERY).matches;
}

const VILLAGE_AUTO_MAX_ZOOM = 3;
const ZOOM_MIN = 1;
const ZOOM_MAX = 4;

/** The user's explicit zoom choice (+/- buttons, wheel, pinch), overriding
 * the mode's automatic default until the mode changes. */
let manualZoom: number | null = null;

/** District view's automatic zoom is fixed (3 desktop / 2 phone). Village
 * view's automatic zoom fits the whole map to the viewport when possible:
 * clamp(floor(min(availW/mapW, availH/mapH)), 1, 3). The town map is tall
 * relative to a typical desktop window (after the topbar/toolbar take their
 * share of height), so that formula alone lands on 1 there more often than
 * not — sprites at native (unscaled) size read as uncomfortably small and
 * hard to aim taps at on a desktop monitor, so on desktop specifically we
 * floor it to 2 and accept that seeing the whole village then needs a bit of
 * panning. Phone keeps the plain formula (often also 1, since the map is
 * much wider than a phone screen) — our hit-test padding is a fixed 44
 * world units, so tap targets still meet the 44px minimum at zoom 1, just
 * without the extra margin. Either default can still be overridden by the
 * zoom controls, up to ZOOM_MAX.
 */
function autoZoom(availW: number, availH: number): number {
  if (mode === "village") {
    const fitZoom = Math.floor(Math.min(availW / mapW, availH / mapH));
    let z = Math.max(ZOOM_MIN, Math.min(VILLAGE_AUTO_MAX_ZOOM, fitZoom));
    if (isDesktop() && z < 2) z = 2;
    return z;
  }
  return isDesktop() ? DISTRICT_ZOOM_DESKTOP : DISTRICT_ZOOM_PHONE;
}

function computeZoom(availW: number, availH: number): number {
  if (manualZoom !== null) return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, manualZoom));
  return autoZoom(availW, availH);
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
  const rect = stageArea.getBoundingClientRect();
  const availW = Math.max(1, Math.floor(rect.width));
  const availH = Math.max(1, Math.floor(rect.height));
  zoom = computeZoom(availW, availH);
  viewW = Math.max(1, Math.floor(availW / zoom));
  viewH = Math.max(1, Math.floor(availH / zoom));
  canvas.width = viewW;
  canvas.height = viewH;
  canvas.style.width = `${viewW * zoom}px`;
  canvas.style.height = `${viewH * zoom}px`;
  ctx.imageSmoothingEnabled = false;
  clampCamera();
  fitCaptionLayer(availW, availH);
}

/** Sizes and positions the caption overlay to exactly cover #game's
 * (possibly letterboxed, since it's floor()'d to an integer zoom) rendered
 * box, at full device-pixel resolution so its text stays crisp. */
function fitCaptionLayer(availW: number, availH: number): void {
  const cssW = viewW * zoom;
  const cssH = viewH * zoom;
  const dpr = window.devicePixelRatio || 1;
  captionCanvas.style.left = `${Math.round((availW - cssW) / 2)}px`;
  captionCanvas.style.top = `${Math.round((availH - cssH) / 2)}px`;
  captionCanvas.style.width = `${cssW}px`;
  captionCanvas.style.height = `${cssH}px`;
  captionCanvas.width = Math.max(1, Math.round(cssW * dpr));
  captionCanvas.height = Math.max(1, Math.round(cssH * dpr));
  captionCtx?.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/** Redraws the caption overlay for whichever NPCs are relevant to the
 * current mode (empty in roster mode, which has no map). */
function renderCaptions(npcs: Npc[]): void {
  if (!captionCtx) return;
  drawCaptions(captionCtx, npcs, { camX, camY, zoom }, viewW * zoom, viewH * zoom);
}

function centerCamera(): void {
  camX = (mapW - viewW) / 2;
  camY = (mapH - viewH) / 2;
  clampCamera();
}

/** Changes zoom by `delta` integer steps (clamped to [ZOOM_MIN, ZOOM_MAX]),
 * keeping the world point under `focalClient` (a client-space point — the
 * cursor, the pinch midpoint, or the view center for the +/- buttons) fixed
 * on screen, the way scroll-to-zoom works in map apps. */
function stepZoom(delta: number, focalClient?: { x: number; y: number }): void {
  if (mode === "roster") return;
  const beforeRect = canvas.getBoundingClientRect();
  const focal = focalClient ?? {
    x: beforeRect.left + beforeRect.width / 2,
    y: beforeRect.top + beforeRect.height / 2,
  };
  const worldX = (focal.x - beforeRect.left) / zoom + camX;
  const worldY = (focal.y - beforeRect.top) / zoom + camY;

  const base = manualZoom ?? zoom;
  manualZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(base) + delta));
  fitCanvas();

  const afterRect = canvas.getBoundingClientRect();
  camX = worldX - (focal.x - afterRect.left) / zoom;
  camY = worldY - (focal.y - afterRect.top) / zoom;
  clampCamera();
}

function screenToWorld(clientX: number, clientY: number): Point {
  const rect = canvas.getBoundingClientRect();
  return { x: (clientX - rect.left) / zoom + camX, y: (clientY - rect.top) / zoom + camY };
}

// ---------------------------------------------------------------------------
// Mode / district switching
// ---------------------------------------------------------------------------
function applyDistrict(i: number): void {
  currentIdx = ((i % SLOTS.length) + SLOTS.length) % SLOTS.length;
  resetKeyboardCursor();
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
  resetKeyboardCursor();
  manualZoom = null; // each mode starts at its own sensible default zoom
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
  const view = { camX, camY, viewW, viewH };

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(-camX, -camY);
  ctx.drawImage(imgs[district.bg]!, 0, 0);
  const highlightId = sidebarSlotId() ?? keyboardSelectedSlotId;
  if (highlightId === district.id) drawSelectionRing(ctx, npc);
  drawNpc(ctx, imgs, npc, view);
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

  const view = { camX, camY, viewW, viewH };
  const sorted = villageDrawOrder();
  const highlightId = sidebarSlotId() ?? keyboardSelectedSlotId;
  if (highlightId) {
    const highlighted = sorted.find((n) => n.district.id === highlightId);
    if (highlighted) drawSelectionRing(ctx, highlighted);
  }
  sorted.filter((n) => !n.caption).forEach((n) => drawNpc(ctx, images, n, view));
  sorted.filter((n) => n.caption).forEach((n) => drawNpc(ctx, images, n, view));
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

/** Village NPCs in the same back-to-front order renderVillage() draws them
 * in, so overlapping sprites and overlapping taps agree on which one is
 * "in front". */
function villageDrawOrder(): Npc[] {
  return [...villageNpcs].sort((a, b) => a.y - b.y);
}

/** The tappable/keyboard-selectable NPCs for the current mode, front-to-back
 * (reverse draw order) — a tap or Enter/Space on an overlap should hit
 * whichever sprite is visually on top, not whichever happens first in
 * villageNpcs's underlying array order. */
function interactionPool(): Npc[] {
  if (mode === "village") return [...villageDrawOrder()].reverse();
  if (mode === "district") return [districtNpcs[currentIdx]!];
  return [];
}

function handleTap(clientX: number, clientY: number): void {
  const world = screenToWorld(clientX, clientY);
  const hit = interactionPool().find((npc) => hitTestNpc(npc, world.x, world.y));
  if (hit) openSidebar(getSlot(hit.district.id));
  else if (isSidebarOpen()) closeSidebar();
}

// Two-finger pinch-to-zoom tracks every active pointer by id; a single
// remaining pointer falls back to the existing drag-to-pan/tap handling.
const activePointers = new Map<number, { x: number; y: number }>();
let pinchStartDist = 0;
const PINCH_STEP_RATIO = 1.35; // finger-distance ratio that triggers one integer zoom step

function pointerDist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function pointerMid(a: { x: number; y: number }, b: { x: number; y: number }) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

canvas.addEventListener("pointerdown", (ev) => {
  if (mode === "roster") return;
  canvas.setPointerCapture(ev.pointerId);
  activePointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

  if (activePointers.size === 2) {
    drag = null; // a pinch starting mid-drag cancels the single-finger pan/tap
    const [a, b] = Array.from(activePointers.values());
    pinchStartDist = pointerDist(a!, b!);
  } else if (activePointers.size === 1) {
    drag = {
      pointerId: ev.pointerId,
      startClientX: ev.clientX,
      startClientY: ev.clientY,
      startCamX: camX,
      startCamY: camY,
      moved: false,
    };
  }
});

canvas.addEventListener("pointermove", (ev) => {
  if (!activePointers.has(ev.pointerId)) return;
  activePointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

  if (activePointers.size === 2) {
    const [a, b] = Array.from(activePointers.values());
    const dist = pointerDist(a!, b!);
    const mid = pointerMid(a!, b!);
    if (pinchStartDist > 0) {
      if (dist / pinchStartDist >= PINCH_STEP_RATIO) {
        stepZoom(1, mid);
        pinchStartDist = dist;
      } else if (dist / pinchStartDist <= 1 / PINCH_STEP_RATIO) {
        stepZoom(-1, mid);
        pinchStartDist = dist;
      }
    }
    return;
  }

  if (!drag || ev.pointerId !== drag.pointerId) return;
  const dx = ev.clientX - drag.startClientX;
  const dy = ev.clientY - drag.startClientY;
  if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) drag.moved = true;
  if (mode === "village" && drag.moved) {
    camX = drag.startCamX - dx / zoom;
    camY = drag.startCamY - dy / zoom;
    clampCamera();
  }
});

function releasePointer(ev: PointerEvent): void {
  const wasSoloPointer = activePointers.size === 1 && activePointers.has(ev.pointerId);
  activePointers.delete(ev.pointerId);
  if (activePointers.size < 2) pinchStartDist = 0;

  if (!drag || ev.pointerId !== drag.pointerId) return;
  const wasTap = !drag.moved;
  drag = null;
  if (wasSoloPointer && wasTap) handleTap(ev.clientX, ev.clientY);
}
canvas.addEventListener("pointerup", releasePointer);
canvas.addEventListener("pointercancel", (ev) => {
  activePointers.delete(ev.pointerId);
  if (activePointers.size < 2) pinchStartDist = 0;
  drag = null;
});

// Mouse wheel and trackpad pinch (browsers report trackpad pinch as a wheel
// event with ctrlKey set) both zoom, centered on the cursor.
canvas.addEventListener(
  "wheel",
  (ev) => {
    if (mode === "roster") return;
    ev.preventDefault();
    stepZoom(ev.deltaY < 0 ? 1 : -1, { x: ev.clientX, y: ev.clientY });
  },
  { passive: false },
);

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

function nearestNpcToViewCenter(pool: Npc[]): Npc | null {
  if (pool.length === 0) return null;
  const cx = camX + viewW / 2;
  const cy = camY + viewH / 2;
  return pool.reduce((best, n) => {
    const d = (n.x - cx) ** 2 + (n.y - cy) ** 2;
    const bd = (best.x - cx) ** 2 + (best.y - cy) ** 2;
    return d < bd ? n : best;
  });
}

// Enter/Space on the focused canvas open the sidebar for whichever NPC is
// currently selected: the one Tab last cycled to, else the one the sidebar
// is already showing, else whichever is nearest the view's center.
//
// Tab, while the canvas has focus, cycles that selection instead of leaving
// the canvas — a deliberate tradeoff: it makes single-key NPC browsing cheap
// (no separate widgets to build), but it also means Tab can no longer move
// focus off the map. Escape is the documented way out: it blurs the canvas
// (once the sidebar itself is already closed) so normal Tab order resumes.
canvas.addEventListener("keydown", (ev) => {
  if (mode === "roster") return;
  const pool = interactionPool();
  if (pool.length === 0) return;

  if (ev.key === "Tab") {
    ev.preventDefault();
    keyboardCursor = (keyboardCursor + (ev.shiftKey ? -1 : 1) + pool.length) % pool.length;
    keyboardSelectedSlotId = pool[keyboardCursor]!.district.id;
    return;
  }
  if (ev.key === "Enter" || ev.key === " ") {
    ev.preventDefault();
    const bySlotId = (id: string | null) => (id ? pool.find((n) => n.district.id === id) : undefined);
    const target = bySlotId(keyboardSelectedSlotId) ?? bySlotId(sidebarSlotId()) ?? nearestNpcToViewCenter(pool);
    if (target) openSidebar(getSlot(target.district.id));
  }
});

window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    if (isSidebarOpen()) closeSidebar();
    else if (document.activeElement === canvas) canvas.blur();
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
zoomInBtn.addEventListener("click", () => stepZoom(1));
zoomOutBtn.addEventListener("click", () => stepZoom(-1));

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
    renderCaptions(villageNpcs);
  } else if (mode === "roster") {
    renderRoster(ts);
    renderCaptions([]);
  } else {
    followActiveDistrictNpc(dt);
    renderDistrict();
    renderCaptions([districtNpcs[currentIdx]!]);
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
