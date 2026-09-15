#!/usr/bin/env node
// Validates data/*.json (ported from prototypes/konoha-demo/verify.js):
//  - every asset file referenced exists on disk (public/assets/, after sync)
//  - every frame rect (anims/idle/specials) fits within its sheet's pixel bounds
//  - every district's declared bgSize matches the actual PNG, and its
//    home/patrol waypoints fall inside it
//  - all 17 slots are present (one character per district, no duplicate genre)
//  - every village anchor falls inside the village map bounds
//
// Usage: npm run check:data
"use strict";

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncAssets } from "./sync-assets.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const ASSETS_DIR = path.join(ROOT, "public", "assets");

const EXPECTED_SLOT_COUNT = 17;

function pngSize(file) {
  const buf = readFileSync(file);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

async function loadJson(name) {
  return JSON.parse(await readFile(path.join(DATA_DIR, name), "utf8"));
}

async function main() {
  await syncAssets();

  const characters = await loadJson("characters.json");
  const districts = await loadJson("districts.json");
  const village = await loadJson("village.json");
  const assetManifest = await loadJson("assets.json");

  const errors = [];
  let checks = 0;

  // 1. Every asset file referenced exists and is a readable PNG.
  const sizes = {};
  for (const [key, filename] of Object.entries(assetManifest)) {
    checks++;
    const p = path.join(ASSETS_DIR, filename);
    if (!existsSync(p)) {
      errors.push(`MISSING asset file: public/assets/${filename} (key=${key})`);
      continue;
    }
    try {
      sizes[key] = pngSize(p);
    } catch (e) {
      errors.push(`Could not read PNG dims for ${filename}: ${e.message}`);
    }
  }

  function checkRect(label, sheetKey, rect) {
    checks++;
    if (!sizes[sheetKey]) {
      errors.push(`${label}: sheet '${sheetKey}' has no known size (missing/broken image)`);
      return;
    }
    const { width: w, height: h } = sizes[sheetKey];
    const [x0, y0, x1, y1] = rect;
    if (x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0 || x1 > w || y1 > h) {
      errors.push(
        `${label}: rect [${rect.join(",")}] out of bounds for sheet '${sheetKey}' (${w}x${h})`,
      );
    }
  }

  // 2. Every character's anim/idle/special rects are within their sheet's bounds.
  for (const def of characters) {
    for (const animName of Object.keys(def.anims)) {
      def.anims[animName].forEach((rect, i) => {
        checkRect(`${def.id}.${animName}[${i}]`, def.sheet, rect);
      });
    }
    checkRect(`${def.id}.idle`, def.sheet, def.idle);
    (def.specials || []).forEach((rect, i) => {
      checkRect(`${def.id}.specials[${i}]`, def.battleSheet, rect);
    });
  }

  // 3. Every district's declared bgSize matches the actual PNG, and every
  // patrol/home waypoint falls within it.
  for (const def of districts) {
    checks++;
    const actual = sizes[def.bg];
    if (!actual) {
      errors.push(`${def.id}: background sheet '${def.bg}' has no known size`);
      continue;
    }
    if (actual.width !== def.bgSize[0] || actual.height !== def.bgSize[1]) {
      errors.push(
        `${def.id}: declared bgSize [${def.bgSize.join(",")}] does not match actual PNG ` +
          `dimensions ${actual.width}x${actual.height} for '${def.bg}'`,
      );
    }
    const [w, h] = def.bgSize;
    const points = [...def.patrol, def.home];
    points.forEach((p, i) => {
      checks++;
      if (p.x < 0 || p.y < 0 || p.x > w || p.y > h) {
        errors.push(
          `${def.id}: waypoint[${i}] (${p.x},${p.y}) is outside its ${w}x${h} background '${def.bg}'`,
        );
      }
    });
  }

  // 4. Exactly 17 slots, one character per district, no duplicate genres.
  checks++;
  if (characters.length !== EXPECTED_SLOT_COUNT) {
    errors.push(`expected ${EXPECTED_SLOT_COUNT} characters, found ${characters.length}`);
  }
  checks++;
  if (districts.length !== EXPECTED_SLOT_COUNT) {
    errors.push(`expected ${EXPECTED_SLOT_COUNT} districts, found ${districts.length}`);
  }
  const characterIds = new Set(characters.map((c) => c.id));
  for (const d of districts) {
    checks++;
    if (!characterIds.has(d.id)) {
      errors.push(`district '${d.id}' has no matching character in characters.json`);
    }
  }
  const seenGenres = new Set();
  for (const d of districts) {
    checks++;
    if (seenGenres.has(d.genre)) errors.push(`duplicate genre district: ${d.genre}`);
    seenGenres.add(d.genre);
  }

  // 5. Village anchors fall inside the village map bounds.
  const [vw, vh] = village.mapSize;
  village.anchors.forEach(([x, y], i) => {
    checks++;
    if (x < 0 || y < 0 || x > vw || y > vh) {
      errors.push(`village anchor[${i}] (${x},${y}) is outside the ${vw}x${vh} map`);
    }
  });

  console.log(
    `Checked ${checks} assertions across ${districts.length} districts, ${characters.length} ` +
      `characters, and ${Object.keys(assetManifest).length} image files.`,
  );

  if (errors.length) {
    console.error(`\nFAILED (${errors.length} problem(s)):`);
    errors.forEach((e) => console.error(`  - ${e}`));
    process.exitCode = 1;
  } else {
    console.log("All asset paths exist, all frame rects and waypoints are within bounds. OK.");
  }
}

await main();
