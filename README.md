# Echoes

A pixel village driven by Spotify listening. Each music genre is one Naruto
character living in its own district; Phase 1 renders the village with
hard-coded sample listening data — no Spotify connection yet. The default
view is the whole village (everyone at once); tap any character to open their
genre sidebar. See `IDEA.md` for the concept and `SPEC.md` for the full
phased build plan.

## Setup

```sh
npm install
npm run assets:sync   # copies the ripped sprite/map PNGs into public/assets/
npm run dev           # http://localhost:5173
```

`assets:sync` also runs `scripts/clean-assets.py` (Python + Pillow/numpy —
`pip install pillow numpy`) to key out ripper watermarks/border colors left
in a few of the source PNGs. It's optional: if Python or those packages
aren't available, sync still succeeds and just leaves those PNGs as-is.

Other scripts:

```sh
npm run typecheck   # tsc, frontend + worker
npm run check:data  # validates data/*.json (works without PNGs; verifies synced PNGs if present)
npm run build        # vite build -> dist/
npm run deploy        # check:data, then build, then wrangler deploy
```

## Assets are not in this repo

The sprite and map PNGs are ripped from *Naruto: Path of the Ninja* / *Path of
the Ninja 2* (Nintendo DS), via The Spriters Resource. They're copyrighted, so
they're **git-ignored and never committed** — see `.gitignore`
(`public/assets/`, and the original rip in `prototypes/konoha-demo/assets/`).

`npm run assets:sync` copies them from a local folder into `public/assets/`
(gitignored, populated at dev/build time) so Vite can serve them:

```sh
ASSETS_SRC=/path/to/your/ripped/pngs npm run assets:sync
```

If `ASSETS_SRC` is unset it defaults to the folder used while building this
app, on this machine. Without the source PNGs present somewhere, the app has
no art to load — `npm run check:data` will report exactly which files are
missing.

The Naruto art itself is fixed for this project, not a user-swappable
feature — see SPEC.md's "Art direction" section.

## Architecture (Phase 1)

- **Frontend** — Vite + TypeScript (strict), plain canvas 2D (no PixiJS).
  `src/main.ts` wires together the whole-village view (default), the
  single-district view, and the all-characters roster on top of `src/npc.ts`
  (wander/perform state machine), `src/render.ts` (image loading + sprite
  drawing), and `src/recolor.ts` (pre-baked district recolors). The camera
  (integer-zoom canvas backing store + `ctx.translate`) lives in `main.ts`
  alongside pointer drag-pan/tap and keyboard pan/navigation.
- **Sidebar** — `src/sidebar.ts` renders the genre panel opened by tapping a
  character (a right-side panel on desktop, a full-height sheet on phone) as
  plain DOM. Its sections are data-driven (`SECTIONS: {id, label, render}[]`)
  so later phases add tabs without restructuring it. `src/cover-art.ts`
  generates the placeholder gradient shown in a song row until Phase 2 fills
  in real Spotify artwork.
- **Data** — the prototype's hard-coded sprite/map arrays live in
  `data/*.json` (`characters.json`, `districts.json`, `village.json`,
  `assets.json`), typed by `data/types.ts` and joined by `data/loader.ts`.
  This is internal data organization, not a user-facing sprite-swap feature.
  `npm run check:data` (ported from `prototypes/konoha-demo/verify.js`) has a
  data-only tier that needs no PNGs (safe in CI) and a local-only tier that
  verifies the synced PNGs' real dimensions when present.
- **Worker** — `worker/index.ts` + `wrangler.jsonc` serve the Vite build as
  Cloudflare Workers static assets and expose `/api/health`. No D1 or
  Spotify/Gemini calls yet — those land in later phases.
- **Sample data** — `src/sample-data.ts` hard-codes a per-slot play share and
  a song list (with fake plays/lastPlayed), shown in the sidebar and used to
  weight which character performs next in the whole-village view. Real
  listening data replaces this in Phase 3.
