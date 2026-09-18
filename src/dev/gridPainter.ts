// Dev-only walkability grid painter: overlays the active map's grid on the
// live scene (blocked cells tinted red), lets you click-drag to paint
// walkable/blocked rectangles, and exports the result to disk. Never
// shipped — main.ts only reaches this module behind `import.meta.env.DEV`
// and a dynamic `import()`, so it (and this file's own import of the whole
// walkability manifest) is excluded from the production bundle entirely.
// See vite.config.ts's walkabilityExportPlugin for the write side, which is
// itself dev-server-only (`apply: "serve"`).
//
// Toggle: F4. While open, left-drag paints blocked ('#'); hold Shift while
// dragging to paint walkable ('.') instead. Press "S" to export the current
// map's edits to data/walkability.json.

import type { Point, WalkGrid } from "../../data/types";
import { WALKABILITY } from "../../data/loader";

export interface GridPainterDeps {
  /** Asset key of the map currently on screen (a district's `bg`, or
   * VILLAGE.mapImage in the village view). */
  getMapKey(): string;
  /** The real renderer's current camera/zoom (src/main.ts) — reused so
   * there's no separate coordinate-translation bug surface. */
  getCamera(): { camX: number; camY: number; zoom: number };
  /** The real renderer's screen->world conversion (src/main.ts's
   * screenToWorld), reused for the same reason. */
  screenToWorld(clientX: number, clientY: number): Point;
  /** The on-screen game canvas the overlay should exactly cover. */
  gameCanvas: HTMLCanvasElement;
}

const EXPORT_URL = "/__walkability-export";

export function initGridPainter(deps: GridPainterDeps): void {
  let open = false;

  const overlay = document.createElement("canvas");
  overlay.style.position = "absolute";
  overlay.style.pointerEvents = "none"; // "auto" only while open, so it can intercept paint drags
  overlay.style.zIndex = "50";
  overlay.style.display = "none";
  overlay.style.cursor = "crosshair";
  deps.gameCanvas.parentElement?.appendChild(overlay);
  const octx = overlay.getContext("2d")!;

  // Edits as mutable per-row char arrays (JS strings can't be mutated in
  // place), keyed by map key and seeded lazily from WALKABILITY so switching
  // maps while open keeps each map's own edits.
  const edited = new Map<string, string[][]>();
  function rowsFor(mapKey: string): string[][] {
    let rows = edited.get(mapKey);
    if (!rows) {
      const grid = WALKABILITY[mapKey];
      rows = grid ? grid.grid.map((r) => r.split("")) : [];
      edited.set(mapKey, rows);
    }
    return rows;
  }

  function currentGrid(): WalkGrid | null {
    return WALKABILITY[deps.getMapKey()] ?? null;
  }

  function syncOverlaySize(): void {
    const rect = deps.gameCanvas.getBoundingClientRect();
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    overlay.width = Math.max(1, Math.round(rect.width));
    overlay.height = Math.max(1, Math.round(rect.height));
  }

  function draw(): void {
    if (!open) return;
    syncOverlaySize();
    octx.clearRect(0, 0, overlay.width, overlay.height);
    const grid = currentGrid();
    if (grid) {
      const rows = rowsFor(deps.getMapKey());
      const { camX, camY, zoom } = deps.getCamera();
      const cellPx = grid.cell * zoom;

      for (let cy = 0; cy < grid.rows; cy++) {
        for (let cx = 0; cx < grid.cols; cx++) {
          if (rows[cy]?.[cx] !== "#") continue;
          const sx = (cx * grid.cell - camX) * zoom;
          const sy = (cy * grid.cell - camY) * zoom;
          octx.fillStyle = "rgba(220, 40, 40, 0.35)";
          octx.fillRect(sx, sy, cellPx, cellPx);
        }
      }

      octx.strokeStyle = "rgba(255, 255, 255, 0.15)";
      octx.beginPath();
      for (let cx = 0; cx <= grid.cols; cx++) {
        const sx = (cx * grid.cell - camX) * zoom;
        octx.moveTo(sx, 0);
        octx.lineTo(sx, overlay.height);
      }
      for (let cy = 0; cy <= grid.rows; cy++) {
        const sy = (cy * grid.cell - camY) * zoom;
        octx.moveTo(0, sy);
        octx.lineTo(overlay.width, sy);
      }
      octx.stroke();
    }
    requestAnimationFrame(draw);
  }

  function paintRect(a: Point, b: Point, value: "." | "#"): void {
    const grid = currentGrid();
    if (!grid) return;
    const rows = rowsFor(deps.getMapKey());
    const cx0 = Math.max(0, Math.floor(Math.min(a.x, b.x) / grid.cell));
    const cy0 = Math.max(0, Math.floor(Math.min(a.y, b.y) / grid.cell));
    const cx1 = Math.min(grid.cols - 1, Math.floor(Math.max(a.x, b.x) / grid.cell));
    const cy1 = Math.min(grid.rows - 1, Math.floor(Math.max(a.y, b.y) / grid.cell));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const row = rows[cy];
        if (row) row[cx] = value;
      }
    }
  }

  let dragStart: Point | null = null;
  let dragValue: "." | "#" = "#";

  overlay.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    dragStart = deps.screenToWorld(ev.clientX, ev.clientY);
    dragValue = ev.shiftKey ? "." : "#";
  });
  overlay.addEventListener("pointermove", (ev) => {
    if (!dragStart) return;
    paintRect(dragStart, deps.screenToWorld(ev.clientX, ev.clientY), dragValue);
  });
  window.addEventListener("pointerup", () => {
    dragStart = null;
  });

  async function exportGrid(): Promise<void> {
    const mapKey = deps.getMapKey();
    const grid = currentGrid();
    if (!grid) return;
    const updated: WalkGrid = { ...grid, grid: rowsFor(mapKey).map((r) => r.join("")) };
    const payload = { ...WALKABILITY, [mapKey]: updated };
    try {
      const res = await fetch(EXPORT_URL, { method: "POST", body: JSON.stringify(payload) });
      console.log(
        res.ok
          ? `[gridPainter] exported walkability.json ('${mapKey}' updated)`
          : `[gridPainter] export failed: HTTP ${res.status}`,
      );
    } catch (err) {
      console.error("[gridPainter] export failed", err);
    }
  }

  window.addEventListener("keydown", (ev) => {
    if (ev.key === "F4") {
      open = !open;
      overlay.style.display = open ? "block" : "none";
      overlay.style.pointerEvents = open ? "auto" : "none";
      if (open) requestAnimationFrame(draw);
      console.log(
        `[gridPainter] ${open ? "opened" : "closed"} — F4 toggles, drag paints blocked, shift+drag paints walkable, S exports`,
      );
      return;
    }
    if (open && (ev.key === "s" || ev.key === "S")) void exportGrid();
  });
}
