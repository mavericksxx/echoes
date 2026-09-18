# Backlog

Phases are defined in SPEC.md. Done: Phase 1 (village, camera, sidebar, UI direction B, sprite fixes), Phase 2 (D1, connect script, token refresh, rate-aware wrapper, real top artists live).
Done since: Phase 3 (genres as characters), Phase 3.5 (real Songs tab), **Phase 4** (walkability
grids + A* — all 17 maps authored and visually verified, 2026-09-18), Phase 4.5 (camera), Phase 5a
(now-playing card), **Phase 5b** (the village reacts to the playing track), **Phase 8a** (the
`play_event` log).

Next: **Phase 8b** (daily rollups + history-driven world) or **Phase 6** (rate-limit ramp test).

Notes on the finished grid work: two rooms are tight enough to watch — `shopFlower` collapses the 5
resident/crowd spawn offsets onto 2 distinct cells and `shopWeapons` onto 4 (the others keep all 5),
so those two rooms may read as crowded if resident counts ever grow. `scripts/derive-walkability.py`
and `scripts/walkability-draft-interiors.json` are kept as historical record; 4 of the 15 rooms
(houseGarden, houseDining, ramenInterior, forest) ended up hand-authored rather than derived.

## Asked for, slotted later
- **Now-playing widget** (Phase 5a) — display-only card top-right, no controls. Asked 2026-09-18.
- **Camera fixes** (Phase 4.5) — eased zoom animation + fractional fit-to-screen so phones can
  actually zoom out. Blocked on Phase 4 merging; both touch src/main.ts. Asked 2026-09-18.
- **Daily rollups + history-driven world** (Phase 8b) — `daily_snapshot`, activity levels from
  history, era/time-range toggle, sidebar History section. Builds on Phase 8a's `play_event` log
  (built 2026-09-18), which only logs — none of 8b exists yet.
- **Wrapped on demand** (Phase 8.5) — minutes listened + top songs/artists/genres over arbitrary
  ranges. Phase 8a's `play_event` log is now running (built 2026-09-18), so data is accruing from
  today forward, but Wrapped itself (the view) isn't built — still blocked on that plus Phase 8b's
  `daily_snapshot`. User chose to log from today forward rather than import a data export
  (2026-09-18).
- **Playlists as places** (Phase 8.6) — playlists become enterable buildings, distinct from genre
  districts. Verify the playlist endpoints survived Feb 2026 before scoping.

## Known exposure (not a bug, not fixed yet)
- **`wrangler deploy` silently drops the cron schedule.** The API token lacks `Zone / Workers
  Routes / Edit`, so the deploy's trigger step fails on the route re-assertion — and routes and
  crons are deployed together, so it aborts before registering `crons` from wrangler.jsonc. The
  Worker still uploads and goes live, which is why this reads as a harmless error but isn't: on
  2026-09-18 it shipped Phase 8a with no cron at all, meaning the play log would never have run.
  Until the token gains that permission, **after every deploy** verify with
  `GET /accounts/{id}/workers/scripts/echoes/schedules` and re-register with a `PUT` of
  `[{"cron":"*/15 * * * *"}]` if the list comes back empty.

- **`getAccessToken`'s access-token cache is per-isolate** (`worker/token.ts:19-20`). Phase 8a's
  15-min cron (`worker/history.ts`) will often land on a cold isolate, so expect roughly one
  refresh-token POST per cron run instead of one per ~50 minutes (the token's actual TTL). Spotify's
  PKCE refresh rotates the refresh token on use, so two isolates refreshing concurrently — already
  possible before 8a — becomes a more frequent pre-existing race, not a new one. Fix: persist the
  encrypted access token + expiry in `spotify_token` so `getAccessToken` reads it before ever
  refreshing. Out of scope for 8a (SPEC.md's Phase 8 section).

## Needs the user
- ~~Register Spotify app~~ done (client id in wrangler.jsonc); account connected 2026-09-17
- Run `wrangler login` — Cloudflare CLI auth expired; deploys currently go through the API
- Gemini API key — Phase 3
- ~~Cloudflare login~~ done (wrangler already authenticated)
