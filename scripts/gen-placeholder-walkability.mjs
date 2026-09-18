#!/usr/bin/env node
// Generates data/walkability.json with an all-walkable ('.') grid for every
// map asset key check-data.mjs's walkability checks require (every
// district's `bg`, plus village.mapImage — see SPEC.md Phase 4), sized from
// assets.json's declared w/h at cell=16 (these are DS 16x16 tilemaps).
//
// This is a PLACEHOLDER. The real grid contents — marking roofs, walls, and
// furniture as blocked — are a visual judgment call against the actual
// PNGs, which this script cannot see (they're gitignored, local-only).
// Running this again overwrites any hand-authored content in
// data/walkability.json, so treat it as a one-time scaffold, not a
// re-runnable build step.
"use strict";

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");

const CELL = 16;

// Every asset key that's used as a district `bg` or as village.mapImage
// ("town", already covered by naruto's district bg — one grid serves both).
// houseBedroom exists in assets.json but no district uses it as a `bg`, so
// it's deliberately excluded (see SPEC.md Phase 4).
const MAP_KEYS = [
  "town",
  "forest",
  "academyDojo",
  "hokageMonument",
  "hospitalYard",
  "ramenInterior",
  "houseInterior",
  "konohaEast",
  "shopSweets",
  "shopWeapons",
  "shopFlower",
  "shopNinja",
  "shopGeneral",
  "houseGarden",
  "houseStudy",
  "houseDining",
  "houseBathhouse",
];

async function main() {
  const assets = JSON.parse(await readFile(path.join(DATA_DIR, "assets.json"), "utf8"));
  const walkability = {};
  for (const key of MAP_KEYS) {
    const entry = assets[key];
    if (!entry) throw new Error(`assets.json has no entry for map key '${key}'`);
    const cols = Math.ceil(entry.w / CELL);
    const rows = Math.ceil(entry.h / CELL);
    const row = ".".repeat(cols);
    walkability[key] = { cell: CELL, cols, rows, grid: Array.from({ length: rows }, () => row) };
  }
  const file = path.join(DATA_DIR, "walkability.json");
  await writeFile(file, `${JSON.stringify(walkability, null, 2)}\n`);
  console.log(`Wrote placeholder walkability.json for ${MAP_KEYS.length} map(s) -> ${file}`);
}

await main();
