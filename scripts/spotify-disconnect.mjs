#!/usr/bin/env node
// Deletes every stored row for the connected Spotify account: the
// (encrypted) refresh token and everything derived from it. Run this to
// fully disconnect — the site then shows the "not connected" state until
// `npm run spotify:connect` runs again. See SPEC.md's storage policy
// ("disconnect deletes every row + the refresh token").
"use strict";

import { writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const SQL = `
DELETE FROM spotify_token;
DELETE FROM artist_cache;
DELETE FROM usage_log;
`;

async function main() {
  const sqlFile = path.join(os.tmpdir(), `echoes-spotify-disconnect-${Date.now()}.sql`);
  await writeFile(sqlFile, SQL, "utf8");
  try {
    const result = spawnSync("npx", ["wrangler", "d1", "execute", "echoes", "--remote", `--file=${sqlFile}`], {
      cwd: ROOT,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      throw new Error("wrangler d1 execute --remote failed — see output above.");
    }
  } finally {
    await unlink(sqlFile).catch(() => {});
  }
  console.log("\nDisconnected: spotify_token, artist_cache, and usage_log are now empty in the remote D1 database.");
}

main().catch((err) => {
  console.error("\nspotify:disconnect failed:", err.message);
  process.exitCode = 1;
});
