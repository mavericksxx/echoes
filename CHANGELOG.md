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
    `src/style.css`, Pixelify Sans + Figtree from Google Fonts, a bottom tab bar + bottom-sheet info
    card on phones that becomes a top segmented control + anchored popover on desktop, integer-ish
    canvas scaling, ≥44px tap targets, arrow-key/Esc keyboard support, visible focus states, safe-area
    insets, and `prefers-reduced-motion` support (UI transitions are cut; the canvas game loop, being
    content rather than decoration, keeps running).
