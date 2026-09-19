# Backlog

Phases are defined in SPEC.md. Done: Phase 1 (village, camera, sidebar, UI direction B, sprite fixes), Phase 2 (D1, connect script, token refresh, rate-aware wrapper, real top artists live).
Done since: Phase 3 (genres as characters), Phase 3.5 (real Songs tab), **Phase 4** (walkability
grids + A* — all 17 maps authored and visually verified, 2026-09-18), Phase 4.5 (camera), Phase 5a
(now-playing card), **Phase 5b** (the village reacts to the playing track), **Phase 8a** (the
`play_event` log), **Phase 8b** (token cache in D1, history-driven activity, era toggle + sidebar
History strip — 2026-09-18), **Phase 8.5** (Wrapped on demand — `/api/wrapped`, sidebar Wrapped tab
— 2026-09-19), **Phase 6** (passive rate-limit audit, no ramp — 2026-09-19), **Phase 7** (moods, personas, AI
captions — deployed 2026-09-19).

Phase 8.6 first cut (sidebar playlists) deployed 2026-09-19 after the playlist-scope reconnect.
Next: playlist *buildings* on the map (8.6 follow-on).

Notes on the finished grid work: two rooms are tight enough to watch — `shopFlower` collapses the 5
resident/crowd spawn offsets onto 2 distinct cells and `shopWeapons` onto 4 (the others keep all 5),
so those two rooms may read as crowded if resident counts ever grow. `scripts/derive-walkability.py`
and `scripts/walkability-draft-interiors.json` are kept as historical record; 4 of the 15 rooms
(houseGarden, houseDining, ramenInterior, forest) ended up hand-authored rather than derived.

## Asked for, slotted later
- **Now-playing widget** (Phase 5a) — display-only card top-right, no controls. Asked 2026-09-18.
- **Camera fixes** (Phase 4.5) — eased zoom animation + fractional fit-to-screen so phones can
  actually zoom out. Blocked on Phase 4 merging; both touch src/main.ts. Asked 2026-09-18.
- ~~Daily rollups + history-driven world~~ done (Phase 8b, 2026-09-18) — see SPEC.md's Phase 8b
  deviations for what shipped differently than planned (no `daily_snapshot`; live joins instead).
- ~~Wrapped on demand~~ done (Phase 8.5, 2026-09-19) — see SPEC.md's Phase 8.5 section for what
  shipped and how it falls back to Spotify's own top lists on a thin range.
- **Playlists as places** (Phase 8.6) — playlists become enterable buildings, distinct from genre
  districts. Verify the playlist endpoints survived Feb 2026 before scoping.
- **Frontend could show paused-but-real activity** (Phase 8b follow-on) — `worker/village.ts`'s
  `pausedPayload` already computes real history-driven activity/share while live-paused (see its doc
  comment), but `src/listening-source.ts`'s `getActivity()`/`getArtists()` only read a village
  payload while `isVillageLive()`, so a paused visitor still sees sample-data activity today even
  when the API itself has something real to show. Not done here: mixing real activity numbers with
  sample-data artist rosters (paused means no real roster either) needs its own design pass rather
  than a quick wire-through.

## Known exposure (not a bug, not fixed yet)
- ~~`wrangler deploy` silently drops the cron schedule~~ fixed 2026-09-18: the API token gained
  `Zone / Workers Routes / Edit`, so deploys now register routes and the cron together.

- ~~`getAccessToken`'s access-token cache is per-isolate~~ fixed (Phase 8b's Stage 1, 2026-09-18) —
  `worker/token.ts` now persists the encrypted access token + expiry in `spotify_token` and reads it
  before ever refreshing, with a `version` column for compare-and-swap across concurrent isolates.

## Needs the user
- ~~Register Spotify app~~ done (client id in wrangler.jsonc); account connected 2026-09-17
- ~~Run `wrangler login`~~ not needed: `CLOUDFLARE_API_TOKEN` is set and deploys go through it
- ~~Cloudflare login~~ done (wrangler already authenticated)
