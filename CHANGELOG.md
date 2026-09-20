# Changelog

## Unreleased
- **Five visual features.** *Lighting:* night is now a darkness layer punched through by warm light
  pools at the districts you actually listen to (brightest at the now-playing one), on a smooth
  hourly curve instead of four fixed day parts; the old always-on dormant/quiet washes and the
  first-six-anchors night glow are gone. *Breathe:* one app-wide oscillator, driven by the
  now-playing district's mood energy, modulating light-pool radius and weather particle speed only
  (never a canvas transform — that would blur the pixel art). *Scene wipes:* entering a district
  pushes the camera to its door then irises closed and open again, with input locked during the
  transition, a re-entrancy guard and a watchdog; the old CSS fade is gone. *Emotes:* leaders hop on
  a track change, cheer when a performance starts and slump in a dormant district, as render offsets
  (no new sprite frames); spontaneous persona lines are capped at 2 on screen and 8s apart.
  *Time-lapse:* "Replay last 24h" in the Chronicle tab plays the day in ~3.5s over a new
  `/api/history/hourly`, reusing the replay override (now with an owner token so it and the
  Chronicle replay can't clobber each other).
- **Render seams (prep):** one shared `drawWorldEffects`, one per-frame `WorldEnv` (dt/ts/reduced/
  clock/hour/breathe), and `getSceneClockMs`/`getSceneHour` in world-state — a Chronicle replay's
  time of day now follows the replayed day instead of the real clock.
- **Village panel fixes:** the village panel no longer repeats the topbar buttons as tabs on
  desktop (the tab row stays below 1100px, where the topbar collapses); playlist covers load again
  (`public/_headers` CSP now allows `*.spotifycdn.com`/`*.scdn.co`, not just `i.scdn.co`) and a
  playlist's track count no longer runs into its name; Chronicle replay is visible — each step pans
  the camera to the district it changed and shows a caption on the map.
- **Village navigation:** village-wide sections (Wrapped, Playlists, Notice board, Chronicle,
  Hokage) moved out of the character sidebar into a village panel opened from new topbar buttons
  (a single "Village" button below 1100px). The character sidebar keeps only its six per-character
  tabs; tab rows wrap instead of scrolling sideways; long character names wrap instead of
  truncating. Onboarding trimmed to 2 steps and points at the topbar. Wrapped's "This week" range
  renamed "Week"; the per-character This week tab links to the notice board.
- **Phase 13 review fixes:** onboarding dismissal now persists unconditionally on close (no more
  reopening every visit); phone layout keeps the now-playing card from covering the media controls;
  the snapshot caption renders at full resolution instead of downscaled; the now-playing card's
  "Live paused" state no longer shows an idle "Not playing" card; assorted hardening (recorder error
  handling, zero-byte clip guard, zoom ignored mid-recording, iOS sound unlock on `click`, Escape
  scoped to the onboarding modal).
- **Phase 13 (part B) — Show it off:** onboarding, edge-state polish, and a disconnect-script audit,
  no new dependencies. **Onboarding** (`src/onboarding.ts`, new module): a 3-step first-visit
  walkthrough (village = Parth's listening, genres as characters/districts, the Hokage/notice
  board/Chronicle) in a centered, focus-trapped modal — dismissible, "don't show this again"
  persisted to `localStorage` (try/catch guarded), reopenable any time from the topbar's new "?"
  button. **Edge states:** an account with no top artists in any district gets a friendly village
  caption instead of 17 leaders silently idling; the now-playing card shows a clear idle state
  ("Not playing right now") for a private session, a real pause, or Spotify's own 204/null-item
  response, instead of just disappearing (still hidden entirely when the account isn't connected at
  all); the "Live paused" status chip gets a hover tooltip explaining what it means. Left for later
  (BACKLOG.md): wiring `pausedPayload`'s real history-driven activity into the frontend while
  live-paused — mixing real activity with sample-data artist rosters needs its own design pass.
  **Fetch-failure audit:** every sidebar tab with its own fetch (History, Wrapped, Playlists, Notice
  board/This week, Chronicle) now distinguishes a failed fetch from a genuinely empty result, with a
  manual Retry action on the failure state — previously both looked like the same blank message.
  **`scripts/spotify-disconnect.mjs`** now deletes every table migrations 0001–0010 define (added
  `rate_limit_window`, `caption_cache`, `slot_persona`, `weekly_brief`, `agent_run`, `agent_event`,
  `world_state` to the existing list), `agent_event` before `agent_run` for its FK.
- **Phase 13 (part A) — Show it off:** three new controls in the stage chrome, no new dependencies.
  **Snapshot** (`src/capture.ts`) flattens the game canvas and its caption overlay into one PNG
  (`echoes-YYYY-MM-DD.png`), stamped with "Parth is listening to …" when something's live. **Record**
  captures the game canvas via `canvas.captureStream` + `MediaRecorder` (mp4 where supported, else
  webm) for up to 10s with a visible countdown, then downloads the clip; hidden entirely on browsers
  without `MediaRecorder` (older iOS Safari). **Sound** (`src/sound.ts`, new module) adds small
  synthesized WebAudio cues — no asset files: a soft click on sidebar/tab actions, throttled footstep
  ticks for the village camera's arrow-key pan, and a filtered-noise ambience bed for rain/storm
  weather (silent otherwise). Muted by default; the toggle persists to `localStorage` (try/catch
  guarded) and the shared `AudioContext` is created lazily on the first user gesture.
- **Phase 12 — Village chronicle:** `GET /api/chronicle` (D1-only, reuses `/api/world`'s rate-limit
  bucket) returns the last ~30 days of `agent_run` rows newest-first, each with its `agent_event`
  rows in id order and both before/after `WorldState` snapshots. Sidebar gains a global **Chronicle**
  tab — a timeline of what the daily agent changed and why (human-readable tool labels like
  "Weather → rain", quoted reasoning), with an empty state before the agent's first run. Per-day
  **Replay** temporarily overrides the map's world state (`src/world-state.ts`'s new
  `setReplayState`, read by the same `getEffectiveWorld()` every renderer already goes through — no
  rendering fork) to that run's `stateBefore`, then steps through each event's effect
  (`shared/world.ts`'s new `applyAgentEventSlice`) every ~1.75s, highlighting the current event,
  before auto-restoring live state; a Stop control ends it early, and closing the sidebar always
  stops it too so the map can never get stuck on a past day.
- **Phase 11 — The village evolves itself:** a daily Gemini agent (first cron tick after 06:00
  owner-local) reads the last 24h/7d of listening and makes up to 4 validated, expiring changes via
  six tools (district activity, weather, festival, time-of-day override, visiting artist, character
  mood), each with a stated reason. Runs are recorded atomically in `agent_run` + `agent_event`
  (migration 0010) with a 4h retry cooldown and its own 12-steps/day Gemini sub-cap. `GET /api/world`
  (D1 only, 5-min edge cache) feeds canvas weather particles, real-clock time-of-day tint, festival
  decor, tappable visitors and a sidebar "Village today" card. `POST /api/world/run` is gated on the
  `AGENT_TRIGGER_TOKEN` secret (`?force=1`, `?again=1`).
- **Phase 10 — Talk to the Hokage:** chat sidebar tab backed by Gemini function calling over five
  read-only D1 tools (top artists, recent plays, one district's history, the latest weekly brief,
  artist lookup); replies pan the camera to the district the answer was about. `POST /api/hokage`
  (this Worker's first POST route) — 10 questions/IP/day, its own 80-steps/day Gemini sub-cap,
  exempt from the shared per-IP Gemini cap so one conversation can't starve other AI features for
  that IP. Never cached (the one accepted exception to "all LLM outputs cached" — it answers a
  question a visitor just typed).
- **Phase 9 — Weekly notice board:** the 15-min cron writes a weekly Gemini brief (once per
  Monday–Sunday week, 6h grace after week end, weeks before history began skipped); notice board on
  the village map + sidebar Notice board / This week sections. `/api/weekly-brief`, migration 0009.
- **Phase 8.6 (first cut) — Playlists:** sidebar Playlists tab listing the owner's public playlists;
  opening one shows its cast by genre character. `/api/playlists` + `/api/playlists/{id}` (id must be
  in the owner's list). Needs a Spotify reconnect for the new playlist scopes.
- **Phase 7 — Moods and personalities:** Gemini mood/energy per artist tints districts and scales NPC
  walk speed/performing; per-slot personality + dialogue (info card + sidebar Character tab); AI
  captions per song. Moods/personas/captions back off to keep 100/day of the Gemini cap for genre
  sorting; captions capped at 60/day. Migrations 0006–0008.
- **Phase 6 — Rate limits:** Passive audit of `usage_log` (0 × 429 over ~37h, peak 10 req/30s); ramp
  test skipped to avoid a 13–18h ban; current poll intervals kept. Results in SPEC.md.
- **Phase 5a — Now-playing:** Shortened the idle poll to 15s so the listening card appears sooner;
  the worker's shared cache still bounds Spotify calls.
- Project idea (IDEA.md) and phased spec (SPEC.md).
- Konoha prototype (`prototypes/konoha-demo/`) — sprite/map assets are local-only and not committed.
- **Phase 1 — Village on screen (no Spotify yet):**
  - Vite + TypeScript (strict) frontend, plain canvas 2D, no PixiJS.
  - Cloudflare Worker scaffold (`wrangler.jsonc`, `worker/index.ts`) serving the Vite build as
    static assets plus `/api/health`.
  - Prototype sprite/map data ported from `main.js` into `data/*.json` (characters, districts,
    village anchors, asset manifest) with TS types (`data/types.ts`) and a loader (`data/loader.ts`).
  - `npm run check:data` validates every referenced asset exists, every frame rect and waypoint is
    in bounds, all 17 slots are present, and village anchors sit inside the map — ported from
    `prototypes/konoha-demo/verify.js`.
  - Renderer ported to TS modules (`src/npc.ts`, `src/render.ts`, `src/main.ts`): district view
    (prev/next, tap for info card), all-characters roster, and whole-village view (all 17 NPCs at
    their anchors, "now playing" rotation weighted by sample listening share, hit-testing).
  - Hard-coded sample listening data (`src/sample-data.ts`) drives the info card's top-artist list
    and the whole-village "now playing" rotation until Phase 2/3 wire up real Spotify data.
  - Ripped assets load from a gitignored `public/assets/` folder populated by `npm run assets:sync`
    (reads from `$ASSETS_SRC`, default the sibling prototype's `assets/` folder) — never committed.
  - Responsive, mobile-first UI redesign: dusk-village design tokens (color/type/space/motion) in
    `src/style.css`, Pixelify Sans + Figtree from Google Fonts, a bottom tab bar on phones that
    becomes a top segmented control on desktop, ≥44px tap targets, visible focus states, safe-area
    insets, and `prefers-reduced-motion` support (UI transitions are cut; the canvas game loop, being
    content rather than decoration, keeps running).

- **Phase 1 fix pass** (post-review, before the first deploy's follow-up):
  - **Default view is now the whole village** with all 17 characters present; single-district view
    and the roster grid are secondary views reachable from the (reordered) view tabs.
  - **Genre sidebar** replaces the old info card: a right-side panel on desktop (~400px, map stays
    visible and interactive beside it, selected character highlighted with a ground ring) and a
    full-height slide-up sheet on phones (drag handle, close button, backdrop). Portrait header
    (character's idle frame drawn to a small canvas) + genre/name/location, then a data-driven,
    keyboard-accessible tablist (`src/sidebar.ts`'s `SECTIONS` array — Overview/Songs/Artists today,
    built so Phase 7+'s Character/History/This-week tabs are just new entries):
    - **Overview** (default): activity pill (dormant/quiet/active/festival), share of listening,
      play count, top 3 artists, now-playing row.
    - **Songs**: every song in the genre, search + artist/album filters + sort (plays/recent/title),
      empty state. Each row has a square cover-art slot, title, artist, album, plays. Sample rows
      have no real art, so the slot renders a deterministic gradient placeholder hashed from the
      song's title+artist (`src/cover-art.ts`); `Song.coverUrl`/`Song.spotifyUrl` are already in the
      type for Phase 2 to fill in — a row becomes a real `<a>` link (art untouched: `object-fit:
      contain`, no filter, no badges) only once `spotifyUrl` is set, and sample rows stay plain,
      non-link `<div>`s. A "Data from Spotify" attribution placeholder sits in the sidebar footer.
    - **Artists**: play counts per artist; tapping one jumps to Songs pre-filtered to them.
    - Esc closes from anywhere; focus moves into the panel on open and back to the (now
      keyboard-focusable) map canvas on close.
  - **Camera system** replaces the old fit-to-width stage: the canvas's backing store is the
    container size divided by an integer zoom (2 on phone, 3 on desktop), stretched back up via CSS
    so `image-rendering: pixelated` lands on exact pixels; drawing happens in world space via
    `ctx.translate(-camera)`, clamped to map bounds. Village view centers on load and supports
    drag/touch-pan plus arrow-key pan (arrows no longer switch districts there); district view
    smoothly follows its active character instead. The stage now fills all remaining viewport
    height (`.app`/`.content`/`.main` are a fixed-height flex chain), so desktop never scrolls to
    see the map, and hit-testing/sidebar-anchor math were both rebuilt against the camera offset.
  - **Asset cleanup pipeline** (`scripts/clean-assets.py`, Python + Pillow/numpy, run automatically
    by `assets:sync` after copying, output stays gitignored): flood-fills each PNG's border-connected
    teal/magenta key-color region, morphologically closes over ripper credit text sitting on top of
    it, then clone-fills the result from nearby real art (nearest-neighbor + a light blur) — fixing
    `town_bg.png`'s "Ripped By MattOceans" box and edge slivers, `forest_bg.png`'s "Links to BLUE
    BOX" magenta frame, `hokage_monument.png`'s teal frame, and the same problem found on 4 more
    maps. Dimensions are never touched. Every patch is logged to committed `scripts/asset-patches.json`.
  - `data/village.json`'s `anchors` is now `Record<slotId, Point>` with all 17 slots placed at
    distinct, open-tile-looking spots on the town map (previously only 10 of 17 had a real anchor,
    reused via a modulo hack); `check:data` asserts every slot has exactly one.
  - Artist/song/now-playing data moved out of `data/districts.json` into a real listening model in
    `src/sample-data.ts`: `Song` (title/artist/album/plays/lastPlayed/coverUrl?/spotifyUrl?) and a
    per-slot song list + `nowPlayingSongId`, with `topArtists()`/`totalPlays()`/`activityLevel()`
    helpers feeding both the sidebar and the village's weighted now-playing rotation.
  - `npm run deploy` is now `check:data && build && wrangler deploy`.
  - Recolored districts' backgrounds/sprite sheets are pre-baked into offscreen canvases once at
    load (`src/recolor.ts`) instead of calling `ctx.filter` every frame; if `ctx.filter` is silently
    unsupported (some WebKit builds), it falls back to a manual per-pixel recolor (the same
    brightness/contrast/saturate/grayscale/sepia/hue-rotate matrices as the CSS/SVG filter spec) via
    `getImageData`, feature-detected once at startup.
  - `data/assets.json` entries are now `{file, w, h}` instead of a bare filename, so
    `data/districts.json`'s `bgSize` and `data/village.json`'s `mapSize` are gone (derived from
    `assets.json` instead — one less place for dimensions to drift). `check:data` is split into a
    data-only tier (frame rects/waypoints/anchors checked against `assets.json`'s declared sizes, no
    PNG needed — safe to run in CI without the copyrighted assets) and a local-only tier (verifies
    the actual synced PNG dimensions match, only when `public/assets/` is populated).

- **Phase 2 — Log in and see your real top artists:**
  - D1 schema (`migrations/0001_init.sql`, `npm run db:migrate:local` / `db:migrate:remote`):
    `spotify_token` (single row, encrypted refresh token + scope), `artist_cache` (per-artist
    metadata, populated starting Phase 3), `usage_log` (one row per real Spotify HTTP call —
    endpoint, status, 429 count, timestamp).
  - `npm run spotify:connect` (`scripts/spotify-connect.mjs`): one-time local PKCE login against
    `http://127.0.0.1:8888/callback` (no client secret). Prints the authorize URL, handles the
    `/callback` redirect via a tiny local server, exchanges the code, encrypts the refresh token
    (AES-GCM), and writes it into the **remote** D1. Also supports a manual paste mode
    (`--code "<redirect URL or code>"`) for when the login browser is on a different device.
    `npm run spotify:disconnect` (`scripts/spotify-disconnect.mjs`) deletes every row (token +
    caches + usage log) from the remote D1.
  - Shared encryption scheme (`worker/crypto.ts` + `scripts/spotify-crypto.mjs`, AES-GCM via
    WebCrypto, same format documented in both files) so the connect script and the Worker agree on
    how the stored refresh token is encrypted/decrypted, keyed by a `TOKEN_KEY` Worker secret.
  - `worker/token.ts`: loads + decrypts the stored refresh token, exchanges it for an access token,
    caches it in memory until ~60s before expiry, and persists a rotated refresh token back to D1
    when Spotify issues one.
  - `worker/spotify-fetch.ts`: the only thing allowed to call `api.spotify.com` — honors 429
    `Retry-After`, exponential backoff with jitter on 429/5xx (max 4 retries), and logs every real
    HTTP attempt to `usage_log`. Callers only ever see a typed `SpotifyRequestError`, never a raw
    Spotify response.
  - `GET /api/top-artists?range=short_term|medium_term|long_term` (`worker/top-artists.ts`): derived
    JSON only (id, name, genres, image, rank) — no raw Spotify payload passthrough — cached ~30 min
    via the Workers Cache API. Not connected and "refresh failed" both come back as a plain `200`
    with a `connected`/`live` flag instead of an error, so the UI has a clear state to render.
  - Frontend (`src/top-artists.ts`): a small "Top artists" panel (topbar button, hidden until
    connected) with a time-range switcher, plus a `connected` / `not connected` / `live paused`
    status chip in the topbar, styled with the existing Night Overlay tokens
    (`.activity-pill`-style dot chip, glass panel chrome). No login UI anywhere — the chip and panel
    only ever reflect connection state. The genre sidebar (Overview/Songs/Artists) keeps running on
    `src/sample-data.ts`; real per-genre listening data lands in Phase 3.
  - README: "Connect your Spotify account" section (generate + set `TOKEN_KEY`, migrate the remote
    D1, run `spotify:connect` including paste mode) and disconnect instructions.

- **Phase 2.5 — One village, doors into districts:**
  - **Real interiors, not a tinted town map.** `scripts/crop-interiors.py` (sibling to
    `clean-assets.py`, sources documented crop rects, run before `assets:sync`) crops the 12
    shop/house interiors out of `raw/konoha_shops_589804.png` (6 shops) and
    `raw/konoha_houses_589805.png` (6 houses) — 2 overlap Phase 1's `ramen_interior.png`/
    `house_interior.png` and are skipped, the other 10 are new assets. The same script keys out
    `raw/hiddenleafninja_79019.png`'s solid sky-blue background (128,184,248) to real transparency —
    unlike the map sheets, a global color-distance key is correct here (a "border-connected inpaint"
    would smear color blobs onto sprites instead of leaving them transparent); the nearest non-key
    color is 144 apart, so a threshold of 20 can't clip real art (verified against the actual sheet).
    `data/assets.json` gains `hiddenLeafNinja` plus 10 interior keys; the 9 previously-recolored
    districts (Pop/Lo-fi/Darkwave/Folk/Ambient/Indie/Latin/Classical/Metalcore — SPEC.md says 10, the
    actual count in `districts.json` is 9) now point `bg` at a real interior instead of `town` +
    `recolorFilter`, with `home`/`patrol` rewritten to fit the (much smaller) interior's bounds and
    `location`/`note` updated to match (Ino → Yamanaka Flower Shop, Tenten → the weapons shop — both
    canon — and so on). `recolorFilter`/`recolored` stay in `data/types.ts` as an unused hook for a
    later *activity-level* tint, not a district's base identity.
  - **Scene stack**: village ⇄ one district, with a short opacity fade (`.stage-area.is-transitioning`
    in `src/style.css`; `prefers-reduced-motion` already collapses all transitions globally, so
    `main.ts`'s `transitionScene()` also skips the fade delay outright rather than just relying on
    CSS). Entering is explicit only — the sidebar header's new "Enter district" button
    (`src/sidebar.ts`'s `SidebarHooks.onEnterDistrict`, shown only when opened from the village); a
    bare tap still only opens the sidebar. Exits: the app bar's Back button, Esc (after the sidebar,
    if one is open), browser back (`history.pushState`/`popstate` in `main.ts`), and zooming out below
    the minimum while inside a district.
  - **`village.json` gains `doors`** — one point per slot, one per anchor, same in-bounds validation.
    Reuses each slot's existing anchor coordinates (already placed at that character's named spot,
    e.g. Naruto's is Ichiraku Ramen) rather than inventing new building coordinates — data plumbing
    for Phase 4's walk-to-door pathing; Phase 2.5 doesn't render a separate door marker or walk there,
    it fades immediately on "Enter district".
  - **Resident NPCs**: inside a district, the genre leader plus up to 3 of that slot's top artists
    (from `src/sample-data.ts`; dormant slots with no plays get no residents) wander using the
    existing NPC state machine, built from the 4 generic rigs in `raw/hiddenleafninja_79019.png`
    (`data/npcRigs.json`, `src/residents.ts`). Each gets a persistent name-label in the caption
    overlay; tapping one opens the sidebar for that district with Songs pre-filtered to them
    (`sidebar.ts`'s `openSidebar(slot, { section, filterArtist })`).
  - **Size check** (done before building the rest): a leader + 4 labeled residents in the smallest
    shop interior (200x231) at a 390px phone view is cramped once every label is persistent, not
    transient — so residents are capped at **3** everywhere (not varied by interior size) and
    `drawCaptions()` now does collision-aware layout: each label tries a few staggered heights above
    its NPC before giving up and simply not drawing (see `MAX_STAGGER_TIERS` in `src/render.ts`).
  - **Mirroring + per-NPC tints**: `CharacterDef.mirrorDirs` (new, optional) tells `drawNpc()` to flip
    a direction's frames horizontally instead of drawing them as-is — the generic rigs only have one
    side pose. `src/recolor.ts`'s `bakeRecolor()` gained its own `(source image, filter)` cache (used
    to be baked fresh every call), so residents can each get a subtle tint (small hue-rotate +
    brightness/saturate — never a full hue sweep, so skin tones don't go alien) without re-baking the
    same tint twice.
  - **View switch removed**: the Village/Districts/Roster tab bar and the roster grid are gone.
    The app bar now shows "Konoha Village" or the current district's genre + character name, plus a
    Back button that only appears inside a district.
  - `scripts/check-data.mjs` gained `village.doors` validation (mirrors `anchors`: one per slot,
    in-bounds) and a resident-rig check (`data/npcRigs.json`: each rig's down/side/up frame rects are
    3-long and fit their sheet's declared bounds, `facing` is "left"/"right").

- **Phase 3 — Your genres become characters:**
  - **Deviation:** no Last.fm API key exists, so the genre chain is Spotify genres → (if empty)
    Gemini inference from the artist name — Last.fm/MusicBrainz tags are skipped entirely (see
    SPEC.md's Phase 3 bullet). In practice this account's artists come back with empty `genres`
    from Spotify, so almost every classification goes through Gemini-from-name.
  - **`migrations/0002_phase3.sql`** (additive only): `genre_slot_map` (genre string → slot,
    source, confidence), `artist_cache` gains `slot_id`/`slot_source`/`slot_confidence`/
    `inferred_at`, `usage_log` gains `ip`, and a new `rate_limit_window` table for the per-IP
    limiter below.
  - **Genre resolution** (`worker/gemini.ts`, `worker/genre-resolution.ts`): per top artist, reuse
    `artist_cache` if already resolved; else resolve Spotify-supplied genres via `genre_slot_map`
    (one batched Gemini Flash-Lite call — pinned `gemini-3.5-flash-lite`, verified against
    ai.google.dev's model list — for whatever genre strings aren't cached yet); else batch the
    artist *names* straight to Gemini. Every real classification is cached in D1, so a given
    artist/genre string only ever costs one Gemini call. Only names/genre strings/counts are ever
    sent to Gemini, never a raw Spotify payload. A daily Gemini cap (global + per-IP, counted from
    `usage_log`) falls back to a deterministic (not persisted) nearest-slot guess once hit, and the
    response says so via `geminiLimited`.
  - **`GET /api/village`** (`worker/village.ts`): the derived world — every slot's activity level
    (dormant/quiet/active/festival, from its share of a rank-derived score across up to 50 top
    artists), share %, and its real artists ordered highest-scoring first. Artists in the
    `long_term` baseline but missing from the requested range come back `faded: true` instead of
    disappearing. Cached ~30 min via the Cache API (same pattern as `/api/top-artists`);
    `{connected:false}` with no token.
  - **Per-IP rate limiting** (`worker/rate-limit.ts`), applied centrally in `worker/index.ts` before
    any `/api/*` route runs: a fixed-window counter in D1 (`rate_limit_window`) — chosen over the
    Cache API so counts are exact and testable with `wrangler d1 execute --local` — stricter on
    `/api/village` than `/api/health`/`/api/top-artists` since it's the only Gemini-touching route.
  - **`src/listening-source.ts`** replaces sample data per sidebar tab once connected+live:
    Overview/Artists switch to real artists + activity; Songs (no per-track fetch yet) and "now
    playing" (real polling is Phase 5) stay sample-only. The topbar status chip now reads
    **Sample data** / **Connected** / **Live paused**.
  - **The room says what the panel can't**: `src/residents.ts`'s resident placement now scales
    offset distance from the leader by rank (highest-scoring centre/front, lower ones toward the
    edges); a resident whose artist is `faded` renders dimmed (`drawNpc`'s new `opacity` option) and
    stands still instead of wandering. `drawActivityTreatment` (new) gives each district a dim wash
    (dormant/quiet), extra background villagers (active/festival), and bunting (festival only) —
    the whole set documented as `shared/activity.ts`'s `ACTIVITY_TREATMENT`; the leader's
    spontaneous "vibing" chance (`npc.ts`'s `performChanceMul`) scales with it too.
  - **`shared/activity.ts`** (new, imported by both the frontend and the Worker): the single
    `activityLevel()`/threshold definition, replacing the copy that used to live in
    `src/sample-data.ts`.
  - `npm run spotify:disconnect` also clears `genre_slot_map` now.

- **Phase 3 fix pass** (post-deploy: `/api/village` returned HTTP 500 / Cloudflare error 1101 for
  every range, with no useful `wrangler tail` output):
  - **`worker/gemini.ts` no longer uses the `@google/genai` SDK** — it's a plain `fetch` against the
    Gemini REST `generateContent` endpoint now. The SDK almost certainly reached for a Node API
    `workerd` doesn't provide without the `nodejs_compat` compatibility flag; a raw `fetch` has no
    such runtime-detection surface. The `@google/genai` dependency is removed entirely.
  - **`worker/genre-resolution.ts`'s `resolveArtistSlots` is now guaranteed to never throw**: each
    Gemini call is individually try/caught (a failure behaves like a quota-cap fallback — same
    deterministic, unpersisted "nearest slot" guess — and is reported via the response's new
    `geminiError`, kept distinct from `geminiLimited`), and the whole function has an outer
    catch-all as defense in depth so a D1 hiccup mid-resolution still returns a village (every
    artist just gets the fallback slot) instead of failing the request.
  - **`worker/village.ts`** now stages token → cache read → Spotify → Gemini → assemble
    independently: an unexpected failure at any stage returns `{error, where}` as a plain `200`
    JSON body (with `console.error` server-side) instead of letting an exception reach the runtime,
    so a failure is diagnosable from the response itself rather than a bare 1101.
    `worker/index.ts`'s rate-limit check now also fails *open* (logs and lets the request through)
    if its D1 counter throws, rather than 500ing every route over an abuse-protection hiccup.

- **Phase 3 fix pass #2** (post-deploy: `/api/village` returned 200, but `geminiError` was
  `"Cannot read properties of undefined (reading 'length')"` and every artist landed on the
  deterministic hash fallback — nonsense mappings like Kanye West → Pop):
  - **Root cause, found by audit**: `worker/genre-resolution.ts` does `artist.genres.length`
    directly. `TopArtistOut.genres` is typed as a non-optional `string[]`, but Spotify's deprecated
    `genres` field — confirmed empty (`[]`) for this account's *top 10* artists (`/api/top-artists`'s
    limit) — can apparently come back **missing entirely** for some artist further down a *top 50*
    fetch (`/api/village`'s limit), which is new in Phase 3. One such artist crashes the `.filter()`
    call for the whole batch; the fix pass #1 catch-all then (correctly) fell back *every* artist in
    the batch rather than crashing the request, which is exactly the reported symptom.
  - **`worker/top-artists.ts`'s `deriveArtists`** now normalizes `genres` to `[]` when Spotify omits
    it, at the one place every caller gets artist data from, instead of re-guarding it everywhere.
  - **`worker/gemini.ts`'s response parser rewritten to be fully explicit** rather than defaulting
    silently through optional chaining: checks `promptFeedback.blockReason` (blocked prompt),
    `candidates[0]` existing, `finishReason !== "STOP"`, and `content.parts` existing/non-empty, each
    with its own `GeminiRequestError` message carrying the HTTP status and the first ~300 chars of
    the raw body — so any future mismatch is self-explanatory from `geminiError` alone instead of a
    generic error.
  - Verified the request shape against ai.google.dev's current REST docs: `generationConfig`
    nesting for `responseMimeType`/`responseSchema` is correct, `contents[].parts[].text` is
    correct, `gemini-3.5-flash-lite` supports structured output (no separate mechanism for Gemini 3
    models). Both prompts now also explicitly say which JSON fields to return, on top of the schema
    constraint.
  - Added `scripts/gemini-smoke.mjs` (`npm run gemini:smoke`) — a standalone, human-run-only script
    (reads `data/districts.json` directly, mirrors `classifyArtistNames` exactly) that classifies 3
    hardcoded artists and prints the raw response on any failure, for checking prompt/schema/model
    changes without a full deploy.
  - Confirmed (by code trace, not just intent): a `"fallback"`-sourced slot is never written to
    `artist_cache` or `genre_slot_map` — every write site is gated on `slot.source !== "fallback"`,
    and this has been true since the very first Phase 3 commit — so no bad rows exist to clean up.

- **Phase 3.5 — Songs tab goes real:**
  - **`worker/tracks.ts`** (new): fetches `GET /me/top/tracks` (limit 50, current range) through the
    existing rate-aware `spotifyGet` — no `/me/player/recently-played` (Phase 8) and no batch
    `GET /tracks`/`/artists`/`/albums` (Spotify removed all three in Feb 2026). Buckets each track
    into a slot by its *primary* artist's already-resolved slot from the Phase 3 artist union — a
    track whose primary artist isn't a known resident is dropped, never guessed at, so this is zero
    additional Gemini calls and zero new `artist_cache` rows.
  - **`worker/village.ts`** grows a 4th `handleVillage` stage ("tracks"), with its own try/catch:
    `slots[].songs` and a top-level `songsLive` flag are added to the payload; a top-tracks failure
    sets `songsLive: false` and leaves every slot's `songs: []` but still returns the real
    artist/activity data rather than falling back to `pausedPayload`. No new endpoint, no new D1
    table — songs live only in the existing 30-minute `caches.default` village entry.
  - **`src/sample-data.ts`'s `Song`** type gains optional `artistIds`/`rank` and makes `plays`/
    `lastPlayed` optional (Spotify's top-tracks endpoint gives neither play counts nor timestamps) —
    audited every reader (`slot()`'s now-playing pick, `totalPlays`, `topArtists`, and every
    `src/sidebar.ts` render path) so none of them silently produce `undefined`/`NaN`.
  - **`src/listening-source.ts`'s `getSongs()`** now returns real per-slot tracks when
    connected+live, replacing the "Songs stays sample regardless" doc comment/behavior from Phase 3.
  - **Bug fix**: `src/sidebar.ts`'s Songs artist filter compared `song.artist` (a display string,
    comma-joined for features) by exact equality, so tapping a resident who's featured — not
    primary-credited — on a track made that row silently vanish from the filtered view. Real songs
    now carry `artistIds: string[]`; the filter matches by membership (`matchesArtistFilter`), and
    `main.ts`/`src/residents.ts` now thread an artist *id* through the resident-tap → Songs-filter
    path instead of a bare name.
  - Sort options relabel to "Top tracks" (rank order) and drop "Recently played" entirely when live
    (no timestamps to sort by) instead of leaving it as a no-op; the plays/rank badge and the
    "— time ago" row suffix hide themselves when the underlying data isn't there.
  - Added a `Content-Security-Policy: img-src 'self' https://i.scdn.co` header on the Worker's HTML
    response (`worker/index.ts`) — none existed before; scoped to `img-src` only so it can't regress
    scripts/styles/fonts that never had a CSP. Added the official Spotify logo
    (`public/brand/spotify-logo-white.png`, downloaded from Spotify's press asset bucket) once in the
    sidebar footer, ≥70px wide, per SPEC.md's cover-art attribution rules.

- **Phase 3.5 fix pass** (architecture review found two real defects; a third was hit live during
  deploy; a fourth was direct user feedback on the deployed site):
  - **The CSP never fired.** `wrangler.jsonc`'s `assets` config has no `run_worker_first`, so a
    request for `/` is served straight off Cloudflare's static-asset layer *before* the Worker is
    ever invoked — the `Content-Security-Policy` header the previous entry describes, set inside
    `worker/index.ts`'s `fetch` handler on `env.ASSETS.fetch()`'s result, was dead code for exactly
    the response it needed to reach. Moved to `public/_headers` (Vite copies `public/` into `dist/`
    verbatim; Workers Static Assets honors `_headers` at that same asset layer) and removed the dead
    block from `worker/index.ts`.
  - **The Songs artist filter could strand the user.** `src/sidebar.ts`'s `matchesArtistFilter` was
    correct, but the Songs tab's own "Filter by artist" `<select>` only ever offered display-string
    options (`song.artist`), never the artist *id* a resident/artist-row tap actually sets on real
    data — so the control silently reset its displayed selection to "All artists" while the list
    stayed filtered, and (since the control's value was already `""`) re-picking "All artists" fired
    no `change` event, leaving no way to clear the filter. Fixed with a synthetic `<option>` (id as
    value, the artist's real name as label) inserted whenever the active filter isn't among the
    built-in options — rebuilt fresh every render, so it can't accumulate or leak across districts.
  - **A deploy could silently ship a village with no sprites** (this happened once in production: a
    `wrangler deploy` run directly, bypassing `npm run deploy`'s `check:data` step, uploaded `dist/`
    without `public/assets/`'s 41 ripped PNGs — a dark, empty screen live). Added
    `scripts/check-dist-assets.mjs` (also `npm run check:dist-assets`): a fast, existence-only check
    of `dist/assets/` against `data/assets.json`, wired into `wrangler.jsonc`'s new `build.command` —
    Wrangler runs this before bundling on *every* `wrangler dev`/`wrangler deploy`, including one
    typed directly with no npm script in the loop, and a non-zero exit aborts the deploy.
  - **Sidebar glass read as a wash, not frosted glass**, over the bright village map (fine over the
    darker district interiors) — direct user feedback on the live site. Added
    `--color-glass-panel` (`src/style.css`; same hue as `--color-glass`, alpha 0.55 → 0.82) for the
    two text-dense surfaces that float over the map (the sidebar and the top-artists panel) only,
    plus `blur(30px) saturate(140%)` and a faint top-down highlight/1px inset edge so the effect
    reads as diffusing glass. The lighter chrome (topbar, village caption, zoom controls) keeps the
    original token — cranking it everywhere would have made those heavy for no readability gain. The
    raised alpha alone (before any blur/saturate) keeps text legible even without `backdrop-filter`
    support.

- **Phase 8a — The play-event log starts (2026-09-18):**
  - `migrations/0004_play_event.sql` adds `play_event` (IDs/facts only: `played_at` epoch ms as the
    primary key, `track_id`, `primary_artist_id`, `artist_ids` JSON array, `duration_ms`,
    `context_uri`), `track_cache` (name/artists/album/art/url, keyed by `track_id`), and
    `history_sync` (an append-only run log). Purely additive.
  - `worker/history.ts`'s `runHistorySync`, driven by a new `scheduled()` export in
    `worker/index.ts` on a 15-min cron (`wrangler.jsonc`'s `triggers.crons`): checks for an active
    429 ban (newest `usage_log` row with `status = 429`, `created_at + retry_after_raw` still in the
    future) before ever calling Spotify; otherwise calls `GET /me/player/recently-played?limit=50`
    (deliberately no `after` cursor — see SPEC.md's Phase 8 deviations) and inserts new plays plus
    seeds `track_cache`/`artist_cache` in one `env.DB.batch()` round trip. Skips items with a null
    `track.id`, `is_local: true`, or a null primary artist id. Detects a likely history gap
    (`inserted === fetched` on a non-first run — the endpoint only ever retains the newest 50, no
    paging) and records it rather than trying to recover. Never throws; every exit path either
    returns quietly (not connected) or logs a `history_sync` row.
  - `worker/spotify-fetch.ts`: a `Retry-After` over 60s now throws `SpotifyRequestError(429)`
    immediately instead of sleeping — post-Feb-2026 reports put this value as high as 13-18 hours
    (SPEC.md), which would otherwise mean a multi-hour sleep inside a scheduled invocation (Cloudflare
    kills those long before that) or a hung visitor request. The 429 `usage_log` row is already
    written before this point, which is exactly what the cron's ban check reads.
  - `GET /api/history/stats` (`worker/history.ts`'s `handleHistoryStats`) returns
    `{ collectingSince, plays, lastPlayedAt, lastSyncAt }`, D1-only (no `caches.default` entry — it's
    already just two small local tables). New `historyStats` entries in `worker/index.ts`'s
    `ROUTE_BUCKETS` and `worker/rate-limit.ts`'s `RATE_LIMIT_RULES`, same limit as `topArtists`.
  - `src/history-stats.ts`'s `initHistoryStats` fetches that endpoint once on load and renders a
    small "Collecting since 18 Sep · 42 plays logged" readout (`.history-readout`, `index.html` +
    `src/style.css`), fixed bottom-left specifically so it never competes with the topbar on a phone.
    Honest empty state: nothing renders until data exists rather than showing "0 plays" as a result.
    `src/main.ts` picks up one import + one `void initHistoryStats();` call — kept minimal since two
    other phases are editing that file in parallel.
  - `scripts/spotify-disconnect.mjs` now also deletes `play_event`, `track_cache`, and
    `history_sync` — otherwise "disconnect deletes every row" (SPEC.md) would have gone false the
    moment this shipped.
  - **Verified `artist_cache` seeding is invisible to the village pipeline.** The cron's seed insert
    never sets `slot_id` (only `artist_id`/`name`/`genres='[]'`/`image_url`/`cached_at`), and the only
    two places anything reads or writes `artist_cache` are `worker/genre-resolution.ts`'s
    `fetchCachedArtists` (`... AND slot_id IS NOT NULL` — confirmed locally that a seeded row with a
    null `slot_id` returns zero rows from this exact query) and `upsertArtistCache` (`INSERT ...
    ON CONFLICT(artist_id) DO UPDATE SET` every column — so a later real classification fully
    overwrites a seed row rather than merging with it).
  - **Scope:** this is the logging half of Phase 8 only (SPEC.md's 8a/8b split). No
    `daily_snapshot` rollups, no history-driven activity levels, no sidebar History section, no
    era/time-range toggle — those are Phase 8b. Deviations from the original plan (no `after` cursor,
    no `slot_id` on `play_event`, why `track_cache` exists) and known omissions (sub-30s/private/
    podcast plays, `duration_ms` being track length not listened time, the per-isolate token-cache
    exposure this cron makes more frequent) are documented in SPEC.md's Phase 8 section and
    BACKLOG.md.

- **Phase 8.5 — Wrapped on demand (2026-09-19):**
  - `GET /api/wrapped?range=week|month|year|all` (`worker/wrapped.ts`, `historyStats`'s rate-limit
    bucket reused): D1-only over `play_event` for the common case — total plays, `approxMinutes`
    (`SUM(duration_ms) / 60000`, rounded), top 10 tracks (joined to `track_cache`), top 10 artists
    (aggregated by `primary_artist_id`, one vote per play — same convention as
    `worker/history-query.ts`'s `slotPlaysBetween`, which this reuses directly for the top 5 genres +
    `unclassifiedPlays`). `collectingSince` is always the true whole-history answer, never scoped to
    `range` — SPEC.md's Phase 8.5 "no backfill" decision means it's the honest way to show how far
    back real data goes.
  - **Fallback below ~50 plays in the window:** `/me/top/tracks` (`worker/tracks.ts`'s
    `fetchTopTracks`, reused as-is) + `/me/top/artists` (`worker/top-artists.ts`'s `deriveArtists`,
    reused as-is) at week/month → `short_term`, year → `medium_term`, all → `long_term`. Rank-only —
    `plays`/`totalPlays`/`approxMinutes` come back `null`, never estimated from a rank. Checks
    `worker/history.ts`'s `isSpotifyBanned` (now exported) before ever calling Spotify, same as the
    cron. If the fallback can't run at all (not connected, banned, or the calls themselves fail) the
    thin history payload is returned instead of an error — the one route in this Worker with a
    deliberately broad catch around its Spotify calls, since SPEC.md's Phase 8.5 says this endpoint
    must never error over a fallback failure.
  - **Deviation:** the Spotify fallback's `topGenres` is always `[]`. Spotify has no genre-play-count
    endpoint, and mapping its artists' raw genres to slots at request time would be an uncached
    classification call on a page load — the same rule `worker/tracks.ts` already refuses to break.
  - `src/sidebar.ts` gains a global **Wrapped** tab (`SECTIONS`, ignores the open character —
    SPEC.md: this is the listener's whole Wrapped, not a per-district one): This week/Month/Year/All
    time range picker (reusing `.ta-range`/`.ta-range-btn`), plays + "≈ N min (approx.)" stat pair
    (`.overview-stats`), top songs (`.song-row`), top artists (`.ta-row`, its `.ta-row__genres` slot
    repurposed for the plays/rank line), top genres (`.artist-row`, resolved to a display name via
    `data/loader.ts`'s `SLOTS`), "Collecting since ..." shown unconditionally, and a clear "From
    Spotify's own top lists — not enough logged plays yet" label when `source === "spotify"`.
    Loading/error/empty states match the existing History tab's wording. Cached per range in a
    module-level `Map`, including a failed fetch (never auto-retried, same as `historyDaily`) — no
    new CSS, every class reused from the Overview/Songs/Artists/History tabs and the top-artists
    panel.

- **UI reskin — Mission scroll (2026-09-19):** the whole UI chrome (topbar, sidebar, now-playing
  card, top artists panel, zoom controls, village caption, history readout, status chip) moved from
  "B — Night Overlay" (frosted dark glass, cyan/amber) to "Mission scroll": indigo ink on khaki paper
  (`--ink #1d2748` / `--paper #dcd6bd` / `--paper-2 #cfc8aa`), wooden rollers (`--wood #6a4527` /
  `--wood-dark #3e2814`) capping the sidebar's top and bottom edges, Dela Gothic One for display type
  and Zen Kaku Gothic New for body (replacing Archivo/IBM Plex Mono — `tabular-nums` kept via
  `font-variant-numeric`, not a monospace face), and a red hanko (seal, `--seal #b8321f`) reserved for
  real status only: the #1 track/artist row (`.song-row`/`.artist-row`/`.ta-row`'s `:first-child`),
  and the "Connected" status chip. The sidebar's one motion moment is an "unroll" `clip-path` reveal
  on open (`@keyframes sidebar-unroll`), covered by the existing global `prefers-reduced-motion` rule
  like every other transition/animation in this file. Active sidebar tabs are now an ink-filled
  block; `.ta-range-btn`'s selected state (Wrapped's range picker, top artists' era tabs) is
  outlined-ink with a filled-seal selected state. `src/now-playing-card.ts` gains a
  `.now-playing-card__label` reading "Parth is listening to" above the track, and its card gets a
  seal-red left edge, so a visitor can tell this is the owner's live listening rather than a generic
  player widget.
  - **AA fix:** pure `--seal` paired with `--paper` as either foreground or background measures
    ~4.1:1 — under WCAG AA's 4.5:1 for normal text at chip/badge sizes. `--seal` stays the literal
    token for non-text accents (the now-playing card's left edge, borders, the focus ring — held to
    the lower 3:1 non-text bar, which it clears); a new `--seal-deep` (`#9c2b1a`, ~5:1 against paper)
    covers every seal+paper *text* pairing (the hanko stamps, the "Connected" chip, the now-playing
    label). `--color-text-muted`/`--color-text-faint` are ink at 0.82/0.72 alpha (not the previous
    0.68/0.52) for the same reason — picked to clear 4.5:1, not just "look muted".
  - The Spotify badge in the sidebar footer (`.sidebar__spotify-logo`, a white PNG) now sits on a
    small dark plate (`.sidebar__spotify-badge`, `src/sidebar.ts`) since it disappears on paper
    otherwise — same asset, unmodified, just given a background it stays legible on.
  - Deliberately unchanged: the pixel-art canvas (village map, sprites, NPC rendering) — this
    direction is chrome-only, not the pixel art itself.
