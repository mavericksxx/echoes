#!/usr/bin/env node
// One-time local PKCE login. The site itself has no login UI — this is how
// the owner connects: it prints an authorize URL, receives the redirect
// (either via a tiny 127.0.0.1:8888 server, or pasted manually when the
// browser doing the login is on a different device), exchanges the code
// for tokens, and writes the encrypted refresh token straight into the
// *remote* D1 (`wrangler d1 execute --remote`) — see SPEC.md's "Auth &
// tokens" section.
//
// Usage:
//   npm run spotify:connect
//     Prints the authorize URL, tries to open it in a browser, and waits
//     for that browser to redirect back to 127.0.0.1:8888/callback.
//
//   npm run spotify:connect -- --code "<pasted redirect URL, or just the code>"
//     For when the browser doing the login is on a *different* device
//     (headless server, phone, etc.): run the plain command above first —
//     it prints the URL and saves the PKCE state to a temp file — open
//     that URL wherever the browser is, log in, and copy the URL it
//     redirects to (it will fail to load, since 127.0.0.1 there isn't this
//     machine, but the address bar still has the `code`). Then run this
//     command with that pasted value.
//
// Requires TOKEN_KEY in this shell's environment (the same value set with
// `wrangler secret put TOKEN_KEY`) — see README.md.
"use strict";

import { createServer } from "node:http";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { encryptToken } from "./spotify-crypto.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const REDIRECT_URI = "http://127.0.0.1:8888/callback";
// Phase 8.6 adds the two playlist scopes (SPEC.md's "Playlists are places") —
// GET /me/playlists and GET /playlists/{id}/items both 401/403 without them.
// An existing connection needs to rerun this script once to pick them up.
const SCOPES = [
  "user-top-read",
  "user-read-recently-played",
  "user-read-currently-playing",
  "playlist-read-private",
  "playlist-read-collaborative",
].join(" ");
const PKCE_STATE_FILE = path.join(os.tmpdir(), "echoes-spotify-pkce.json");
const PKCE_STATE_MAX_AGE_MS = 15 * 60 * 1000;

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Minimal JSONC comment stripper — good enough for this project's plain
 * wrangler.jsonc (no "//" inside any string value). Avoids hardcoding a
 * second copy of the client id that could drift from wrangler.jsonc's. */
async function readClientId() {
  const raw = await readFile(path.join(ROOT, "wrangler.jsonc"), "utf8");
  const stripped = raw.replace(/\/\/.*$/gm, "");
  const config = JSON.parse(stripped);
  const clientId = config.vars?.SPOTIFY_CLIENT_ID;
  if (!clientId) throw new Error("wrangler.jsonc: vars.SPOTIFY_CLIENT_ID is missing");
  return clientId;
}

function buildAuthorizeUrl(clientId, codeChallenge, state) {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    code_challenge_method: "S256",
    code_challenge: codeChallenge,
    scope: SCOPES,
    state,
  });
  return `https://accounts.spotify.com/authorize?${params}`;
}

function tryOpenBrowser(url) {
  try {
    if (process.platform === "darwin") spawnSync("open", [url]);
    else if (process.platform === "linux") spawnSync("xdg-open", [url]);
    else if (process.platform === "win32") spawnSync("cmd", ["/c", "start", "", url]);
  } catch {
    // Best-effort only — the printed URL is the real interface.
  }
}

async function exchangeCode(clientId, code, codeVerifier) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: codeVerifier,
  });
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json();
  if (!res.ok) {
    const detail = data.error_description ?? data.error ?? `HTTP ${res.status}`;
    throw new Error(`Spotify token exchange failed: ${detail}`);
  }
  return data; // { access_token, refresh_token, scope, expires_in, token_type }
}

async function storeRefreshToken(refreshToken, scope) {
  const tokenKey = process.env.TOKEN_KEY;
  if (!tokenKey) {
    throw new Error(
      "TOKEN_KEY is not set in this shell's environment. Export the same base64 key you set with " +
        "`wrangler secret put TOKEN_KEY` before running this script — see README.md.",
    );
  }
  const encrypted = await encryptToken(tokenKey, refreshToken);
  const now = new Date().toISOString();
  const sql = `
INSERT INTO spotify_token (id, encrypted_refresh_token, scope, updated_at)
VALUES (1, '${encrypted}', '${scope.replace(/'/g, "''")}', '${now}')
ON CONFLICT(id) DO UPDATE SET
  encrypted_refresh_token = excluded.encrypted_refresh_token,
  scope = excluded.scope,
  updated_at = excluded.updated_at;
`;
  if (process.argv.includes("--print-sql")) {
    const out = path.join(os.tmpdir(), "echoes-token.sql");
    await writeFile(out, sql, "utf8");
    console.log(`SQL written to ${out}`);
    return;
  }
  const sqlFile = path.join(os.tmpdir(), `echoes-spotify-token-${Date.now()}.sql`);
  await writeFile(sqlFile, sql, "utf8");
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
}

/** Pulls `code`/`state`/`error` out of either a full redirect URL, a bare
 * "?code=...&state=..." query string, or a raw code with none of those. */
function parseCallbackInput(input) {
  const trimmed = input.trim();
  if (trimmed.includes("?") || trimmed.includes("://")) {
    const url = new URL(trimmed.startsWith("?") ? `http://x${trimmed}` : trimmed);
    return {
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
      error: url.searchParams.get("error"),
    };
  }
  return { code: trimmed, state: null, error: null };
}

function resolveCode(input, expectedState) {
  const { code, state, error } = parseCallbackInput(input);
  if (error) throw new Error(`Spotify returned an error: ${error}`);
  if (!code) throw new Error("No `code` found in that input.");
  if (state && state !== expectedState) {
    throw new Error(
      "State mismatch — this doesn't match the most recently printed authorize URL. Run " +
        "`npm run spotify:connect` again (no --code) for a fresh URL.",
    );
  }
  return code;
}

async function loadPkceState() {
  if (!existsSync(PKCE_STATE_FILE)) {
    throw new Error(
      "No pending login found. Run `npm run spotify:connect` (no --code) first — it prints the " +
        "authorize URL and remembers the PKCE state this needs.",
    );
  }
  const saved = JSON.parse(await readFile(PKCE_STATE_FILE, "utf8"));
  if (Date.now() - saved.createdAt > PKCE_STATE_MAX_AGE_MS) {
    await unlink(PKCE_STATE_FILE).catch(() => {});
    throw new Error("That pending login expired (>15 min old). Run `npm run spotify:connect` again for a fresh URL.");
  }
  return saved;
}

async function finishLogin(clientId, input, expectedState, verifier) {
  const code = resolveCode(input, expectedState);
  const tokens = await exchangeCode(clientId, code, verifier);
  await storeRefreshToken(tokens.refresh_token, tokens.scope);
  await unlink(PKCE_STATE_FILE).catch(() => {});
  console.log("\nConnected. Refresh token stored (encrypted) in the remote D1 database.");
}

async function runManual(clientId, pastedValue) {
  const saved = await loadPkceState();
  await finishLogin(clientId, pastedValue, saved.state, saved.verifier);
}

function runLocalServer(clientId, state, verifier) {
  console.log(`Waiting for the browser to finish login and redirect to ${REDIRECT_URI} ...`);
  console.log(
    "(Ctrl+C to give up — if the browser doing the login is on a different device, re-run with " +
      "--code once you have the redirect URL instead of waiting here.)\n",
  );

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const reqUrl = new URL(req.url, REDIRECT_URI);
      if (reqUrl.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const failed = reqUrl.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        failed
          ? `<html><body>Echoes: login failed (${failed}). Check the terminal.</body></html>`
          : "<html><body>Echoes: login received, you can close this tab.</body></html>",
      );
      server.close();
      finishLogin(clientId, reqUrl.search, state, verifier).then(resolve, reject);
    });
    server.listen(8888, "127.0.0.1");
    server.on("error", reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const codeFlagIndex = args.indexOf("--code");
  const clientId = await readClientId();

  if (codeFlagIndex !== -1) {
    const pastedValue = args[codeFlagIndex + 1];
    if (!pastedValue) throw new Error("--code needs a value: the full redirect URL, or just the code.");
    await runManual(clientId, pastedValue);
    return;
  }

  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));
  await writeFile(PKCE_STATE_FILE, JSON.stringify({ verifier, state, createdAt: Date.now() }), "utf8");

  const authorizeUrl = buildAuthorizeUrl(clientId, challenge, state);
  console.log("\nOpen this URL to connect your Spotify account:\n");
  console.log(authorizeUrl);
  console.log();
  tryOpenBrowser(authorizeUrl);

  await runLocalServer(clientId, state, verifier);
}

main().catch((err) => {
  console.error("\nspotify:connect failed:", err.message);
  process.exitCode = 1;
});
