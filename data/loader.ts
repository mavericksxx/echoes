// Loads and joins the internal sprite/map JSON data. Used by the frontend
// (via Vite's native JSON import) — the Node-side validation in
// scripts/check-data.mjs reads the same files directly with fs.

import charactersJson from "./characters.json";
import districtsJson from "./districts.json";
import villageJson from "./village.json";
import assetsJson from "./assets.json";
import npcRigsJson from "./npcRigs.json";
import type { AssetManifest, CharacterDef, DistrictDef, NpcRigManifest, VillageDef } from "./types";

// JSON imports are inferred as plain arrays/objects (e.g. rects come back as
// `number[]`, not the `Rect` tuple), so we assert through `unknown` once here
// rather than everywhere the data is used.
export const CHARACTERS = charactersJson as unknown as CharacterDef[];
export const DISTRICTS = districtsJson as unknown as DistrictDef[];
export const VILLAGE = villageJson as unknown as VillageDef;
export const ASSET_MANIFEST = assetsJson as unknown as AssetManifest;
/** Generic NPC rigs used to build district resident NPCs (see src/residents.ts). */
export const NPC_RIGS = npcRigsJson as unknown as NpcRigManifest;

export interface Slot {
  character: CharacterDef;
  district: DistrictDef;
}

/** Characters and districts joined by id, in district (canonical roster) order. */
export const SLOTS: Slot[] = DISTRICTS.map((district) => {
  const character = CHARACTERS.find((c) => c.id === district.id);
  if (!character) {
    throw new Error(`No character data for district id "${district.id}"`);
  }
  return { character, district };
});

export function getSlot(id: string): Slot {
  const slot = SLOTS.find((s) => s.district.id === id);
  if (!slot) throw new Error(`Unknown slot id "${id}"`);
  return slot;
}

function assetEntry(key: string) {
  const entry = ASSET_MANIFEST[key];
  if (!entry) throw new Error(`Unknown asset key "${key}"`);
  return entry;
}

/** Public URL for an asset key, once `npm run assets:sync` has populated public/assets/. */
export function assetUrl(key: string): string {
  return `/assets/${assetEntry(key).file}`;
}

/** Pixel size of an asset (e.g. a district's `bg` or the village's `mapImage`). */
export function assetSize(key: string): [number, number] {
  const entry = assetEntry(key);
  return [entry.w, entry.h];
}
