// NPC state machine: idle/wander, walking home to "perform" a now-playing
// moment, then idling back at home. Movement follows merged straight-line
// path segments (see src/pathfinding.ts) instead of a fixed patrol loop —
// see SPEC.md Phase 4. Ported from prototypes/konoha-demo/main.js.

import type { CharacterDef, DistrictDef, Point, WalkGrid } from "../data/types";
import { getWalkGrid } from "../data/loader";
import { type Cell, cellCenter, findPath, mergeUpDiagonals, reachableWithin, worldToCell } from "./pathfinding";

export const WALK_SPEED = 22; // px/sec in world space, before an NPC's own speedMul

export type Direction = "down" | "left" | "right" | "up";
export type NpcState = "idle" | "walk" | "traveling_home" | "performing";

export interface Npc {
  character: CharacterDef;
  district: DistrictDef;
  home: Point;
  /** Asset key of the map this NPC walks within (a district's `bg`, or
   * VILLAGE.mapImage for a whole-village-view instance) — its walkability
   * grid and wander-reservation bookkeeping are both keyed by this. */
  mapKey: string;
  grid: WalkGrid;
  /** Static candidate wander cells (reachableWithin(homeCell, R)), computed
   * once at spawn — see SPEC.md Phase 4's "wander targets, not fixed loops". */
  wanderCandidates: Cell[];
  /** Per-NPC multiplier on WALK_SPEED, 0.85-1.15, seeded from hashSeed(id) —
   * the hook Phase 7's mood system will eventually set instead. */
  speedMul: number;
  x: number;
  y: number;
  dir: Direction;
  state: NpcState;
  frame: number;
  /** Position within the boomerang walk cycle (see WALK_CYCLE) — `frame` is
   * derived from this, not incremented directly. */
  cyclePhase: number;
  frameTimer: number;
  idleTimer: number;
  caption: string | null;
  captionTimer: number;
  performTimer: number;
  performFrame: number;
  returnAfterPerform: NpcState | null;
  lastNowPlaying: number;
  /** Remaining merged path segment endpoints (world px, cell centers) to
   * walk through, in order — see src/pathfinding.ts's findPath. */
  path: Point[];
  /** Index into `path` of the segment currently being walked. */
  pathIdx: number;
  /** Cell key this NPC currently holds in the per-map wander reservation
   * set (see reserveCell/releaseReservation), or null if it holds none. */
  reservedCellKey: string | null;
}

function cellKeyOf(cell: Cell): string {
  return `${cell.cx},${cell.cy}`;
}

// Wander targets are reserved per map so two NPCs don't wander onto the
// exact same cell and visually superimpose — see SPEC.md Phase 4.
const reservedCellsByMap = new Map<string, Set<string>>();

function reservedCellsFor(mapKey: string): Set<string> {
  let set = reservedCellsByMap.get(mapKey);
  if (!set) {
    set = new Set();
    reservedCellsByMap.set(mapKey, set);
  }
  return set;
}

function releaseReservation(npc: Npc): void {
  if (npc.reservedCellKey === null) return;
  reservedCellsFor(npc.mapKey).delete(npc.reservedCellKey);
  npc.reservedCellKey = null;
}

function reserveCell(npc: Npc, cell: Cell): void {
  releaseReservation(npc);
  const key = cellKeyOf(cell);
  reservedCellsFor(npc.mapKey).add(key);
  npc.reservedCellKey = key;
}

// Cheap, deterministic string hash (FNV-1a) — moved here from main.ts's old
// patrolFor (deleted along with the fixed patrol loop it shaped). Used to
// derive stable per-character variety (currently just speedMul) that stays
// identical across reloads rather than jittering with Math.random().
export function hashSeed(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const SPEED_MUL_MIN = 0.85;
const SPEED_MUL_SPREAD = 0.3; // 0.85 .. 1.15

function speedMulFor(id: string): number {
  const frac = (hashSeed(id) % 1000) / 1000;
  return SPEED_MUL_MIN + frac * SPEED_MUL_SPREAD;
}

// Skewed short (most idles are brief) with an occasional long stand — see
// SPEC.md Phase 4's "varied dwell" requirement.
const LONG_DWELL_CHANCE = 0.15;

function pickDwell(): number {
  if (Math.random() < LONG_DWELL_CHANCE) return 8 + Math.random() * 6;
  const r = Math.random();
  return 1 + r * r * 6;
}

export interface MakeNpcOptions {
  /** Walkability/asset key this NPC walks within. Defaults to its own
   * district's `bg` (a district's own leader, wandering its own interior) —
   * pass VILLAGE.mapImage for a whole-village-view instance. */
  mapKey?: string;
  /** Wander radius in cells, fed to reachableWithin at spawn — see SPEC.md
   * Phase 4: village leaders 5, district leaders 4 (the default here),
   * residents 2-3 (residents must stay small; src/residents.ts encodes play
   * count as distance from the leader, and a wide wander erases that). */
  wanderRadius?: number;
}

const DEFAULT_WANDER_RADIUS = 4; // a district leader, in its own district

/**
 * @param home Where this NPC returns to perform (defaults to district.home,
 *   overridden in the whole-village view where anchors differ per instance,
 *   and in src/residents.ts where it's a leader-relative offset).
 */
export function makeNpc(
  character: CharacterDef,
  district: DistrictDef,
  home: Point = district.home,
  opts: MakeNpcOptions = {},
): Npc {
  const mapKey = opts.mapKey ?? district.bg;
  const grid = getWalkGrid(mapKey);
  const wanderRadius = opts.wanderRadius ?? DEFAULT_WANDER_RADIUS;
  return {
    character,
    district,
    home,
    mapKey,
    grid,
    wanderCandidates: reachableWithin(worldToCell(home, grid), wanderRadius, grid),
    speedMul: speedMulFor(character.id),
    x: home.x,
    y: home.y,
    dir: "down",
    state: "idle",
    frame: 0,
    cyclePhase: 0,
    frameTimer: 0,
    idleTimer: pickDwell(),
    caption: null,
    captionTimer: 0,
    performTimer: 0,
    performFrame: 0,
    returnAfterPerform: null,
    lastNowPlaying: 0,
    path: [],
    pathIdx: 0,
    reservedCellKey: null,
  };
}

// A direction switch must dominate the current movement axis by this factor
// before it takes over — otherwise dx/dy hovering near parity near a segment
// endpoint flips the sprite's facing back and forth every frame. Normal
// (axis-aligned) segments never get near this boundary; it only matters for
// the diagonal legs src/pathfinding.ts's mergeUpDiagonals produces, whose
// dx/dy ratio (>= 2) is built to clear it comfortably.
const DIR_HYSTERESIS = 1.3;

export function pickDir(dx: number, dy: number, current?: Direction): Direction {
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  const onXAxis = current === "left" || current === "right";
  const onYAxis = current === "up" || current === "down";
  let horizontal: boolean;
  if (onXAxis) horizontal = absDx * DIR_HYSTERESIS >= absDy;
  else if (onYAxis) horizontal = absDx > absDy * DIR_HYSTERESIS;
  else horizontal = absDx > absDy;
  return horizontal ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
}

// The 3 frames per direction on these sheets are [pose A, a middle pose,
// pose B] (which pose is the "neutral" one varies per character/sheet — see
// scripts/detect-frames.py's contact sheets). Looping 0,1,2,0,1,2 jump-cuts
// from pose B straight back to pose A. Boomeranging through the array
// instead — 0,1,2,1,0,1,2,1,... — always steps to an adjacent frame, which
// for the common case (middle frame = a neutral standing pose) is exactly
// the classic stand/step-A/stand/step-B walk cycle.
const WALK_CYCLE = [0, 1, 2, 1];

export function startPerform(npc: Npc, andThen: NpcState | null): void {
  npc.state = "performing";
  npc.performTimer = 0;
  npc.performFrame = 0;
  npc.returnAfterPerform = andThen;
}

export function setCaption(npc: Npc, text: string, seconds: number): void {
  npc.caption = text;
  npc.captionTimer = seconds;
}

export interface NowPlayingInfo {
  artist: string;
  song: string;
}

export interface UpdateOptions {
  /** When true, this NPC may trigger its own now-playing moment (single-district view). */
  isActive: boolean;
  nowPlayingIntervalMs: number;
  /** Looked up from src/sample-data.ts by the caller — npc.ts stays data-source agnostic.
   * Returning null (a dormant slot with no songs) means this NPC never performs. */
  getNowPlaying: () => NowPlayingInfo | null;
  /** Multiplies the spontaneous "vibing" chance below (default 1) — a
   * district's activity level (see shared/activity.ts's ACTIVITY_TREATMENT)
   * makes its leader perform more or less often while you're inside it. */
  performChanceMul?: number;
}

/** Sets `npc.dir` from the direction of its current path segment — facing
 * is decided once per segment, not recomputed every frame (see followPath). */
function setSegmentDir(npc: Npc): void {
  const target = npc.path[npc.pathIdx];
  if (!target) return;
  npc.dir = pickDir(target.x - npc.x, target.y - npc.y, npc.dir);
}

const MAX_WANDER_TRIES = 5;
const MAX_WANDER_SEGMENTS = 3; // re-pick past this — short legs read as "alive", long treks don't

/** Picks a random reachable, unreserved wander target and paths to it (up to
 * MAX_WANDER_TRIES attempts, re-picking on an unreachable target, a path
 * longer than MAX_WANDER_SEGMENTS, or — for characters with no back-facing
 * art — an up leg mergeUpDiagonals can't turn into a side-facing diagonal).
 * Leaves the NPC idle (to retry next idle beat) if every attempt fails. */
function tryStartWander(npc: Npc): void {
  const { grid } = npc;
  const currentCell = worldToCell({ x: npc.x, y: npc.y }, grid);
  const reserved = reservedCellsFor(npc.mapKey);

  for (let attempt = 0; attempt < MAX_WANDER_TRIES; attempt++) {
    const candidates = npc.wanderCandidates.filter(
      (c) => !(c.cx === currentCell.cx && c.cy === currentCell.cy) && !reserved.has(cellKeyOf(c)),
    );
    if (candidates.length === 0) break;
    const targetCell = candidates[Math.floor(Math.random() * candidates.length)]!;
    const targetPoint = cellCenter(targetCell, grid);
    const rawPath = findPath({ x: npc.x, y: npc.y }, targetPoint, grid);
    if (!rawPath || rawPath.length === 0 || rawPath.length > MAX_WANDER_SEGMENTS) continue;

    let path = rawPath;
    if (npc.character.lacksBackArt) {
      const merged = mergeUpDiagonals({ x: npc.x, y: npc.y }, rawPath, grid);
      if (!merged) continue;
      path = merged;
    }

    reserveCell(npc, targetCell);
    npc.path = path;
    npc.pathIdx = 0;
    npc.state = "walk";
    setSegmentDir(npc);
    return;
  }
  // Nothing viable this cycle (fully reserved, or every candidate failed the
  // segment/diagonal checks) — wait and try again next idle beat.
  npc.idleTimer = pickDwell();
}

function advanceWalkFrame(npc: Npc, dt: number): void {
  npc.frameTimer += dt;
  const frameTime = 1 / npc.character.fps;
  if (npc.frameTimer >= frameTime) {
    npc.frameTimer -= frameTime;
    npc.cyclePhase = (npc.cyclePhase + 1) % WALK_CYCLE.length;
    npc.frame = WALK_CYCLE[npc.cyclePhase]!;
  }
}

/** Walks continuously toward npc.path[npc.pathIdx], advancing to the next
 * segment on arrival (no per-cell hitch — a segment already spans several
 * cells) and calling `onArrive` once the whole path is consumed. Constant
 * speed, no easing: this game's "natural" is stop-turn-go, not steering. */
function followPath(npc: Npc, dt: number, onArrive: () => void): void {
  const target = npc.path[npc.pathIdx];
  if (!target) {
    onArrive();
    return;
  }
  const dx = target.x - npc.x;
  const dy = target.y - npc.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) {
    npc.x = target.x;
    npc.y = target.y;
    npc.pathIdx++;
    if (npc.pathIdx >= npc.path.length) onArrive();
    else setSegmentDir(npc);
    return;
  }
  const step = Math.min(WALK_SPEED * npc.speedMul * dt, dist);
  npc.x += (dx / dist) * step;
  npc.y += (dy / dist) * step;
  advanceWalkFrame(npc, dt);
}

/** Sends npc home to perform (the "traveling_home" state below, which walks
 * it to npc.home and then calls startPerform on arrival) — factored out so
 * both this file's own periodic isActive check and an external transition
 * trigger (triggerNowPlayingReaction, below) share the exact same
 * walk-then-perform sequence. */
function goHomeToPerform(npc: Npc, now: number): void {
  npc.lastNowPlaying = now;
  releaseReservation(npc);
  npc.state = "traveling_home";
  npc.path = findPath({ x: npc.x, y: npc.y }, npc.home, npc.grid) ?? [];
  npc.pathIdx = 0;
  if (npc.path.length > 0) setSegmentDir(npc);
}

/** Triggers this NPC's walk-home-and-perform sequence immediately, bypassing
 * the isActive/nowPlayingIntervalMs gate updateNpc checks below — used when
 * a live now-playing transition is detected out-of-band (see
 * src/now-playing-card.ts's subscribeNowPlaying, wired up in main.ts) so the
 * reaction lands within seconds of the real Spotify change instead of
 * waiting on this NPC's own timer (SPEC.md Phase 5b). No-ops if the NPC is
 * already traveling home or performing, so a rapid back-to-back track
 * change can't interrupt a reaction already in flight. */
export function triggerNowPlayingReaction(npc: Npc, now: number): void {
  if (npc.state === "idle" || npc.state === "walk") goHomeToPerform(npc, now);
}

export function updateNpc(npc: Npc, dt: number, now: number, opts: UpdateOptions): void {
  const { character } = npc;

  if (
    opts.isActive &&
    now - npc.lastNowPlaying > opts.nowPlayingIntervalMs &&
    (npc.state === "idle" || npc.state === "walk") &&
    opts.getNowPlaying()
  ) {
    goHomeToPerform(npc, now);
  }

  if (npc.captionTimer > 0) {
    npc.captionTimer -= dt;
    if (npc.captionTimer <= 0) npc.caption = null;
  }

  if (npc.state === "performing") {
    npc.performTimer += dt;
    const perFrameTime = 0.45;
    const frameCount = npc.character.specials.length || 1;
    npc.performFrame = Math.floor(npc.performTimer / perFrameTime) % frameCount;
    if (npc.performTimer >= perFrameTime * frameCount * 1.6) {
      const next = npc.returnAfterPerform ?? "idle";
      npc.returnAfterPerform = null;
      npc.state = next;
      if (next === "idle") npc.idleTimer = pickDwell();
    }
    return;
  }

  if (npc.state === "traveling_home") {
    followPath(npc, dt, () => {
      npc.x = npc.home.x;
      npc.y = npc.home.y;
      const info = opts.getNowPlaying();
      if (info) setCaption(npc, `Now playing: ${info.artist} – ${info.song}`, 3.2);
      // Performing ends back at idle, right where it already is (home) — the
      // old separate "walk back to patrol start" leg is gone; wander resumes
      // from here on its own next idle beat.
      startPerform(npc, "idle");
    });
    return;
  }

  if (npc.state === "idle") {
    npc.idleTimer -= dt;
    if (npc.idleTimer <= 0) tryStartWander(npc);
    if (opts.isActive && Math.random() < 0.0006 * (opts.performChanceMul ?? 1)) {
      const info = opts.getNowPlaying();
      if (info) {
        startPerform(npc, "idle");
        setCaption(npc, `${character.name.split(" ")[0]} is vibing to ${info.artist}`, 2.4);
      }
    }
    return;
  }

  if (npc.state === "walk") {
    followPath(npc, dt, () => {
      releaseReservation(npc);
      npc.state = "idle";
      npc.idleTimer = pickDwell();
    });
  }
}
