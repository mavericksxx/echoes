// Echoes Worker — serves the Vite build as static assets and exposes a
// small API surface. Phase 1 only needs a health check; later phases add
// Spotify/Gemini endpoints and D1 behind this same fetch handler.

export interface Env {
  ASSETS: Fetcher;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
