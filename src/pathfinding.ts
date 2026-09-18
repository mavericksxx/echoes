// Pure walkability-grid utilities: cell/world conversions, BFS reachability,
// and 4-connected A* with a turn penalty. No DOM, no canvas — this is the
// same pathfinding surface Phase 5 will build on (see findPath's doc
// comment), so it stays independent of src/npc.ts's state machine.

import type { Point, WalkGrid } from "../data/types";

export interface Cell {
  cx: number;
  cy: number;
}

const NEIGHBOR_OFFSETS: [number, number][] = [
  [0, -1], // up
  [1, 0], // right
  [0, 1], // down
  [-1, 0], // left
];

function cellKeyOf(cell: Cell): string {
  return `${cell.cx},${cell.cy}`;
}

export function worldToCell(p: Point, grid: WalkGrid): Cell {
  return { cx: Math.floor(p.x / grid.cell), cy: Math.floor(p.y / grid.cell) };
}

export function cellCenter(cell: Cell, grid: WalkGrid): Point {
  return { x: (cell.cx + 0.5) * grid.cell, y: (cell.cy + 0.5) * grid.cell };
}

export function isWalkable(cell: Cell, grid: WalkGrid): boolean {
  if (cell.cx < 0 || cell.cy < 0 || cell.cx >= grid.cols || cell.cy >= grid.rows) return false;
  return grid.grid[cell.cy]?.[cell.cx] === ".";
}

/** BFS outward from the cell containing `p` for the nearest walkable cell,
 * returned as that cell's center — used to snap runtime-computed points
 * (resident homes/crowd offsets, see src/residents.ts) that data/*.json
 * checks can't validate. Returns `p` unchanged if it's already walkable, or
 * if the grid has no walkable cells at all (a data bug, not this function's
 * problem to solve). */
export function nearestWalkable(p: Point, grid: WalkGrid): Point {
  const start = worldToCell(p, grid);
  if (isWalkable(start, grid)) return p;

  const visited = new Set<string>([cellKeyOf(start)]);
  let frontier: Cell[] = [start];
  while (frontier.length > 0) {
    const next: Cell[] = [];
    for (const cur of frontier) {
      for (const [dx, dy] of NEIGHBOR_OFFSETS) {
        const n: Cell = { cx: cur.cx + dx, cy: cur.cy + dy };
        const key = cellKeyOf(n);
        if (visited.has(key)) continue;
        visited.add(key);
        if (n.cx < 0 || n.cy < 0 || n.cx >= grid.cols || n.cy >= grid.rows) continue;
        if (isWalkable(n, grid)) return cellCenter(n, grid);
        next.push(n);
      }
    }
    frontier = next;
  }
  return p;
}

/** Every walkable cell reachable from `start` within `radius` path steps
 * (BFS in graph distance, respecting walls — not a Euclidean disc). Includes
 * `start` itself. Returns `[]` if `start` isn't walkable. */
export function reachableWithin(start: Cell, radius: number, grid: WalkGrid): Cell[] {
  if (!isWalkable(start, grid)) return [];
  const dist = new Map<string, number>([[cellKeyOf(start), 0]]);
  const result: Cell[] = [start];
  const queue: Cell[] = [start];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++]!;
    const curDist = dist.get(cellKeyOf(cur))!;
    if (curDist >= radius) continue;
    for (const [dx, dy] of NEIGHBOR_OFFSETS) {
      const n: Cell = { cx: cur.cx + dx, cy: cur.cy + dy };
      const key = cellKeyOf(n);
      if (dist.has(key) || !isWalkable(n, grid)) continue;
      dist.set(key, curDist + 1);
      queue.push(n);
      result.push(n);
    }
  }
  return result;
}

// A* node state is (cell, incoming direction) rather than just cell, so the
// turn penalty below can see which way the path was already moving.
// direction index: 0=up, 1=right, 2=down, 3=left; -1 = start (no incoming
// direction, so the first step is never penalized for "turning").
interface SearchNode {
  cell: Cell;
  dir: number;
}

function nodeKey(n: SearchNode): string {
  return `${n.cell.cx},${n.cell.cy},${n.dir}`;
}

// Strictly less than the cost of one step, so the search never trades a
// detour (an extra step) for fewer turns — only ties among shortest paths
// are broken toward fewer turns (L-shapes instead of staircases).
const TURN_COST = 0.5;

function heuristic(a: Cell, b: Cell): number {
  return Math.abs(a.cx - b.cx) + Math.abs(a.cy - b.cy);
}

/** Merges a start->goal cell path into waypoints at each direction change
 * (plus the goal), i.e. one point per straight-line segment — the "walk a
 * few tiles, stop, turn" idiom this game wants, not a cell-by-cell hitch.
 * `cellsFromStart` includes the start cell at index 0. */
function mergeIntoSegments(cellsFromStart: Cell[], grid: WalkGrid): Point[] {
  const waypoints: Point[] = [];
  for (let i = 1; i < cellsFromStart.length; i++) {
    const prev = cellsFromStart[i - 1]!;
    const cur = cellsFromStart[i]!;
    const dx = cur.cx - prev.cx;
    const dy = cur.cy - prev.cy;
    const next = cellsFromStart[i + 1];
    const sameAsNext = next !== undefined && next.cx - cur.cx === dx && next.cy - cur.cy === dy;
    if (!sameAsNext) waypoints.push(cellCenter(cur, grid));
  }
  return waypoints;
}

/**
 * 4-connected A* from `from` to `to`, with a turn penalty so ties among
 * shortest paths resolve to the fewest turns (L-shapes, not staircases).
 * Returns merged segment endpoints in world pixels (cell centers) — never a
 * cell-by-cell path — excluding `from` itself (the caller is already there).
 * `null` if either endpoint is unwalkable or no path exists. `[]` if `from`
 * and `to` are already the same cell.
 *
 * This is Phase 5's pathfinding API too — keep the signature stable.
 */
export function findPath(from: Point, to: Point, grid: WalkGrid): Point[] | null {
  const start = worldToCell(from, grid);
  const goal = worldToCell(to, grid);
  if (!isWalkable(start, grid) || !isWalkable(goal, grid)) return null;
  if (start.cx === goal.cx && start.cy === goal.cy) return [];

  const startNode: SearchNode = { cell: start, dir: -1 };
  const gScore = new Map<string, number>([[nodeKey(startNode), 0]]);
  const cameFrom = new Map<string, SearchNode>();
  const open: { node: SearchNode; f: number }[] = [{ node: startNode, f: heuristic(start, goal) }];
  const closed = new Set<string>();

  while (open.length > 0) {
    open.sort((a, b) => a.f - b.f);
    const current = open.shift()!;
    const key = nodeKey(current.node);
    if (closed.has(key)) continue;
    closed.add(key);

    if (current.node.cell.cx === goal.cx && current.node.cell.cy === goal.cy) {
      const cellsFromStart: Cell[] = [current.node.cell];
      let node: SearchNode | undefined = current.node;
      for (;;) {
        const parent: SearchNode | undefined = cameFrom.get(nodeKey(node));
        if (!parent) break;
        cellsFromStart.push(parent.cell);
        node = parent;
      }
      cellsFromStart.reverse();
      return mergeIntoSegments(cellsFromStart, grid);
    }

    for (let d = 0; d < NEIGHBOR_OFFSETS.length; d++) {
      const [dx, dy] = NEIGHBOR_OFFSETS[d]!;
      const nextCell: Cell = { cx: current.node.cell.cx + dx, cy: current.node.cell.cy + dy };
      if (!isWalkable(nextCell, grid)) continue;
      const turnCost = current.node.dir === -1 || current.node.dir === d ? 0 : TURN_COST;
      const g = gScore.get(key)! + 1 + turnCost;
      const nextNode: SearchNode = { cell: nextCell, dir: d };
      const nKey = nodeKey(nextNode);
      if (g < (gScore.get(nKey) ?? Infinity)) {
        gScore.set(nKey, g);
        cameFrom.set(nKey, current.node);
        open.push({ node: nextNode, f: g + heuristic(nextCell, goal) });
      }
    }
  }
  return null;
}

interface Segment {
  from: Point;
  to: Point;
  dx: number;
  dy: number;
  lenCells: number;
  axis: "up" | "down" | "left" | "right" | "diagonal";
}

function toSegments(start: Point, waypoints: Point[], grid: WalkGrid): Segment[] {
  const points = [start, ...waypoints];
  const segs: Segment[] = [];
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1]!;
    const to = points[i]!;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const lenCells = Math.round(Math.max(Math.abs(dx), Math.abs(dy)) / grid.cell);
    const axis: Segment["axis"] =
      Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
    segs.push({ from, to, dx, dy, lenCells, axis });
  }
  return segs;
}

// Sample a diagonal-merged leg every ~4px and require every sample to land
// on a walkable cell — the diagonal cuts across cells the original L-shaped
// path never actually traversed, which a straight-line-of-sight check alone
// wouldn't catch on an irregular room.
const DIAGONAL_SAMPLE_STEP_PX = 4;

function diagonalIsClear(from: Point, to: Point, grid: WalkGrid): boolean {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(dist / DIAGONAL_SAMPLE_STEP_PX));
  for (let t = 0; t <= steps; t++) {
    const frac = t / steps;
    const p = { x: from.x + (to.x - from.x) * frac, y: from.y + (to.y - from.y) * frac };
    if (!isWalkable(worldToCell(p, grid), grid)) return false;
  }
  return true;
}

/**
 * For characters with no back-facing walk art (CharacterDef.lacksBackArt):
 * a plain "up" leg makes them moonwalk, but pure axis-aligned wander must
 * eventually go up or they drift south forever. This accepts a `findPath`
 * result only if every "up" segment is exactly 1 cell long AND sits next to
 * a horizontal (left/right) segment of >= 2 cells — merging each such pair
 * into one diagonal leg, whose dx/dy ratio (>= 2) clears pickDir's
 * DIR_HYSTERESIS (1.3), so the character still resolves as side-facing.
 * Returns `null` (reject this path/target, caller should re-pick) if any
 * "up" segment doesn't qualify, or if the merged diagonal cuts through a
 * blocked cell (see diagonalIsClear).
 */
export function mergeUpDiagonals(start: Point, waypoints: Point[], grid: WalkGrid): Point[] | null {
  const segs = toSegments(start, waypoints, grid);
  if (segs.some((s) => s.axis === "up" && s.lenCells !== 1)) return null;

  const merged: Segment[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (s.axis !== "up") {
      merged.push(s);
      continue;
    }
    const prev = merged[merged.length - 1];
    if (prev && (prev.axis === "left" || prev.axis === "right") && prev.lenCells >= 2) {
      merged[merged.length - 1] = {
        from: prev.from,
        to: s.to,
        dx: s.to.x - prev.from.x,
        dy: s.to.y - prev.from.y,
        lenCells: -1,
        axis: "diagonal",
      };
      continue;
    }
    const next = segs[i + 1];
    if (next && (next.axis === "left" || next.axis === "right") && next.lenCells >= 2) {
      merged.push({
        from: s.from,
        to: next.to,
        dx: next.to.x - s.from.x,
        dy: next.to.y - s.from.y,
        lenCells: -1,
        axis: "diagonal",
      });
      i++; // consumed `next` too
      continue;
    }
    return null; // an "up" leg with no adjacent horizontal run to merge into
  }

  for (const s of merged) {
    if (s.axis === "diagonal" && !diagonalIsClear(s.from, s.to, grid)) return null;
  }
  return merged.map((s) => s.to);
}
