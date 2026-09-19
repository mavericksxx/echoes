// Echoes — entry point. Wires together the whole-village view (default) and
// per-district scenes (Phase 2.5: explicit "Enter district" transitions, no
// more Village/Districts/Roster view switch) on top of hard-coded sample
// listening data. Ported from prototypes/konoha-demo/main.js.

import "./style.css";
import type { Point } from "../data/types";
import { ASSET_MANIFEST, SLOTS, VILLAGE, assetSize, assetUrl, getSlot } from "../data/loader";
import { pickWeightedSlotId } from "./sample-data";
import {
  energyPerformMul,
  energySpeedMul,
  makeNpc,
  setCaption,
  startPerform,
  triggerNowPlayingReaction,
  updateNpc,
  type Npc,
  type NowPlayingInfo,
} from "./npc";
import {
  drawCaptions,
  drawNoticeBoard,
  drawNpc,
  drawSelectionRing,
  hitTestNoticeBoard,
  hitTestNpc,
  loadImages,
  type CaptionLabel,
  type ImageMap,
} from "./render";
import { bakeRecolor } from "./recolor";
import { buildCrowd, buildResidents, drawActivityTreatment, drawMoodTint, genericCharacter, type Resident } from "./residents";
import {
  close as closeSidebar,
  initSidebar,
  isSidebarOpen,
  openSidebar,
  refreshSidebarContent,
  setSidebarImages,
  sidebarSlotId,
} from "./sidebar";
import { initTopArtists } from "./top-artists";
import { getLiveNowPlaying, initNowPlayingCard, subscribeNowPlaying } from "./now-playing-card";
import { initHistoryStats } from "./history-stats";
import {
  getActivity,
  getMoodEnergy,
  getNowPlaying,
  initListeningSource,
  isVillageConnected,
  isVillageEmpty,
  isVillageLive,
  refreshVillage,
} from "./listening-source";
import { fetchWorldResponse, getFestivals, getTimeOfDay, getVisitors, getWeather, getWorldVersion, initWorldState } from "./world-state";
import { drawFestivalDecor, drawNightGlows, drawTimeOfDayTint, drawWeather } from "./world-render";
import { onEraChange } from "./era";
import { ACTIVITY_TREATMENT } from "../shared/activity";
import { downloadRecording, isRecordingSupported, startRecording, takeSnapshot, type Recording } from "./capture";
import { initSoundToggle, playFootstep, updateWeatherAmbience } from "./sound";
import { initOnboarding } from "./onboarding";

const NOW_PLAYING_INTERVAL_MS = 8000;
const VILLAGE_EVENT_INTERVAL_MS = 5000;
const DESKTOP_QUERY = "(min-width: 900px)";
const DISTRICT_ZOOM_PHONE = 2;
const DISTRICT_ZOOM_DESKTOP = 3;
const PAN_KEY_SPEED = 260; // world px/sec for arrow-key panning in village view
const DRAG_THRESHOLD = 6; // css px before a pointer-down counts as a drag, not a tap
const SCENE_TRANSITION_MS = 220; // matches --duration-base in style.css
// Phase 9: the notice board's fixed world-space spot — an open patch of the
// town map with no character anchor right on top of it (data/village.json's
// nearest anchor, sakura, is still ~104px away; every other anchor is
// farther), village-view only, same as villageNpcs' own map.
const NOTICE_BOARD_POS: Point = { x: 380, y: 380 };

type Mode = "village" | "district";

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

// Screen-space overlay for "now playing" / resident-name labels — a separate
// canvas so its text renders at full device-pixel resolution (crisp, not
// pixelated) regardless of #game's low-res, integer-zoomed backing store.
// Sized and positioned in fitCanvas() to exactly cover #game's rendered box.
const captionCanvas = el<HTMLCanvasElement>("captionLayer");
const captionCtx = captionCanvas.getContext("2d");

const stageArea = el<HTMLDivElement>("stageArea");
const villageCaption = el<HTMLParagraphElement>("villageCaption");
const backBtn = el<HTMLButtonElement>("backBtn");
const topbarContext = el<HTMLDivElement>("topbarContext");
const districtGenre = el<HTMLSpanElement>("districtGenre");
const districtName = el<HTMLSpanElement>("districtName");
const zoomInBtn = el<HTMLButtonElement>("zoomInBtn");
const zoomOutBtn = el<HTMLButtonElement>("zoomOutBtn");
const snapshotBtn = el<HTMLButtonElement>("snapshotBtn");
const recordBtn = el<HTMLButtonElement>("recordBtn");
const soundBtn = el<HTMLButtonElement>("soundBtn");
const recordIndicator = el<HTMLSpanElement>("recordIndicator");
const helpBtn = el<HTMLButtonElement>("helpBtn");
const onboardingBackdrop = el<HTMLDivElement>("onboardingBackdrop");
const onboardingModal = el<HTMLDivElement>("onboardingModal");

const sidebarRoot = el<HTMLElement>("sidebar");
const sidebarBackdrop = el<HTMLDivElement>("sidebarBackdrop");
initSidebar(sidebarRoot, sidebarBackdrop, {
  onClose: () => {
    selectedNpc = null;
    canvas.focus();
  },
  onFocusSlot: (slotId) => {
    panCameraToSlot(slotId);
  },
  onEnterDistrict: (slotId) => {
    closeSidebar();
    enterDistrict(slotId);
  },
});
initTopArtists();
initNowPlayingCard();
void initHistoryStats();
initOnboarding(onboardingBackdrop, onboardingModal, helpBtn);

let images: ImageMap = {};
let mode: Mode = "village"; // default view: the whole village, everyone present
let currentDistrictId: string | null = null;

// Keyboard NPC cursor: which NPC Tab has cycled to (in interactionPool()
// order) while the canvas has focus. Cleared on every mode switch since the
// pool it indexes into changes.
let keyboardCursor = 0;
let keyboardSelectedNpc: Npc | null = null;
// The NPC the sidebar is currently open for (leader or resident) — kept
// separate from sidebarSlotId() since several NPCs (a leader + its
// residents) share one district id but should ring-highlight individually.
let selectedNpc: Npc | null = null;
function resetKeyboardCursor(): void {
  keyboardCursor = 0;
  keyboardSelectedNpc = null;
}

// District leaders wander their own interior at radius 4 — see SPEC.md
// Phase 4 and src/npc.ts's DEFAULT_WANDER_RADIUS (used here implicitly).
const districtNpcsBySlot = new Map<string, Npc>(
  SLOTS.map((slot) => [slot.district.id, makeNpc(slot.character, slot.district)]),
);

// Village-view instances of the same 17 characters wander the shared "town"
// map (not their own district's bg) at a slightly wider radius — see
// SPEC.md Phase 4: "village leaders 5 cells".
const villageNpcs: Npc[] = SLOTS.map((slot) => {
  const anchor = VILLAGE.anchors[slot.character.id];
  if (!anchor) throw new Error(`village.json has no anchor for "${slot.character.id}"`);
  return makeNpc(slot.character, slot.district, anchor, { mapKey: VILLAGE.mapImage, wanderRadius: 5 });
});

// Phase 5b: react the moment the live poll reports a new track, instead of
// waiting on each leader's own nowPlayingIntervalMs timer — "within
// seconds" per SPEC.md's Phase 5. Fires both places a leader can be seen:
// this slot's district-interior instance (always ticked, frame()'s
// districtNpcsBySlot loop) and its whole-village instance (villageNpcs,
// ticked only while mode==="village" — see tickVillage()), so the reaction
// is there waiting whichever view you're in when the track actually changed.
subscribeNowPlaying((info) => {
  if (!info) return;
  const now = performance.now();
  const districtLeader = districtNpcsBySlot.get(info.slotId);
  if (districtLeader) triggerNowPlayingReaction(districtLeader, now);
  const villageLeader = villageNpcs.find((n) => n.district.id === info.slotId);
  if (villageLeader) triggerNowPlayingReaction(villageLeader, now);
});

// Populated once images have loaded (see buildResidents) — districts with no
// listening data get no residents (they stay dormant/leader-only).
let residentsBySlot = new Map<string, Resident[]>();
let allResidents: Resident[] = [];
let residentArtistByNpc = new Map<Npc, string>();
let residentArtistIdByNpc = new Map<Npc, string | undefined>();
let residentFadedByNpc = new Map<Npc, boolean>();

// Ambient background crowd — every district gets a pool (see buildCrowd);
// how many of each district's pool are shown/updated is decided per-frame by
// its current activity level (see renderDistrict). Non-interactive: never in
// interactionPool(), districtCaptionLabels(), or any resident/artist map.
let crowdBySlot = new Map<string, Npc[]>();
let allCrowd: Npc[] = [];

// Phase 11: village-view-only markers for the daily agent's visitors (see
// world-state.ts's getVisitors) — a generic crowd sprite at the visited
// slot's village anchor, captioned with the artist's display name. Built
// once world state has loaded (see rebuildVisitors) and never re-ticked:
// a visiting artist stands, it doesn't wander.
let visitorNpcs: Npc[] = [];
let visitorNameByNpc = new Map<Npc, string>();
// Phase 12: world-state.ts's worldVersion, as of the last rebuildVisitors()
// call — frame() below compares against getWorldVersion() every frame and
// rebuilds when they differ, so a Chronicle replay's stepped-through visitors
// actually redraw instead of staying frozen at whatever was live at init.
let lastWorldVersion = getWorldVersion();

// Phase 5b: once the village is live, "now playing" comes from the real
// currently-playing poll (src/now-playing-card.ts), not the sample data —
// and only the one slot the live track's primary artist resolved to reacts
// (worker/now-playing.ts's slotId). Every other slot gets null, same as
// before. The sample-data path (village not live) is untouched.
function getNowPlayingFor(slotId: string): NowPlayingInfo | null {
  if (isVillageLive()) {
    const live = getLiveNowPlaying();
    return live && live.slotId === slotId ? { artist: live.artist, song: live.song, caption: live.caption } : null;
  }
  const song = getNowPlaying(slotId);
  return song ? { artist: song.artist, song: song.title } : null;
}

// Pre-baked recolored copies of a district's bg/sheet/battleSheet — kept for
// a possible future *activity-level* tint (see SPEC.md); no district uses
// recolorFilter any more (Phase 2.5 gave the 9 previously-recolored slots
// real interiors), so this is a no-op today.
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

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const VILLAGE_AUTO_MAX_ZOOM = 3;
const ZOOM_MIN = 1;
const ZOOM_MAX = 4;
const ZOOM_ANIM_MS = 200; // matches SPEC.md Phase 4.5's "~200ms with easing"

/** The user's explicit zoom choice (+/- buttons, wheel, pinch), overriding
 * the mode's automatic default until the mode changes. */
let manualZoom: number | null = null;

/** The lowest zoom `computeZoom()` will settle on for the given viewport.
 * Normally ZOOM_MIN (1) — but in village view, if the map doesn't fit the
 * viewport at zoom 1 in some axis (a phone-width screen against the 767px
 * town map), the floor drops to the exact fit-to-screen ratio instead, so
 * the whole map can always be shown. That fractional value is a legitimate
 * resting level (see autoZoom's doc comment and stepZoom), not a violation
 * of "integer zoom at rest" — it's the one deliberate exception. */
function zoomFloor(availW: number, availH: number): number {
  if (mode !== "village") return ZOOM_MIN;
  return Math.min(ZOOM_MIN, availW / mapW, availH / mapH);
}

/** District view's automatic zoom is fixed (3 desktop / 2 phone). Village
 * view's automatic zoom fits the whole map to the viewport when possible:
 * clamp(floor(min(availW/mapW, availH/mapH)), 1, 3). The town map is tall
 * relative to a typical desktop window (after the topbar takes its share of
 * height), so that formula alone lands on 1 there more often than not —
 * sprites at native (unscaled) size read as uncomfortably small and hard to
 * aim taps at on a desktop monitor, so on desktop specifically we floor it
 * to 2 and accept that seeing the whole village then needs a bit of panning.
 * Phone keeps the plain formula (often also 1, since the map is much wider
 * than a phone screen) — our hit-test padding is a fixed 44 world units, so
 * tap targets still meet the 44px minimum at zoom 1, just without the extra
 * margin. Either default can still be overridden by the zoom controls, up
 * to ZOOM_MAX.
 *
 * Below zoom 1, though, "floor" turns into 0 on a narrow-enough viewport —
 * the town map (767x758) is wider than a phone screen, so floor(availW/mapW)
 * is 0 there. zoomFloor() catches that case and returns the true (unfloored)
 * fit-to-screen ratio instead; when it does, that ratio *is* the auto zoom,
 * so the whole village is always visible on load.
 */
function autoZoom(availW: number, availH: number): number {
  if (mode === "village") {
    const floor = zoomFloor(availW, availH);
    if (floor < ZOOM_MIN) return floor;
    const fitZoom = Math.floor(Math.min(availW / mapW, availH / mapH));
    let z = Math.min(VILLAGE_AUTO_MAX_ZOOM, fitZoom);
    if (isDesktop() && z < 2) z = 2;
    return z;
  }
  return isDesktop() ? DISTRICT_ZOOM_DESKTOP : DISTRICT_ZOOM_PHONE;
}

function computeZoom(availW: number, availH: number): number {
  if (manualZoom !== null) return Math.max(zoomFloor(availW, availH), Math.min(ZOOM_MAX, manualZoom));
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

/** Resizes the canvas's backing store to a fraction of its container at the
 * given zoom, then re-stretches it via CSS — an exact integer multiple at
 * the resting zoom levels (never a fractional scale there — see
 * zoomAnim/stepZoom's doc comment), and never larger than the container (no
 * crop). Also used mid-flight by the zoom animation, at whatever fractional
 * zoom the current eased frame lands on; fitCaptionLayer() reads the same
 * viewW/zoom this just set, so the caption layer and #game's box can never
 * disagree, animated or not. */
function applyCanvasSize(zoomValue: number): void {
  const rect = stageArea.getBoundingClientRect();
  const availW = Math.max(1, Math.floor(rect.width));
  const availH = Math.max(1, Math.floor(rect.height));
  zoom = zoomValue;
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

/** Recomputes the resting zoom for the current viewport/mode and applies it.
 * Cancels any in-flight zoom or camera-pan animation — called on mode
 * changes and layout changes (resize, orientation, desktop/phone
 * breakpoint), where whatever either animation was easing toward is no
 * longer meaningful. */
function fitCanvas(): void {
  zoomAnim = null;
  panAnim = null;
  const rect = stageArea.getBoundingClientRect();
  const availW = Math.max(1, Math.floor(rect.width));
  const availH = Math.max(1, Math.floor(rect.height));
  applyCanvasSize(computeZoom(availW, availH));
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

/** Redraws the caption overlay for whichever labels are relevant to the
 * current mode. */
function renderCaptions(labels: CaptionLabel[]): void {
  if (!captionCtx) return;
  drawCaptions(captionCtx, labels, { camX, camY, zoom }, viewW * zoom, viewH * zoom);
}

function centerCamera(): void {
  camX = (mapW - viewW) / 2;
  camY = (mapH - viewH) / 2;
  clampCamera();
}

/** An in-flight glide between two resting zoom levels (see stepZoom). Holds
 * the focal point in both client and world space so every eased frame —
 * not just the endpoints — can re-derive camX/camY that keep that world
 * point under that screen point, exactly like stepZoom's instant case did
 * before this existed. */
interface ZoomAnim {
  fromZoom: number;
  toZoom: number;
  startTs: number;
  focalClientX: number;
  focalClientY: number;
  worldX: number;
  worldY: number;
}
let zoomAnim: ZoomAnim | null = null;

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

/** Changes zoom by `delta` integer steps (clamped to [zoomFloor, ZOOM_MAX] —
 * see zoomFloor's doc comment for the fractional phone-fit exception),
 * keeping the world point under `focalClient` (a client-space point — the
 * cursor, the pinch midpoint, or the view center for the +/- buttons) fixed
 * on screen, the way scroll-to-zoom works in map apps. The change glides
 * over ZOOM_ANIM_MS (see updateZoomAnim) rather than snapping, unless
 * prefers-reduced-motion asks for an instant cut. Zooming out below
 * ZOOM_MIN while inside a district exits to the village instead of clamping
 * (see exitToVillage). Calling this again while a glide is already running
 * retargets it from the live in-flight zoom instead of queuing — see
 * `fromZoom: zoom` below, `zoom` being whatever updateZoomAnim last drew. */
function stepZoom(delta: number, focalClient?: { x: number; y: number }): void {
  dismissVillageCaption();
  const beforeRect = canvas.getBoundingClientRect();
  const focal = focalClient ?? {
    x: beforeRect.left + beforeRect.width / 2,
    y: beforeRect.top + beforeRect.height / 2,
  };
  const worldX = (focal.x - beforeRect.left) / zoom + camX;
  const worldY = (focal.y - beforeRect.top) / zoom + camY;

  const stageRect = stageArea.getBoundingClientRect();
  const availW = Math.max(1, Math.floor(stageRect.width));
  const availH = Math.max(1, Math.floor(stageRect.height));
  const floor = zoomFloor(availW, availH);

  // The resting level to step from: the current target if one's already
  // set (including mid-glide), else the live zoom. Below ZOOM_MIN, we're
  // sitting on the fractional phone-fit floor, which isn't itself an
  // integer rung — stepping "in" from there always lands on ZOOM_MIN (the
  // first real rung), and stepping "out" further has nowhere lower to go.
  const currentLevel = manualZoom ?? zoom;
  const next = currentLevel < ZOOM_MIN - 1e-9 ? (delta > 0 ? ZOOM_MIN : currentLevel) : Math.round(currentLevel) + delta;

  if (mode === "district" && next < ZOOM_MIN) {
    zoomAnim = null;
    exitToVillage();
    return;
  }
  const targetZoom = Math.max(floor, Math.min(ZOOM_MAX, next));
  manualZoom = targetZoom;
  if (Math.abs(targetZoom - zoom) < 1e-6) return; // already there — e.g. "-" at the floor

  if (prefersReducedMotion()) {
    zoomAnim = null;
    applyCanvasSize(targetZoom);
    const afterRect = canvas.getBoundingClientRect();
    camX = worldX - (focal.x - afterRect.left) / zoom;
    camY = worldY - (focal.y - afterRect.top) / zoom;
    clampCamera();
    return;
  }

  zoomAnim = {
    fromZoom: zoom,
    toZoom: targetZoom,
    startTs: performance.now(),
    focalClientX: focal.x,
    focalClientY: focal.y,
    worldX,
    worldY,
  };
}

/** Advances the in-flight zoom glide (if any) by one animation frame,
 * applying the eased zoom for `ts` and re-deriving the camera so the
 * glide's focal point stays fixed on screen throughout — not just at the
 * end. Called once per rAF from frame(), before rendering. */
function updateZoomAnim(ts: number): void {
  if (!zoomAnim) return;
  const t = Math.min(1, (ts - zoomAnim.startTs) / ZOOM_ANIM_MS);
  const z = zoomAnim.fromZoom + (zoomAnim.toZoom - zoomAnim.fromZoom) * easeOutCubic(t);
  applyCanvasSize(z);
  const rect = canvas.getBoundingClientRect();
  camX = zoomAnim.worldX - (zoomAnim.focalClientX - rect.left) / zoom;
  camY = zoomAnim.worldY - (zoomAnim.focalClientY - rect.top) / zoom;
  clampCamera();
  if (t >= 1) zoomAnim = null;
}

// ---------------------------------------------------------------------------
// Phase 10: camera pan-to-point, reusing zoomAnim's own easing (easeOutCubic
// over a fixed duration) for a "the Hokage points you toward a district"
// glide — a separate in-flight animation from zoomAnim above since a focus
// pan doesn't change zoom at all, just recenters the view.
// ---------------------------------------------------------------------------
interface PanAnim {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  startTs: number;
}
let panAnim: PanAnim | null = null;
// Slower than ZOOM_ANIM_MS (200ms) — a zoom glide only ever re-centers a
// focal point a short distance, while a focus pan can cross the whole map.
const PAN_ANIM_MS = 500;

/** Glides the camera to center `worldX,worldY`, village view only (SPEC.md's
 * Phase 10 task) — a no-op in district view, where there's no single "map"
 * for a slot's village anchor to mean anything on. */
function panCameraTo(worldX: number, worldY: number): void {
  if (mode !== "village") return;
  const targetX = clampAxis(worldX - viewW / 2, mapW, viewW);
  const targetY = clampAxis(worldY - viewH / 2, mapH, viewH);
  if (prefersReducedMotion()) {
    camX = targetX;
    camY = targetY;
    clampCamera();
    return;
  }
  panAnim = { fromX: camX, fromY: camY, toX: targetX, toY: targetY, startTs: performance.now() };
}

/** Advances the in-flight camera pan (if any), same eased-glide shape as
 * updateZoomAnim above. Called once per rAF from frame(). */
function updatePanAnim(ts: number): void {
  if (!panAnim) return;
  const t = Math.min(1, (ts - panAnim.startTs) / PAN_ANIM_MS);
  const e = easeOutCubic(t);
  camX = panAnim.fromX + (panAnim.toX - panAnim.fromX) * e;
  camY = panAnim.fromY + (panAnim.toY - panAnim.fromY) * e;
  clampCamera();
  if (t >= 1) panAnim = null;
}

/** Pans to a slot's village anchor (data/village.json's `anchors`, keyed by
 * character id — same anchor villageNpcs above are placed at). Used by the
 * Hokage sidebar tab (src/sidebar.ts) after a reply names a focusSlots
 * district — see initSidebar's onFocusSlot hook. */
function panCameraToSlot(slotId: string): void {
  const slot = SLOTS.find((s) => s.district.id === slotId);
  if (!slot) return;
  const anchor = VILLAGE.anchors[slot.character.id];
  if (!anchor) return;
  panCameraTo(anchor.x, anchor.y);
}

function screenToWorld(clientX: number, clientY: number): Point {
  const rect = canvas.getBoundingClientRect();
  return { x: (clientX - rect.left) / zoom + camX, y: (clientY - rect.top) / zoom + camY };
}

// ---------------------------------------------------------------------------
// Scene stack: village <-> one district, with a short fade (skipped under
// prefers-reduced-motion — see .stage-area in style.css, and the global
// reduced-motion rule that already collapses any transition-duration to
// ~0). Entering pushes browser history so back exits; Esc, the app-bar back
// button, and zooming out below the minimum all exit too (see stepZoom and
// the keydown handler below).
// ---------------------------------------------------------------------------
function transitionScene(action: () => void): void {
  if (prefersReducedMotion()) {
    action();
    return;
  }
  stageArea.classList.add("is-transitioning");
  window.setTimeout(() => {
    action();
    requestAnimationFrame(() => stageArea.classList.remove("is-transitioning"));
  }, SCENE_TRANSITION_MS);
}

function applyDistrictScene(slotId: string): void {
  mode = "district";
  currentDistrictId = slotId;
  resetKeyboardCursor();
  const { character, district } = getSlot(slotId);
  setMapSize(district.bg);
  fitCanvas();
  const npc = districtNpcsBySlot.get(slotId)!;
  camX = clampAxis(npc.x - viewW / 2, mapW, viewW);
  camY = clampAxis(npc.y - viewH / 2, mapH, viewH);
  districtGenre.textContent = district.genre;
  districtName.textContent = character.name;
  topbarContext.hidden = false;
  backBtn.hidden = false;
  villageCaption.hidden = true;
}

function applyVillageScene(): void {
  mode = "village";
  currentDistrictId = null;
  resetKeyboardCursor();
  setMapSize(VILLAGE.mapImage);
  fitCanvas();
  centerCamera();
  districtGenre.textContent = "";
  districtName.textContent = "";
  // No village-wide name/genre to show (see index.html's empty #districtName)
  // — hide the whole readout so its padding doesn't leave a stray gap in the
  // topbar's flex row (see [hidden] in style.css).
  topbarContext.hidden = true;
  backBtn.hidden = true;
  if (!villageCaptionDismissed) villageCaption.hidden = false;
}

function enterDistrict(slotId: string, opts: { pushState?: boolean } = {}): void {
  const { pushState = true } = opts;
  if (mode === "district" && currentDistrictId === slotId) return;
  manualZoom = null; // each scene starts at its own sensible default zoom
  transitionScene(() => applyDistrictScene(slotId));
  if (pushState) history.pushState({ echoesDistrict: slotId }, "", `#${slotId}`);
}

function exitToVillage(opts: { pushState?: boolean } = {}): void {
  const { pushState = true } = opts;
  if (mode === "village") return;
  manualZoom = null;
  transitionScene(applyVillageScene);
  if (pushState) history.pushState({ echoesDistrict: null }, "", `${location.pathname}${location.search}`);
}

window.addEventListener("popstate", (ev) => {
  const slotId = (ev.state as { echoesDistrict?: string | null } | null)?.echoesDistrict ?? null;
  if (slotId) enterDistrict(slotId, { pushState: false });
  else exitToVillage({ pushState: false });
});

// ---------------------------------------------------------------------------
// District view
// ---------------------------------------------------------------------------
function followActiveDistrictLeader(dt: number): void {
  if (!currentDistrictId) return;
  const npc = districtNpcsBySlot.get(currentDistrictId)!;
  const targetX = clampAxis(npc.x - viewW / 2, mapW, viewW);
  const targetY = clampAxis(npc.y - viewH / 2, mapH, viewH);
  const t = Math.min(1, dt * 4);
  camX += (targetX - camX) * t;
  camY += (targetY - camY) * t;
}

function renderDistrict(dt: number, ts: number): void {
  if (!currentDistrictId) return;
  const { district } = getSlot(currentDistrictId);
  const leader = districtNpcsBySlot.get(currentDistrictId)!;
  const residents = residentsBySlot.get(currentDistrictId) ?? [];
  const crowd = crowdBySlot.get(currentDistrictId) ?? [];
  const level = getActivity(district.id).level;
  // crowdExtra decides how many of the district's crowd pool are visible
  // this frame (see buildCrowd's doc comment) — the rest keep wandering
  // off-screen so a level change never needs to spawn/despawn NPCs.
  const visibleCrowd = crowd.slice(0, ACTIVITY_TREATMENT[level].crowdExtra);
  const imgs = (district.recolorFilter && recoloredImagesByDistrict.get(district.id)) || images;
  const view = { camX, camY, viewW, viewH };
  const [bgW, bgH] = [mapW, mapH]; // renderDistrict only runs while mode==="district", so these are this district's bg size

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(-camX, -camY);
  ctx.drawImage(imgs[district.bg]!, 0, 0);
  drawActivityTreatment(ctx, level, bgW, bgH);
  drawMoodTint(ctx, getMoodEnergy(district.id).mood, bgW, bgH);
  const allNpcs = [leader, ...residents.map((r) => r.npc), ...visibleCrowd];
  const sorted = [...allNpcs].sort((a, b) => a.y - b.y);
  sorted.forEach((npc) => {
    if (npc === selectedNpc || npc === keyboardSelectedNpc) drawSelectionRing(ctx, npc);
    const opacity = residentFadedByNpc.get(npc) ? 0.4 : 1;
    drawNpc(ctx, imgs, npc, view, { opacity });
  });

  // Phase 11: world effects — a lighting wash on top of everything drawn so
  // far, then night glows cutting through it, then weather particles on top
  // of all of it (see world-render.ts's doc comment on draw order).
  const timeOfDay = getTimeOfDay();
  drawTimeOfDayTint(ctx, timeOfDay, bgW, bgH);
  if (timeOfDay === "night") drawNightGlows(ctx, [district.home]);
  drawWeather(ctx, getWeather(), camX, camY, viewW, viewH, dt, ts, prefersReducedMotion());
  ctx.restore();
}

function districtCaptionLabels(): CaptionLabel[] {
  if (!currentDistrictId) return [];
  const leader = districtNpcsBySlot.get(currentDistrictId)!;
  const residents = residentsBySlot.get(currentDistrictId) ?? [];
  const labels: CaptionLabel[] = [];
  if (leader.caption) labels.push({ npc: leader, text: leader.caption });
  residents.forEach((r) => labels.push({ npc: r.npc, text: r.faded ? `${r.artistName} (asleep)` : r.artistName }));
  return labels;
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
      setCaption(npc, info.caption ?? `Now playing: ${info.artist} – ${info.song}`, 3.2);
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

function renderVillage(dt: number, ts: number): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(-camX, -camY);
  ctx.drawImage(images[VILLAGE.mapImage]!, 0, 0);
  drawNoticeBoard(ctx, NOTICE_BOARD_POS.x, NOTICE_BOARD_POS.y);
  // Phase 11: festival decor at each active festival's district anchor —
  // village view only (a district's own interior has no single "map" for a
  // slot's anchor to mean anything on, same reasoning as panCameraToSlot).
  getFestivals().forEach((festival) => {
    const slot = SLOTS.find((s) => s.district.id === festival.slotId);
    const anchor = slot && VILLAGE.anchors[slot.character.id];
    if (anchor) drawFestivalDecor(ctx, anchor.x, anchor.y, festival.name);
  });

  const view = { camX, camY, viewW, viewH };
  const sorted = [...villageDrawOrder(), ...visitorNpcs].sort((a, b) => a.y - b.y);
  sorted.forEach((npc) => {
    if (npc === selectedNpc || npc === keyboardSelectedNpc) drawSelectionRing(ctx, npc);
  });
  sorted.filter((n) => !n.caption).forEach((n) => drawNpc(ctx, images, n, view));
  sorted.filter((n) => n.caption).forEach((n) => drawNpc(ctx, images, n, view));

  // Phase 11: world effects — see renderDistrict's matching block for the
  // draw-order reasoning (tint, then night glows, then weather on top).
  const timeOfDay = getTimeOfDay();
  drawTimeOfDayTint(ctx, timeOfDay, mapW, mapH);
  if (timeOfDay === "night") {
    const glowPoints = SLOTS.map((s) => VILLAGE.anchors[s.character.id]).filter((p): p is Point => Boolean(p));
    drawNightGlows(ctx, glowPoints);
  }
  drawWeather(ctx, getWeather(), camX, camY, viewW, viewH, dt, ts, prefersReducedMotion());
  ctx.restore();
}

function villageCaptionLabels(): CaptionLabel[] {
  const labels: CaptionLabel[] = villageNpcs.filter((n) => n.caption).map((npc) => ({ npc, text: npc.caption! }));
  // Phase 11: a visitor's name label is persistent (like a district
  // resident's), not transient like a leader's "now playing" caption.
  visitorNpcs.forEach((npc) => {
    const name = visitorNameByNpc.get(npc);
    if (name) labels.push({ npc, text: `${name} (visiting)` });
  });
  return labels;
}

// ---------------------------------------------------------------------------
// Sidebar wiring — opening for a leader or a resident, deciding whether
// "Enter district" makes sense (only from the village).
// ---------------------------------------------------------------------------
function openSidebarForNpc(npc: Npc): void {
  selectedNpc = npc;
  const slot = getSlot(npc.district.id);
  const artist = residentArtistByNpc.get(npc);
  if (artist) {
    // Prefer the artist id (real data) over the bare name so the Songs tab
    // filter matches by artistIds membership, not exact-string equality —
    // see src/sidebar.ts's doc comment on the multi-artist-track bug.
    const artistId = residentArtistIdByNpc.get(npc);
    openSidebar(slot, { section: "songs", filterArtist: artistId ?? artist, showEnter: mode === "village" });
  } else {
    openSidebar(slot, { showEnter: mode === "village" });
  }
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
 * villageNpcs's underlying array order. Village mode also includes Phase
 * 11's visitorNpcs, y-sorted together with villageNpcs the same way
 * renderVillage() draws them, so tapping a visitor opens the sidebar on
 * their district (openSidebarForNpc falls back to a plain district-open
 * when a tapped npc has no resident artist of its own, which a visitor npc
 * never does — see residentArtistByNpc). */
function interactionPool(): Npc[] {
  if (mode === "village") return [...villageDrawOrder(), ...visitorNpcs].sort((a, b) => a.y - b.y).reverse();
  if (currentDistrictId) {
    const leader = districtNpcsBySlot.get(currentDistrictId)!;
    const residents = (residentsBySlot.get(currentDistrictId) ?? []).map((r) => r.npc);
    return [leader, ...residents];
  }
  return [];
}

/** Phase 9: opens the sidebar straight to the global Notice board section
 * (same "ignores whichever character's header is showing" convention as the
 * Wrapped/Playlists tabs — see src/sidebar.ts's SECTIONS). Keeps whatever
 * character's sidebar is already open (if any) rather than forcing one, so
 * tapping the board mid-conversation doesn't change whose portrait is
 * showing; falls back to the roster's first slot when nothing's open yet, a
 * slot chosen only because *something* has to own the header chrome. */
function openNoticeBoard(): void {
  const slotId = sidebarSlotId();
  const slot = slotId ? getSlot(slotId) : SLOTS[0]!;
  openSidebar(slot, { section: "notice-board", showEnter: false });
}

function handleTap(clientX: number, clientY: number): void {
  const world = screenToWorld(clientX, clientY);
  const hit = interactionPool().find((npc) => hitTestNpc(npc, world.x, world.y));
  if (hit) {
    openSidebarForNpc(hit);
    return;
  }
  if (mode === "village" && hitTestNoticeBoard(NOTICE_BOARD_POS.x, NOTICE_BOARD_POS.y, world.x, world.y)) {
    openNoticeBoard();
    return;
  }
  if (isSidebarOpen()) closeSidebar();
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
  dismissVillageCaption();
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
    ev.preventDefault();
    stepZoom(ev.deltaY < 0 ? 1 : -1, { x: ev.clientX, y: ev.clientY });
  },
  { passive: false },
);

// ---------------------------------------------------------------------------
// Keyboard: Esc closes the sidebar, then exits a district, then blurs the
// canvas. Arrow keys pan the village camera, but never while a form field
// has focus (so typing in the Songs search/filter controls doesn't also
// move the map).
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
// (once the sidebar and any open district are already closed) so normal Tab
// order resumes.
canvas.addEventListener("keydown", (ev) => {
  const pool = interactionPool();
  if (pool.length === 0) return;

  if (ev.key === "Tab") {
    ev.preventDefault();
    keyboardCursor = (keyboardCursor + (ev.shiftKey ? -1 : 1) + pool.length) % pool.length;
    keyboardSelectedNpc = pool[keyboardCursor]!;
    return;
  }
  if (ev.key === "Enter" || ev.key === " ") {
    ev.preventDefault();
    const target = keyboardSelectedNpc ?? selectedNpc ?? nearestNpcToViewCenter(pool);
    if (target) openSidebarForNpc(target);
  }
});

window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    if (isSidebarOpen()) closeSidebar();
    else if (mode === "district") exitToVillage();
    else if (document.activeElement === canvas) canvas.blur();
    return;
  }
  if (isFormField(ev.target)) return;

  if (mode === "village" && ARROW_KEYS.has(ev.key)) {
    heldPanKeys.add(ev.key);
    ev.preventDefault();
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
  // Phase 13a: arrow-key panning is the closest thing this village sim has
  // to "the player walking" — src/sound.ts throttles this internally, so
  // calling it every held-key frame is fine.
  playFootstep();
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
backBtn.addEventListener("click", () => exitToVillage());
zoomInBtn.addEventListener("click", () => stepZoom(1));
zoomOutBtn.addEventListener("click", () => stepZoom(-1));

// ---------------------------------------------------------------------------
// Phase 13a: Snapshot / Record / Sound — see src/capture.ts, src/sound.ts.
// ---------------------------------------------------------------------------
initSoundToggle(soundBtn);

snapshotBtn.addEventListener("click", () => {
  const live = getLiveNowPlaying();
  const caption = live ? `Parth is listening to ${live.song} — ${live.artist}` : null;
  takeSnapshot(canvas, captionCanvas, caption);
});

let activeRecording: Recording | null = null;

function formatCountdown(remainingMs: number): string {
  return `REC 0:${String(Math.ceil(remainingMs / 1000)).padStart(2, "0")}`;
}

function endRecordingUi(): void {
  activeRecording = null;
  recordBtn.textContent = "Record";
  recordBtn.setAttribute("aria-pressed", "false");
  recordIndicator.hidden = true;
}

if (!isRecordingSupported()) {
  // Older iOS Safari has neither captureStream nor MediaRecorder — hide the
  // control entirely rather than offer a button that can't do anything.
  recordBtn.hidden = true;
} else {
  recordBtn.addEventListener("click", () => {
    if (activeRecording) {
      activeRecording.stop();
      return;
    }
    const recording = startRecording(
      canvas,
      (remainingMs) => (recordIndicator.textContent = formatCountdown(remainingMs)),
      (blob, mimeType) => {
        endRecordingUi();
        downloadRecording(blob, mimeType);
      },
    );
    if (!recording) return; // no accepted mime type after all — isRecordingSupported() was optimistic
    activeRecording = recording;
    recordBtn.textContent = "Stop";
    recordBtn.setAttribute("aria-pressed", "true");
    recordIndicator.hidden = false;
  });
}

// Phase 13b: swaps the village caption's default "how to look around" hint
// for a friendly explanation when the connected account genuinely has no
// listening data yet (src/listening-source.ts's isVillageEmpty) — called
// once at startup, right before the caption first shows, so a brand-new
// account reads as "waiting for its first play" rather than 17 leaders
// silently idling with no obvious reason why.
function applyEmptyAccountCaption(): void {
  if (!isVillageEmpty()) return;
  villageCaption.textContent =
    "No listening logged on this account yet — the village fills in once Parth's first play comes through.";
}

// Village caption: a one-time hint, not persistent chrome — fades out (the
// CSS transition; see .village-caption.is-dismissed) on a timeout or the
// user's first drag/tap/zoom, whichever comes first (see the pointerdown
// and stepZoom call sites below). Once dismissed it stays dismissed for the
// session — applyVillageScene() checks the flag before un-hiding it — so
// exiting a district back to the village doesn't resurrect it.
const VILLAGE_CAPTION_TIMEOUT_MS = 6000;
let villageCaptionDismissed = false;
function dismissVillageCaption(): void {
  if (villageCaptionDismissed) return;
  villageCaptionDismissed = true;
  villageCaption.classList.add("is-dismissed");
  // Layout space is only reclaimed once the fade finishes, not immediately —
  // .main's height doesn't depend on this element either way (flex:1 1 auto
  // with min-height:0, sized by its flex parent, not its content), so this
  // can't shift #game/.stage-area regardless, but waiting for the fade
  // avoids the text visibly popping out mid-transition.
  villageCaption.addEventListener("transitionend", () => (villageCaption.hidden = true), { once: true });
}
window.setTimeout(dismissVillageCaption, VILLAGE_CAPTION_TIMEOUT_MS);

const resizeObserver = new ResizeObserver(() => fitCanvas());
resizeObserver.observe(stageArea);
window.addEventListener("orientationchange", () => fitCanvas());
window.matchMedia(DESKTOP_QUERY).addEventListener("change", () => fitCanvas());

// ---------------------------------------------------------------------------
// Main loop — district NPCs (leaders + residents) keep wandering in the
// background regardless of the active scene, so switching back to a
// district preserves its state.
// ---------------------------------------------------------------------------
let lastTs: number | null = null;

function frame(ts: number): void {
  if (lastTs === null) lastTs = ts;
  const dt = Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;

  updateZoomAnim(ts);
  updatePanAnim(ts);

  // Phase 12: a Chronicle replay step (or its start/stop) changes which
  // visitors world-state.ts's getVisitors() reports — visitorNpcs is built
  // once, not derived fresh per frame like everything else here, so it needs
  // an explicit rebuild whenever that happens.
  const worldVersion = getWorldVersion();
  if (worldVersion !== lastWorldVersion) {
    lastWorldVersion = worldVersion;
    rebuildVisitors();
  }

  // Phase 13a: weather ambience is global (not per-view, same as getWeather()
  // itself), so one call per frame regardless of village/district mode.
  updateWeatherAmbience(getWeather());

  districtNpcsBySlot.forEach((npc, slotId) => {
    const { energy } = getMoodEnergy(slotId);
    updateNpc(npc, dt, ts, {
      isActive: mode === "district" && slotId === currentDistrictId,
      nowPlayingIntervalMs: NOW_PLAYING_INTERVAL_MS,
      getNowPlaying: () => getNowPlayingFor(npc.district.id),
      // Activity level (how busy the district is) and mood/energy (how its
      // music feels) are independent signals — the two multipliers stack.
      performChanceMul: ACTIVITY_TREATMENT[getActivity(slotId).level].performChanceMul * energyPerformMul(energy),
      energySpeedMul: energySpeedMul(energy),
    });
  });
  allResidents.forEach(({ npc }) =>
    updateNpc(npc, dt, ts, {
      isActive: false,
      nowPlayingIntervalMs: Number.POSITIVE_INFINITY,
      getNowPlaying: () => null,
      energySpeedMul: energySpeedMul(getMoodEnergy(npc.district.id).energy),
    }),
  );
  allCrowd.forEach((npc) =>
    updateNpc(npc, dt, ts, {
      isActive: false,
      nowPlayingIntervalMs: Number.POSITIVE_INFINITY,
      getNowPlaying: () => null,
      energySpeedMul: energySpeedMul(getMoodEnergy(npc.district.id).energy),
    }),
  );

  if (mode === "village") {
    applyKeyPan(dt);
    tickVillage(ts, dt);
    renderVillage(dt, ts);
    renderCaptions(villageCaptionLabels());
  } else {
    followActiveDistrictLeader(dt);
    renderDistrict(dt, ts);
    renderCaptions(districtCaptionLabels());
  }

  requestAnimationFrame(frame);
}

const urlsByKey = Object.fromEntries(
  Object.keys(ASSET_MANIFEST).map((key) => [key, assetUrl(key)]),
);

history.replaceState({ echoesDistrict: null }, "", `${location.pathname}${location.search}`);

// Derives residentsBySlot/allCrowd (and their lookup maps) from whatever
// /api/village currently holds (src/listening-source.ts). Called once at
// startup and again on every era change (see the onEraChange subscription
// below) — an era switch fetches a different range's artists, so the
// resident/crowd NPCs built from the old one would otherwise be stale.
function rebuildResidentsAndCrowd(): void {
  residentsBySlot = buildResidents(images);
  allResidents = Array.from(residentsBySlot.values()).flat();
  residentArtistByNpc = new Map(allResidents.map((r) => [r.npc, r.artistName]));
  residentArtistIdByNpc = new Map(allResidents.map((r) => [r.npc, r.artistId]));
  residentFadedByNpc = new Map(allResidents.map((r) => [r.npc, r.faded]));
  crowdBySlot = buildCrowd();
  allCrowd = Array.from(crowdBySlot.values()).flat();
}

/** Builds Phase 11's visitor markers from world-state.ts's getVisitors() —
 * call once world state has loaded (see initWorldState below). Unlike
 * rebuildResidentsAndCrowd, this doesn't need `images` (genericCharacter's
 * rig sheets are always loaded, never baked per-slot) and doesn't depend on
 * the era, so it isn't re-run on era changes. */
function rebuildVisitors(): void {
  visitorNpcs = [];
  visitorNameByNpc = new Map();
  getVisitors().forEach((visitor) => {
    const slot = SLOTS.find((s) => s.district.id === visitor.slotId);
    const anchor = slot && VILLAGE.anchors[slot.character.id];
    if (!slot || !anchor) return;
    const character = genericCharacter(`visitor:${visitor.slotId}:${visitor.artistId}`);
    const home = { x: anchor.x + 18, y: anchor.y - 10 };
    const npc = makeNpc(character, slot.district, home, { mapKey: VILLAGE.mapImage, wanderRadius: 0 });
    visitorNpcs.push(npc);
    visitorNameByNpc.set(npc, visitor.name);
  });
}

// initTopArtists() (below) makes the era tabs interactive before this file's
// own initial load (loadImages/initListeningSource) finishes — guards the
// subscription below against rebuilding residents from `images` while it's
// still {}. The initial load already fetches /api/village for whatever era
// is current at that point, so no era change is lost either way.
let initialLoadComplete = false;

// Phase 8b: the one global era (src/era.ts) changed, from either
// src/top-artists.ts's tabs or (were it ever added elsewhere) any other
// origin — re-fetch /api/village for it and rebuild everything derived from
// it. Deliberately doesn't touch camera/mode/scene state, unlike the
// startup path below.
onEraChange(() => {
  if (!initialLoadComplete) return;
  void (async () => {
    // refreshVillage() reports false if a later era switch already
    // superseded this fetch by the time it resolved (see its own doc
    // comment) — skip rebuilding from a response that isn't for the era
    // currently selected, so rapid tab switching ends on the right one
    // instead of flashing an in-between era's residents/sidebar content.
    const applied = await refreshVillage();
    if (!applied) return;
    rebuildResidentsAndCrowd();
    refreshSidebarContent();
  })();
});

// Started here rather than awaited inside the .then() below: GET /api/world
// doesn't need to know whether the village is connected to be requested
// (only whether its result gets *used* does — see initWorldState), so
// there's no reason to wait for loadImages/initListeningSource to finish
// before kicking it off. world-state.ts's fetchWorldResponse() never throws.
const worldFetch = fetchWorldResponse();

Promise.all([loadImages(urlsByKey), initListeningSource()]).then(async ([loaded]) => {
  images = loaded;
  setSidebarImages(images);
  bakeRecolors();
  // Phase 11: world state needs isVillageConnected(), only known once
  // initListeningSource() above has resolved — see world-state.ts's doc
  // comment on why `connected` is passed in rather than read there. Reuses
  // the already-in-flight worldFetch above instead of starting a second one.
  await initWorldState(isVillageConnected(), worldFetch);
  rebuildResidentsAndCrowd();
  applyEmptyAccountCaption();
  rebuildVisitors();
  applyVillageScene();
  requestAnimationFrame(frame);
  initialLoadComplete = true;

  // Dev-only walkability grid painter (see SPEC.md Phase 4) — guarded and
  // dynamically imported so it, and its import of the whole walkability
  // manifest, tree-shake out of the production bundle entirely.
  if (import.meta.env.DEV) {
    import("./dev/gridPainter").then(({ initGridPainter }) => {
      initGridPainter({
        getMapKey: () => (mode === "district" && currentDistrictId ? getSlot(currentDistrictId).district.bg : VILLAGE.mapImage),
        getCamera: () => ({ camX, camY, zoom }),
        screenToWorld,
        gameCanvas: canvas,
      });
    });
  }
});
