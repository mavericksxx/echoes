// Rate-aware Spotify fetch wrapper — the *only* thing in this Worker that
// is allowed to call api.spotify.com. Honors 429 Retry-After, backs off
// exponentially with jitter on 429/5xx, logs every real HTTP attempt to
// `usage_log`, and never lets a raw Spotify error body reach the client
// (callers only ever see a `SpotifyRequestError` with a status code).

import type { Env } from "./index";

const API_BASE = "https://api.spotify.com/v1";
const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 500;

export class SpotifyRequestError extends Error {
  constructor(public status: number) {
    super(`Spotify request failed (status ${status})`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  const base = BASE_BACKOFF_MS * 2 ** attempt;
  return base + Math.random() * base * 0.3; // up to 30% jitter
}

async function logUsage(env: Env, endpoint: string, status: number, retry429Count: number): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO usage_log (endpoint, status, retry_429_count, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(endpoint, status, retry429Count, new Date().toISOString())
      .run();
  } catch {
    // Logging must never break the actual request.
  }
}

/**
 * GETs `endpoint` (e.g. "/me/top/artists?time_range=medium_term&limit=10")
 * from the Spotify Web API with the given access token, retrying 429s
 * (honoring Retry-After when present) and 5xx with exponential backoff +
 * jitter, up to MAX_RETRIES. Every real HTTP attempt is logged. Throws
 * `SpotifyRequestError` on a non-retryable failure or exhausted retries —
 * callers must catch this rather than let it leak Spotify's response body.
 */
export async function spotifyGet<T>(env: Env, endpoint: string, accessToken: string): Promise<T> {
  let retry429Count = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (res.status === 429) {
      retry429Count++;
      await logUsage(env, endpoint, res.status, retry429Count);
      if (attempt === MAX_RETRIES) throw new SpotifyRequestError(429);
      const retryAfter = res.headers.get("Retry-After");
      await sleep(retryAfter ? Number(retryAfter) * 1000 : backoffMs(attempt));
      continue;
    }

    if (res.status >= 500) {
      await logUsage(env, endpoint, res.status, retry429Count);
      if (attempt === MAX_RETRIES) throw new SpotifyRequestError(res.status);
      await sleep(backoffMs(attempt));
      continue;
    }

    await logUsage(env, endpoint, res.status, retry429Count);
    if (!res.ok) throw new SpotifyRequestError(res.status);
    return (await res.json()) as T;
  }

  // Unreachable — the loop above always returns or throws — but keeps
  // control flow analysis (and TypeScript) happy.
  throw new SpotifyRequestError(599);
}
