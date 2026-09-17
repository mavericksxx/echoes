# Changelog

## Unreleased
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
