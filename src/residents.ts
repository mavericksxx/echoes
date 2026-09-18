// District resident NPCs: the genre leader's district isn't just their own —
// a handful of that genre's top artists "live" there too, wandering the same
// interior with the existing NPC state machine (see src/npc.ts), built from
// the generic "hidden leaf ninja" rig sheet (data/npcRigs.json) since there's
// no real per-artist sprite yet. Populated from src/listening-source.ts
// (real /api/village data once connected+live, sample data otherwise). See
// SPEC.md "Phase 2.5" for the size check behind RESIDENT_CAP, and its
// Phase 3 bullet for placement-encodes-play-count + faded/asleep residents.

import type { CharacterDef, DistrictDef, Point } from "../data/types";
import { NPC_RIGS, SLOTS, assetSize, getWalkGrid } from "../data/loader";
import { hashSeed, makeNpc, type Npc } from "./npc";
import { nearestWalkable } from "./pathfinding";
import { getArtists } from "./listening-source";
import { bakeRecolor } from "./recolor";
import type { ImageMap } from "./render";
import { ACTIVITY_TREATMENT, type ActivityLevel } from "../shared/activity";

/**
 * Phase 2.5 size check: rendered (mentally, against the actual crop
 * dimensions) a leader + 4 labeled residents in the smallest shop interior
 * (shopSweets, 200x231) at a 390px-wide phone view. Even at the larger
 * interiors, 5 persistent name labels plus "now playing" captions crowd a
 * room this small. Rather than vary the cap by interior size (extra
 * per-slot bookkeeping for a marginal gain), every district caps at 3
 * residents — comfortably staggerable without the collision-avoidance in
 * drawCaptions() having to hide labels on the regular.
 */
export const RESIDENT_CAP = 3;

const RIG_IDS = Object.keys(NPC_RIGS);

// Subtle per-resident tints — small hue-rotate + brightness/saturate
// nudges, not full hue sweeps, so outfits vary without the skin tones
// shifting into anything alien-looking. Index 0 (the first resident in a
// district) gets no tint at all and uses the bare rig sheet.
const RESIDENT_TINTS = ["hue-rotate(14deg) saturate(1.1)", "hue-rotate(-16deg) brightness(1.05)"];

export interface Resident {
  npc: Npc;
  artistName: string;
  /** Real data only — used to open the sidebar's Songs tab filtered to this
   * artist by id (see main.ts's openSidebarForNpc). Filtering by name alone
   * breaks on multi-artist tracks — see src/sidebar.ts. */
  artistId?: string;
  /** An artist who dropped out of the current range (see /api/village's
   * "faded" artists) — rendered dimmed and stationary, not wandering. */
  faded: boolean;
}

function residentCharacter(rigId: string, sheetKey: string): CharacterDef {
  const rig = NPC_RIGS[rigId]!;
  return {
    id: `rig-${rigId}`,
    name: rigId,
    sheet: sheetKey,
    fps: 5,
    anims: {
      walk_down: rig.down,
      walk_left: rig.side,
      walk_right: rig.side,
      walk_up: rig.up,
    },
    idle: rig.down[1] ?? rig.down[0]!,
    battleSheet: sheetKey,
    specials: [],
    mirrorDirs: rig.facing === "left" ? ["right"] : ["left"],
  };
}

function residentSheetKey(rigId: string, tintIndex: number): string {
  const base = NPC_RIGS[rigId]!.sheet;
  return tintIndex === 0 ? base : `${base}::tint${tintIndex}`;
}

/** Bakes the tinted rig-sheet variants residents need into `images` under
 * synthetic keys (see residentSheetKey), so drawNpc's plain `images[sheet]`
 * lookup works unchanged. Idempotent — bakeRecolor caches by (source,
 * filter), so calling this more than once is harmless. */
function ensureTintedSheets(images: ImageMap): void {
  const baseSheetKeys = new Set(RIG_IDS.map((id) => NPC_RIGS[id]!.sheet));
  baseSheetKeys.forEach((key) => {
    const img = images[key];
    if (!(img instanceof HTMLImageElement)) return;
    RESIDENT_TINTS.forEach((filter, i) => {
      images[`${key}::tint${i + 1}`] = bakeRecolor(img, filter);
    });
  });
}

function clampPoint(x: number, y: number, w: number, h: number, margin = 15): Point {
  return {
    x: Math.min(w - margin, Math.max(margin, x)),
    y: Math.min(h - margin, Math.max(margin, y)),
  };
}

// Fixed directions (front-left, front-right, below) from the leader's home —
// unchanged since Phase 2.5 — but the *distance* along each now grows with
// index, so index 0 (the highest-scoring/most-played artist) sits closest to
// the leader (centre/front) and later ones sit progressively further out
// (the edges): SPEC.md's Phase 3 "resident placement encodes play count".
const RESIDENT_DIRECTIONS: Point[] = [
  { x: -0.95, y: 0.32 },
  { x: 0.99, y: -0.16 },
  { x: 0, y: 1 },
];
const RESIDENT_DISTANCES = [12, 26, 40];

// Residents must stay small (SPEC.md Phase 4: src/residents.ts encodes play
// count as distance from the leader, and a wide wander erases that) — 2-3
// cells, varied a little per index rather than one fixed number.
const RESIDENT_WANDER_RADII = [2, 3, 2];

function residentOffset(i: number): Point {
  const dir = RESIDENT_DIRECTIONS[i % RESIDENT_DIRECTIONS.length]!;
  const dist = RESIDENT_DISTANCES[Math.min(i, RESIDENT_DISTANCES.length - 1)]!;
  return { x: dir.x * dist, y: dir.y * dist };
}

function buildResidentsForDistrict(district: DistrictDef): Resident[] {
  const artists = getArtists(district.id).slice(0, RESIDENT_CAP);
  if (artists.length === 0) return [];
  const [w, h] = assetSize(district.bg);
  const grid = getWalkGrid(district.bg);

  return artists.map((artist, i) => {
    const rigId = RIG_IDS[i % RIG_IDS.length]!;
    const sheetKey = residentSheetKey(rigId, i);
    const character = residentCharacter(rigId, sheetKey);
    const offset = residentOffset(i);
    // home + offset is computed at runtime, not authored data, so
    // check:data can't validate it — snap it onto the nearest walkable cell
    // ourselves (see SPEC.md Phase 4) or a resident can spawn on a table.
    const rawHome = clampPoint(district.home.x + offset.x, district.home.y + offset.y, w, h);
    const home = nearestWalkable(rawHome, grid);
    const faded = artist.faded ?? false;
    // A faded resident is asleep, not wandering — wanderRadius 0 gives
    // tryStartWander no candidate but its own current cell (always
    // excluded), so it stays put without a separate "asleep" state in npc.ts.
    const wanderRadius = faded ? 0 : RESIDENT_WANDER_RADII[i % RESIDENT_WANDER_RADII.length]!;
    const npc = makeNpc(character, district, home, { wanderRadius });
    return { npc, artistName: artist.name, artistId: artist.id, faded };
  });
}

/** Builds every district's resident NPCs (districts with no listening data
 * get none — they stay dormant/leader-only). Call once, after images have
 * loaded, alongside the other NPC-building main.ts does at startup. */
export function buildResidents(images: ImageMap): Map<string, Resident[]> {
  ensureTintedSheets(images);
  const bySlot = new Map<string, Resident[]>();
  for (const { district } of SLOTS) {
    const residents = buildResidentsForDistrict(district);
    if (residents.length > 0) bySlot.set(district.id, residents);
  }
  return bySlot;
}

// ---------------------------------------------------------------------------
// Activity treatment: "the room says what the panel can't" (SPEC.md's
// Phase 3) — a tint wash, a couple of extra non-interactive background
// villagers, and festival bunting, all sized by shared/activity.ts's
// ACTIVITY_TREATMENT so the four levels read apart at a glance on a phone.
// District-interior only (see main.ts's renderDistrict) — the whole-village
// view has one shared background, so per-slot lighting doesn't apply there.
// ---------------------------------------------------------------------------
const CROWD_OFFSETS: Point[] = [
  { x: -46, y: -16 },
  { x: 46, y: 18 },
];
const BUNTING_COLORS = ["#E86A5C", "#F2C14E", "#5AA9E6", "#7ED6A5"];

// Crowd villagers are real NPC instances (wandering, y-sorted with everyone
// else — see main.ts's renderDistrict), built once up front rather than in
// drawActivityTreatment (a draw function, called every frame, that can't own
// NPC state). Every district gets a pool sized to the *largest* crowdExtra
// across all activity levels, so a level change at runtime never needs new
// NPCs — main.ts just shows/updates a level-sized prefix of the pool.
const MAX_CROWD_EXTRA = Math.max(...Object.values(ACTIVITY_TREATMENT).map((t) => t.crowdExtra));

// Ambient background scenery, not a resident (SPEC.md's "resident placement
// encodes play count" doesn't apply to these) — kept small and fixed rather
// than varied per index.
const CROWD_WANDER_RADIUS = 2;

/** Deterministic per-(district, slot) rig pick — so a district's crowd
 * villagers don't all render as identical twins, but reloading doesn't
 * reshuffle who's who. */
function crowdRigId(districtId: string, i: number): string {
  return RIG_IDS[hashSeed(`${districtId}:crowd${i}`) % RIG_IDS.length]!;
}

function buildCrowdForDistrict(district: DistrictDef): Npc[] {
  const [w, h] = assetSize(district.bg);
  const grid = getWalkGrid(district.bg);
  return Array.from({ length: MAX_CROWD_EXTRA }, (_, i) => {
    const rigId = crowdRigId(district.id, i);
    const rig = NPC_RIGS[rigId]!;
    const character = residentCharacter(rigId, rig.sheet);
    const offset = CROWD_OFFSETS[i % CROWD_OFFSETS.length]!;
    // Runtime-computed, like a resident's home — snap onto the nearest
    // walkable cell so a background villager doesn't spawn on a table.
    const raw = clampPoint(district.home.x + offset.x, district.home.y + offset.y, w, h);
    const home = nearestWalkable(raw, grid);
    return makeNpc(character, district, home, { wanderRadius: CROWD_WANDER_RADIUS });
  });
}

/** Builds every district's crowd-villager pool. Call once, alongside
 * buildResidents. */
export function buildCrowd(): Map<string, Npc[]> {
  const bySlot = new Map<string, Npc[]>();
  for (const { district } of SLOTS) bySlot.set(district.id, buildCrowdForDistrict(district));
  return bySlot;
}

function drawFestivalBunting(ctx: CanvasRenderingContext2D, w: number): void {
  const count = Math.max(3, Math.round(w / 40));
  const y = 10;
  ctx.save();
  for (let i = 0; i < count; i++) {
    const x = ((i + 0.5) / count) * w;
    ctx.fillStyle = BUNTING_COLORS[i % BUNTING_COLORS.length]!;
    ctx.beginPath();
    ctx.moveTo(x - 6, y);
    ctx.lineTo(x + 6, y);
    ctx.lineTo(x, y + 10);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** Draws one district's activity treatment onto its background, in world
 * space — call right after drawing the bg image and before its leader/
 * residents/crowd, so the wash sits behind the interactive cast (which stays
 * at full brightness/contrast for tap targets). The crowd itself is real
 * NPCs now (see buildCrowd) drawn by main.ts's renderDistrict, y-sorted
 * alongside the leader and residents rather than here. */
export function drawActivityTreatment(
  ctx: CanvasRenderingContext2D,
  level: ActivityLevel,
  w: number,
  h: number,
): void {
  const treatment = ACTIVITY_TREATMENT[level];

  if (treatment.festivalProps) drawFestivalBunting(ctx, w);

  if (treatment.overlay) {
    ctx.save();
    ctx.fillStyle = treatment.overlay;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
}
