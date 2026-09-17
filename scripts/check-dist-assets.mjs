#!/usr/bin/env node
// Predeploy guard (fix pass, 2026-09-17): fails loudly if the built
// dist/assets/ is missing any sprite/map PNG data/assets.json expects.
//
// Why this exists: `wrangler deploy` invoked directly (skipping
// `npm run deploy`, which chains check:data -> build -> wrangler deploy)
// already shipped a village with zero sprites once — a dark, empty screen
// in production. `npm run check:data`'s own local-PNG tier doesn't catch
// this class of mistake: it's deliberately *soft* (skipped, not failed,
// when the gitignored rip isn't present locally, so CI stays green without
// it) and it only ever looks at public/assets/, never the dist/ output that
// actually gets uploaded.
//
// This script is wired into wrangler.jsonc's `build.command`, which
// Wrangler runs before bundling on every `wrangler dev`/`wrangler deploy` —
// including a bare `wrangler deploy` typed directly, with no npm script (and
// therefore no check:data) in the loop at all. That's the enforcement this
// guard depends on; running it as a plain npm script would be exactly as
// skippable as the mistake that caused the incident.
//
// Deliberately narrow and fast: existence only, no PNG decoding or
// dimension checks (that's check:data's job, locally, before you ever
// build) — this just has to catch "the folder about to be uploaded has no
// sprites," on every single deploy, without slowing it down.
//
// Usage: node scripts/check-dist-assets.mjs

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const ASSETS_JSON = path.join(ROOT, "data", "assets.json");
const DIST_ASSETS_DIR = path.join(ROOT, "dist", "assets");

const assets = JSON.parse(await readFile(ASSETS_JSON, "utf8"));
const entries = Object.entries(assets);

const missing = entries.filter(([, entry]) => !existsSync(path.join(DIST_ASSETS_DIR, entry.file)));

if (missing.length > 0) {
  console.error(
    `\n[check-dist-assets] FAILED — ${missing.length}/${entries.length} sprite/map PNG(s) missing from dist/assets/:`,
  );
  missing.forEach(([key, entry]) => console.error(`  - ${key} -> ${entry.file}`));
  console.error(
    "\nThis almost always means dist/ was built without public/assets/ populated first " +
      "(run `npm run assets:sync` before `vite build`, or just use `npm run deploy`, which " +
      "chains both in) — deploying this dist/ would ship a village with no sprites.\n",
  );
  process.exit(1);
}

console.log(`[check-dist-assets] OK — all ${entries.length} sprite/map PNG(s) present in dist/assets/.`);
