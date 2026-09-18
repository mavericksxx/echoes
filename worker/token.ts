// Token manager: loads + decrypts the owner's stored refresh token, trades
// it for a short-lived access token, and caches that access token both in
// memory (per-isolate, cleared on cold start) and — since Phase 8b — in D1
// (`spotify_token.encrypted_access_token`/`access_expires_at`), so a cold
// isolate reads a still-valid token instead of refreshing from scratch.
// Before Phase 8b this cache was memory-only, and Phase 8a's 15-min cron
// landing on a cold isolate almost every run meant roughly one refresh POST
// per run instead of one per the token's real ~50min TTL (see BACKLOG.md's
// "known exposure", now fixed). Spotify sometimes rotates the refresh token
// on use — when it does, the rotated one is re-encrypted and persisted
// alongside the new access token in the same write.
//
// Concurrent refreshes across isolates are handled with a compare-and-swap
// on a `version` column (see doRefresh): whichever isolate's UPDATE lands
// first wins, and every other isolate discards its own result and re-reads
// the row instead of overwriting the winner's (possibly rotated) refresh
// token. Within a single isolate, `refreshInFlight` collapses concurrent
// callers onto one in-progress refresh instead of each firing its own POST.

import { decryptToken, encryptToken } from "./crypto";
import type { Env } from "./index";

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const EXPIRY_SAFETY_MARGIN_MS = 60_000;

// How long to keep re-reading D1 after an `invalid_grant` refresh failure
// before giving up — see doRefresh's doc comment on why this exists at all.
const INVALID_GRANT_RETRY_ATTEMPTS = 3;
const INVALID_GRANT_RETRY_DELAY_MS = 500; // 3 * 500ms ≈ 1.5s total

interface CachedAccessToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

// Module-level: survives across requests on a warm isolate, gone on a cold
// start (which then falls back to the D1 row, and only refreshes from
// Spotify if that row's own cached token is missing or expired too).
let cached: CachedAccessToken | null = null;

// Single-flight: every getAccessToken call that misses both caches within
// the same isolate awaits this same promise instead of each starting its
// own refresh — cleared in doRefresh's `finally` regardless of outcome.
let refreshInFlight: Promise<string> | null = null;

export class TokenError extends Error {}

interface SpotifyTokenRow {
  encrypted_refresh_token: string;
  scope: string;
  encrypted_access_token: string | null;
  access_expires_at: number | null;
  version: number;
}

interface SpotifyTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

async function fetchTokenRow(env: Env): Promise<SpotifyTokenRow | null> {
  return env.DB.prepare(
    "SELECT encrypted_refresh_token, scope, encrypted_access_token, access_expires_at, version FROM spotify_token WHERE id = 1",
  ).first<SpotifyTokenRow>();
}

/** Whether `row`'s own cached access token is still safely usable — same
 * 60s safety margin as the in-memory cache. */
function rowHasLiveAccessToken(row: SpotifyTokenRow): boolean {
  return (
    row.encrypted_access_token !== null &&
    row.access_expires_at !== null &&
    Date.now() < row.access_expires_at - EXPIRY_SAFETY_MARGIN_MS
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Spotify returns 400 for several distinct refresh failures — `invalid_grant`
 * specifically means the refresh token itself was rejected, which is also
 * exactly what happens to the *losing* side of a rotation race (the token it
 * just tried to use was already swapped out by a refresh that beat it to
 * Spotify). Detected from the JSON body, not the status, since both cases
 * share the same 400. */
async function isInvalidGrant(res: Response): Promise<boolean> {
  try {
    const body = (await res.clone().json()) as { error?: string };
    return body.error === "invalid_grant";
  } catch {
    return false;
  }
}

/** Does the actual refresh-token POST + D1 write. Only ever called through
 * refreshAccessToken's single-flight wrapper below — never call this
 * directly, or concurrent callers in the same isolate would each fire their
 * own Spotify request. */
async function doRefresh(env: Env, row: SpotifyTokenRow): Promise<string> {
  let refreshToken: string;
  try {
    refreshToken = await decryptToken(env.TOKEN_KEY, row.encrypted_refresh_token);
  } catch (err) {
    throw new TokenError(`Could not decrypt stored refresh token: ${(err as Error).message}`);
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: env.SPOTIFY_CLIENT_ID,
  });

  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (err) {
    throw new TokenError(`Network error refreshing Spotify token: ${(err as Error).message}`);
  }

  if (!res.ok) {
    if (res.status === 400 && (await isInvalidGrant(res))) {
      // Give a concurrent winner a chance to show up in D1 before treating
      // this as a real failure (see isInvalidGrant's doc comment) — re-read
      // a few times over ~1.5s, never longer than that fixed window. A
      // genuinely revoked refresh token still ends up throwing below.
      for (let attempt = 0; attempt < INVALID_GRANT_RETRY_ATTEMPTS; attempt++) {
        await sleep(INVALID_GRANT_RETRY_DELAY_MS);
        const fresh = await fetchTokenRow(env);
        if (fresh && fresh.version !== row.version && rowHasLiveAccessToken(fresh)) {
          const accessToken = await decryptToken(env.TOKEN_KEY, fresh.encrypted_access_token!);
          cached = { accessToken, expiresAt: fresh.access_expires_at! };
          return accessToken;
        }
      }
      throw new TokenError("Spotify token refresh failed: invalid_grant (no concurrent refresh found)");
    }
    throw new TokenError(`Spotify token refresh failed with status ${res.status}`);
  }

  const data = (await res.json()) as SpotifyTokenResponse;
  const accessToken = data.access_token;
  const expiresAt = Date.now() + data.expires_in * 1000;
  const rotated = data.refresh_token && data.refresh_token !== refreshToken ? data.refresh_token : null;

  const encryptedAccess = await encryptToken(env.TOKEN_KEY, accessToken);
  const encryptedRefresh = rotated ? await encryptToken(env.TOKEN_KEY, rotated) : row.encrypted_refresh_token;

  const result = await env.DB.prepare(
    `UPDATE spotify_token
     SET encrypted_access_token = ?, access_expires_at = ?, encrypted_refresh_token = ?, updated_at = ?, version = version + 1
     WHERE id = 1 AND version = ?`,
  )
    .bind(encryptedAccess, expiresAt, encryptedRefresh, new Date().toISOString(), row.version)
    .run();

  if ((result.meta.changes ?? 0) === 0) {
    // Lost the compare-and-swap race — another isolate's refresh already
    // landed first (and may have rotated the refresh token again on top of
    // ours). Discard this result and use whatever the winner wrote instead.
    const fresh = await fetchTokenRow(env);
    if (fresh && rowHasLiveAccessToken(fresh)) {
      const winnerAccessToken = await decryptToken(env.TOKEN_KEY, fresh.encrypted_access_token!);
      cached = { accessToken: winnerAccessToken, expiresAt: fresh.access_expires_at! };
      return winnerAccessToken;
    }
    // Shouldn't happen (the winner's write should already be visible to this
    // read) — fall back to this call's own still-valid result rather than
    // fail the request over it.
  }

  cached = { accessToken, expiresAt };
  return accessToken;
}

function refreshAccessToken(env: Env, row: SpotifyTokenRow): Promise<string> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh(env, row).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/**
 * Returns a live access token, or `null` if no Spotify account is
 * connected (no row in `spotify_token`). Throws `TokenError` if a token
 * *is* stored but refreshing it failed (revoked access, network error,
 * etc.) — callers treat that as "live paused", not a hard failure.
 */
export async function getAccessToken(env: Env): Promise<string | null> {
  if (cached && Date.now() < cached.expiresAt - EXPIRY_SAFETY_MARGIN_MS) {
    return cached.accessToken;
  }

  const row = await fetchTokenRow(env);
  if (!row) return null;

  if (rowHasLiveAccessToken(row)) {
    try {
      const accessToken = await decryptToken(env.TOKEN_KEY, row.encrypted_access_token!);
      cached = { accessToken, expiresAt: row.access_expires_at! };
      return accessToken;
    } catch (err) {
      // A corrupt cached access token shouldn't block getting a fresh one —
      // fall through to the refresh path below instead of throwing.
      console.error("[token] could not decrypt cached access token, refreshing instead:", err);
    }
  }

  return refreshAccessToken(env, row);
}
