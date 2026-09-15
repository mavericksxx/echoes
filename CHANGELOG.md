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
