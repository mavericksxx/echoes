# Backlog

Phases are defined in SPEC.md. Done: Phase 1 (village, camera, sidebar, UI direction B, sprite fixes), Phase 2 (D1, connect script, token refresh, rate-aware wrapper, real top artists live).
Next: **Phase 4 — characters walk properly** (walkability grid + A*).

Old: **Phase 1 — Village on screen with sample data** (deployed to echoes.parthkohale.com; fix pass in progress: camera, all-characters default + song cards, map watermark cleanup).

## Parked
- **Phase 4 interior walkability grids** (15 district rooms) — parked 2026-09-18 at the user's
  request. `town` and `konohaEast` are authored, verified and live; the 15 interiors still ship the
  all-walkable placeholder, so residents and crowd villagers can wander onto furniture indoors.
  - Draft grids for 13 of 15 are in `scripts/walkability-draft-interiors.json`, derived by
    `scripts/derive-walkability.py` (sample a floor patch's palette, match per-pixel, keep the
    component containing the patch).
  - Still wrong: `ramenInterior` (collapses to a 1-cell-tall strip — too thin to wander, would
    likely fail the wander-room check) and `forest` (grass and tree canopy share a hue, so only
    ~30 of 2210 cells are found).
  - **None of the 13 are visually verified.** Before committing any of them, render each grid back
    over its PNG and look at it, the way `town` was checked — a false-walkable cell puts a resident
    on a table, which is the exact bug the user reported in the flower shop.
  - Approaches already ruled out: whole-image dominant colour (picks shadows/sky), per-cell dominant
    colour (picks tile grout not fill), and lowest-entropy 3x3 auto-patch (finds the black void
    outside a house, and flat sky).

## Asked for, slotted later
- **Now-playing widget** (Phase 5a) — display-only card top-right, no controls. Asked 2026-09-18.
- **Camera fixes** (Phase 4.5) — eased zoom animation + fractional fit-to-screen so phones can
  actually zoom out. Blocked on Phase 4 merging; both touch src/main.ts. Asked 2026-09-18.
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
