// District resident NPCs: the genre leader's district isn't just their own —
// a handful of that genre's top artists "live" there too, wandering the same
// interior with the existing NPC state machine (see src/npc.ts), built from
// the generic "hidden leaf ninja" rig sheet (data/npcRigs.json) since there's
// no real per-artist sprite yet. Populated from src/listening-source.ts
// (real /api/village data once connected+live, sample data otherwise). See
// SPEC.md "Phase 2.5" for the size check behind RESIDENT_CAP, and its
// Phase 3 bullet for placement-encodes-play-count + faded/asleep residents.

import type { CharacterDef, DistrictDef, Point } from "../data/types";
import { NPC_RIGS, SLOTS, assetSize } from "../data/loader";
import { makeNpc, type Npc } from "./npc";
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

function residentOffset(i: number): Point {
  const dir = RESIDENT_DIRECTIONS[i % RESIDENT_DIRECTIONS.length]!;
  const dist = RESIDENT_DISTANCES[Math.min(i, RESIDENT_DISTANCES.length - 1)]!;
  return { x: dir.x * dist, y: dir.y * dist };
}

function buildResidentsForDistrict(district: DistrictDef): Resident[] {
  const artists = getArtists(district.id).slice(0, RESIDENT_CAP);
  if (artists.length === 0) return [];
  const [w, h] = assetSize(district.bg);

  return artists.map((artist, i) => {
    const rigId = RIG_IDS[i % RIG_IDS.length]!;
    const sheetKey = residentSheetKey(rigId, i);
    const character = residentCharacter(rigId, sheetKey);
    const offset = residentOffset(i);
    const home = clampPoint(district.home.x + offset.x, district.home.y + offset.y, w, h);
    const faded = artist.faded ?? false;
    // A faded resident is asleep, not wandering — a one-point patrol keeps
    // makeNpc/updateNpc's existing walk logic (it just never has anywhere
    // else to walk to) instead of needing a separate "asleep" state.
    const patrol = faded
      ? [home]
      : [
          home,
          clampPoint(home.x - 12, home.y - 8, w, h),
          clampPoint(home.x + 12, home.y + 6, w, h),
          clampPoint(home.x - 6, home.y + 10, w, h),
        ];
    const npc = makeNpc(character, district, home, patrol);
    return { npc, artistName: artist.name, faded };
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
 * residents, so the wash/crowd sit behind the interactive cast (which stays
 * at full brightness/contrast for tap targets). */
export function drawActivityTreatment(
  ctx: CanvasRenderingContext2D,
  images: ImageMap,
  district: DistrictDef,
  level: ActivityLevel,
  w: number,
  h: number,
): void {
  const treatment = ACTIVITY_TREATMENT[level];

  if (treatment.crowdExtra > 0) {
    const rig = NPC_RIGS[RIG_IDS[0]!]!;
    const img = images[rig.sheet];
    const frame = rig.down[0];
    if (img instanceof HTMLImageElement && frame) {
      const [sx, sy, ex, ey] = frame;
      const fw = ex - sx;
      const fh = ey - sy;
      ctx.save();
      ctx.globalAlpha = 0.5;
      for (let i = 0; i < treatment.crowdExtra; i++) {
        const offset = CROWD_OFFSETS[i % CROWD_OFFSETS.length]!;
        const p = clampPoint(district.home.x + offset.x, district.home.y + offset.y, w, h);
        ctx.drawImage(img, sx, sy, fw, fh, p.x - fw / 2, p.y - fh, fw, fh);
      }
      ctx.restore();
    }
  }

  if (treatment.festivalProps) drawFestivalBunting(ctx, w);

  if (treatment.overlay) {
    ctx.save();
    ctx.fillStyle = treatment.overlay;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
}
