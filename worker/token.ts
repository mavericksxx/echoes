// Token manager: loads + decrypts the owner's stored refresh token, trades
// it for a short-lived access token, and caches that access token in memory
// (per-isolate, cleared on cold start) until 60s before it expires. Spotify
// sometimes rotates the refresh token on use — when it does, the rotated
// one is re-encrypted and persisted back to D1 immediately.

import { decryptToken, encryptToken } from "./crypto";
import type { Env } from "./index";

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const EXPIRY_SAFETY_MARGIN_MS = 60_000;

interface CachedAccessToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

// Module-level: survives across requests on a warm isolate, gone on a cold
// start (which then just re-derives it from the stored refresh token).
let cached: CachedAccessToken | null = null;

export class TokenError extends Error {}

interface SpotifyTokenRow {
  encrypted_refresh_token: string;
  scope: string;
}

interface SpotifyTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
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

  const row = await env.DB.prepare(
    "SELECT encrypted_refresh_token, scope FROM spotify_token WHERE id = 1",
  ).first<SpotifyTokenRow>();
  if (!row) return null;

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
    throw new TokenError(`Spotify token refresh failed with status ${res.status}`);
  }

  const data = (await res.json()) as SpotifyTokenResponse;
  cached = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };

  if (data.refresh_token && data.refresh_token !== refreshToken) {
    const encrypted = await encryptToken(env.TOKEN_KEY, data.refresh_token);
    await env.DB.prepare(
      "UPDATE spotify_token SET encrypted_refresh_token = ?, updated_at = ? WHERE id = 1",
    )
      .bind(encrypted, new Date().toISOString())
      .run();
  }

  return cached.accessToken;
}
