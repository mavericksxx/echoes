// District resident NPCs: the genre leader's district isn't just their own —
// a handful of that genre's top artists "live" there too, wandering the same
// interior with the existing NPC state machine (see src/npc.ts), built from
// the generic "hidden leaf ninja" rig sheet (data/npcRigs.json) since there's
// no real per-artist sprite yet. Populated from src/sample-data.ts's top
// artists per slot; Phase 3 swaps in real artist data. See SPEC.md
// "Phase 2.5" for the size check behind RESIDENT_CAP.

import type { CharacterDef, DistrictDef, Point } from "../data/types";
import { NPC_RIGS, SLOTS, assetSize } from "../data/loader";
import { makeNpc, type Npc } from "./npc";
import { getListening, topArtists } from "./sample-data";
import { bakeRecolor } from "./recolor";
import type { ImageMap } from "./render";

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

// Home-point offsets from the leader's own home, and each resident's own
// small patrol box around that home — mirrors the pattern main.ts already
// uses for whole-village NPCs, scaled down for these much smaller interiors.
const RESIDENT_OFFSETS: Point[] = [
  { x: -30, y: 10 },
  { x: 30, y: -5 },
  { x: 0, y: 25 },
];

function buildResidentsForDistrict(district: DistrictDef): Resident[] {
  const artists = topArtists(getListening(district.id)).slice(0, RESIDENT_CAP);
  if (artists.length === 0) return [];
  const [w, h] = assetSize(district.bg);

  return artists.map((artist, i) => {
    const rigId = RIG_IDS[i % RIG_IDS.length]!;
    const sheetKey = residentSheetKey(rigId, i);
    const character = residentCharacter(rigId, sheetKey);
    const offset = RESIDENT_OFFSETS[i % RESIDENT_OFFSETS.length]!;
    const home = clampPoint(district.home.x + offset.x, district.home.y + offset.y, w, h);
    const patrol = [
      home,
      clampPoint(home.x - 12, home.y - 8, w, h),
      clampPoint(home.x + 12, home.y + 6, w, h),
      clampPoint(home.x - 6, home.y + 10, w, h),
    ];
    const npc = makeNpc(character, district, home, patrol);
    return { npc, artistName: artist.name };
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
