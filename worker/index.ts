// Echoes Worker — serves the Vite build as static assets and exposes a
// small API surface. Phase 2 adds the Spotify token manager (token.ts), the
// rate-aware fetch wrapper (spotify-fetch.ts), and /api/top-artists
// (top-artists.ts). Phase 3 adds /api/village (village.ts, genre resolution
// via Gemini) and per-IP rate limiting (rate-limit.ts), applied here to
// every /api/* route before it's dispatched. Phase 3.5 adds real top tracks
// to /api/village (worker/tracks.ts) and, since the sidebar now hotlinks
// Spotify album art, a CSP on the HTML shell response below.

import { handleTopArtists } from "./top-artists";
import { handleVillage } from "./village";
import { clientIp, enforceRateLimit, RateLimitError, RATE_LIMIT_RULES } from "./rate-limit";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  /** Public PKCE client id (no client secret exists) — set in wrangler.jsonc's `vars`. */
  SPOTIFY_CLIENT_ID: string;
  /** Base64 AES-256 key encrypting the stored refresh token — a Worker secret (`wrangler secret put TOKEN_KEY`). */
  TOKEN_KEY: string;
  /** Gemini API key (free tier) — a Worker secret (`wrangler secret put GEMINI_API_KEY`). Used only by worker/gemini.ts. */
  GEMINI_API_KEY: string;
}

/** Maps a route to its rate-limit bucket — every /api/* route is limited
 * (SPEC.md's "Hosting"); /api/village is stricter since it's the only one
 * that can trigger a Gemini call (its own daily cap is separate, see
 * rate-limit.ts's geminiQuotaAvailable). */
const ROUTE_BUCKETS: Record<string, keyof typeof RATE_LIMIT_RULES> = {
  "/api/health": "health",
  "/api/top-artists": "topArtists",
  "/api/village": "village",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const bucket = ROUTE_BUCKETS[url.pathname];

    if (bucket) {
      try {
        await enforceRateLimit(env, clientIp(request), bucket, RATE_LIMIT_RULES[bucket]);
      } catch (err) {
        if (err instanceof RateLimitError) {
          return Response.json(
            { error: "Too many requests" },
            { status: 429, headers: { "Retry-After": String(err.retryAfterSeconds) } },
          );
        }
        // Rate limiting itself is abuse protection, not core functionality —
        // if its D1 counter fails for some unrelated reason, fail *open*
        // (let the request through) rather than 500ing every route.
        console.error(`[rate-limit] enforcement failed for ${bucket}, failing open:`, err);
      }
    }

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }

    if (url.pathname === "/api/top-artists") {
      return handleTopArtists(request, env);
    }

    if (url.pathname === "/api/village") {
      return handleVillage(request, env);
    }

    const assetResponse = await env.ASSETS.fetch(request);
    // CSP scoped to img-src only (Phase 3.5): the sidebar now hotlinks real
    // Spotify album/artist art from i.scdn.co (SPEC.md's cover-art rules —
    // hotlinked, never re-hosted), plus every other directive left
    // unspecified so this can't regress scripts/styles/fonts (Google Fonts,
    // the Vite module bundle, etc.) that never had a CSP to begin with.
    // Only applied to the HTML shell, not JS/CSS/asset responses.
    if (assetResponse.headers.get("Content-Type")?.includes("text/html")) {
      const headers = new Headers(assetResponse.headers);
      headers.set("Content-Security-Policy", "img-src 'self' https://i.scdn.co");
      return new Response(assetResponse.body, {
        status: assetResponse.status,
        statusText: assetResponse.statusText,
        headers,
      });
    }
    return assetResponse;
  },
} satisfies ExportedHandler<Env>;
