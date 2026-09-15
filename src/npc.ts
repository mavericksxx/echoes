// NPC state machine: idle/patrol wandering, walking home to "perform" a
// now-playing moment, then walking back. Ported from prototypes/konoha-demo/main.js.

import type { CharacterDef, DistrictDef, Point } from "../data/types";

export const WALK_SPEED = 22; // px/sec in world space

export type Direction = "down" | "left" | "right" | "up";
export type NpcState = "idle" | "walk" | "traveling_home" | "performing" | "traveling_back";

export interface Npc {
  character: CharacterDef;
  district: DistrictDef;
  home: Point;
  patrol: Point[];
  x: number;
  y: number;
  patrolIdx: number;
  dir: Direction;
  state: NpcState;
  frame: number;
  frameTimer: number;
  idleTimer: number;
  caption: string | null;
  captionTimer: number;
  performTimer: number;
  performFrame: number;
  returnAfterPerform: NpcState | null;
  lastNowPlaying: number;
}

/**
 * @param home Where this NPC returns to perform (defaults to district.home,
 *   overridden in the whole-village view where anchors differ per instance).
 * @param patrol Wander waypoints (defaults to district.patrol).
 */
export function makeNpc(
  character: CharacterDef,
  district: DistrictDef,
  home: Point = district.home,
  patrol: Point[] = district.patrol,
): Npc {
  const start = patrol[0] ?? home;
  return {
    character,
    district,
    home,
    patrol,
    x: start.x,
    y: start.y,
    patrolIdx: 0,
    dir: "down",
    state: "idle",
    frame: 0,
    frameTimer: 0,
    idleTimer: 1 + Math.random() * 2,
    caption: null,
    captionTimer: 0,
    performTimer: 0,
    performFrame: 0,
    returnAfterPerform: null,
    lastNowPlaying: 0,
  };
}

export function pickDir(dx: number, dy: number): Direction {
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

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
}

export function updateNpc(npc: Npc, dt: number, now: number, opts: UpdateOptions): void {
  const { character } = npc;

  if (
    opts.isActive &&
    now - npc.lastNowPlaying > opts.nowPlayingIntervalMs &&
    (npc.state === "idle" || npc.state === "walk") &&
    opts.getNowPlaying()
  ) {
    npc.lastNowPlaying = now;
    npc.state = "traveling_home";
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
      npc.state = npc.returnAfterPerform ?? "idle";
      npc.returnAfterPerform = null;
    }
    return;
  }

  if (npc.state === "traveling_home") {
    stepToward(npc, npc.home, dt, () => {
      npc.x = npc.home.x;
      npc.y = npc.home.y;
      const info = opts.getNowPlaying();
      if (info) setCaption(npc, `Now playing: ${info.artist} – ${info.song}`, 3.2);
      startPerform(npc, "traveling_back");
    });
    return;
  }

  if (npc.state === "traveling_back") {
    const home = npc.patrol[0] ?? npc.home;
    stepToward(npc, home, dt, () => {
      npc.state = "idle";
      npc.idleTimer = 1 + Math.random() * 2;
    });
    return;
  }

  if (npc.state === "idle") {
    npc.idleTimer -= dt;
    if (npc.idleTimer <= 0) {
      npc.patrolIdx = (npc.patrolIdx + 1) % npc.patrol.length;
      npc.state = "walk";
    }
    if (opts.isActive && Math.random() < 0.0006) {
      const info = opts.getNowPlaying();
      if (info) {
        startPerform(npc, "idle");
        setCaption(npc, `${character.name.split(" ")[0]} is vibing to ${info.artist}`, 2.4);
      }
    }
    return;
  }

  if (npc.state === "walk") {
    const target = npc.patrol[npc.patrolIdx] ?? npc.home;
    stepToward(npc, target, dt, () => {
      npc.state = "idle";
      npc.idleTimer = 1 + Math.random() * 2.5;
    });
  }
}

function stepToward(npc: Npc, target: Point, dt: number, onArrive: () => void): void {
  const dx = target.x - npc.x;
  const dy = target.y - npc.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 2) {
    onArrive();
    return;
  }
  npc.dir = pickDir(dx, dy);
  const step = Math.min(WALK_SPEED * dt, dist);
  npc.x += (dx / dist) * step;
  npc.y += (dy / dist) * step;
  npc.frameTimer += dt;
  const frameTime = 1 / npc.character.fps;
  if (npc.frameTimer >= frameTime) {
    npc.frameTimer -= frameTime;
    npc.frame = (npc.frame + 1) % 3;
  }
}
