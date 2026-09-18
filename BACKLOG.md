# Backlog

Phases are defined in SPEC.md. Done: Phase 1 (village, camera, sidebar, UI direction B, sprite fixes), Phase 2 (D1, connect script, token refresh, rate-aware wrapper, real top artists live).
Next: **Phase 4 — characters walk properly** (walkability grid + A*).

Old: **Phase 1 — Village on screen with sample data** (deployed to echoes.parthkohale.com; fix pass in progress: camera, all-characters default + song cards, map watermark cleanup).

## Asked for, slotted later
- **Wrapped on demand** (Phase 8.5) — minutes listened + top songs/artists/genres over arbitrary
  ranges. Blocked on Phase 8's history log; Spotify's API has no counts or durations. User chose to
  log from today forward rather than import a data export (2026-09-18).
- **Playlists as places** (Phase 8.6) — playlists become enterable buildings, distinct from genre
  districts. Verify the playlist endpoints survived Feb 2026 before scoping.

## Needs the user
- ~~Register Spotify app~~ done (client id in wrangler.jsonc); account connected 2026-09-17
- Run `wrangler login` — Cloudflare CLI auth expired; deploys currently go through the API
- Gemini API key — Phase 3
- ~~Cloudflare login~~ done (wrangler already authenticated)
