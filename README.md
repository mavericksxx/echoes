# Echoes

A pixel village driven by Spotify listening. Each music genre is one Naruto
character living in its own district; Phase 1 renders the village with
hard-coded sample listening data — no Spotify connection yet. See `IDEA.md`
for the concept and `SPEC.md` for the full phased build plan.

## Setup

```sh
npm install
npm run assets:sync   # copies the ripped sprite/map PNGs into public/assets/
npm run dev           # http://localhost:5173
```

Other scripts:

```sh
npm run typecheck   # tsc, frontend + worker
npm run check:data  # validates data/*.json against the synced PNGs
npm run build        # vite build -> dist/
npm run deploy        # build, then wrangler deploy
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
  `src/main.ts` wires together the district view, the all-characters roster,
  and the whole-village view on top of `src/npc.ts` (wander/perform state
  machine) and `src/render.ts` (image loading + sprite/caption drawing).
- **Data** — the prototype's hard-coded sprite/map arrays live in
  `data/*.json` (`characters.json`, `districts.json`, `village.json`,
  `assets.json`), typed by `data/types.ts` and joined by `data/loader.ts`.
  This is internal data organization, not a user-facing sprite-swap feature.
  `npm run check:data` (ported from `prototypes/konoha-demo/verify.js`)
  validates it against the synced PNGs.
- **Worker** — `worker/index.ts` + `wrangler.jsonc` serve the Vite build as
  Cloudflare Workers static assets and expose `/api/health`. No D1 or
  Spotify/Gemini calls yet — those land in later phases.
- **Sample data** — `src/sample-data.ts` hard-codes a per-slot play share and
  a few fake top artists, shown in the info card and used to weight which
  character performs next in the whole-village view. Real listening data
  replaces this in Phase 3.
