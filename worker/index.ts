// Echoes Worker — serves the Vite build as static assets and exposes a
// small API surface. Phase 2 adds the Spotify token manager (token.ts),
// the rate-aware fetch wrapper (spotify-fetch.ts), and /api/top-artists
// (top-artists.ts) behind this same fetch handler.

import { handleTopArtists } from "./top-artists";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  /** Public PKCE client id (no client secret exists) — set in wrangler.jsonc's `vars`. */
  SPOTIFY_CLIENT_ID: string;
  /** Base64 AES-256 key encrypting the stored refresh token — a Worker secret (`wrangler secret put TOKEN_KEY`). */
  TOKEN_KEY: string;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }

    if (url.pathname === "/api/top-artists") {
      return handleTopArtists(request, env);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
