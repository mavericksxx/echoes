#!/usr/bin/env python3
"""Cleans ripper watermarks and leftover green/blue-screen key colors out of
the ripped Naruto map PNGs, in place, after they've been synced into
public/assets/. The original rip files (outside this repo) are never touched.

What this fixes (see scripts/asset-patches.json for the audit trail this
script writes): several district backgrounds carry a colored key border
(a teal or magenta "green screen" color used when the sprite sheet was
originally cut out) plus ripper credit text painted on top of it, e.g.
town_bg.png's "Ripped By MattOceans" box and teal slivers on its edges,
forest_bg.png's "Links to BLUE BOX" magenta frame, and a teal frame around
hokage_monument.png. Dimensions are never changed — only pixels are
repainted, which is what data/districts.json's bgSize check verifies.

Algorithm (deliberately simple, no external inpainting library):
  1. Flood-fill inward from the four image edges through pixels that match
     a known key color (teal / magenta), with a generous tolerance. This
     marks the border-connected key region without touching a legitimate
     interior color that merely happens to match (rare, but flood-fill from
     the edge means an unrelated interior pixel is never affected).
  2. Morphological closing (dilate then erode) bridges the ripper-credit
     text, which sits *inside* that border region in a different color and
     would otherwise survive as isolated "good" islands.
  3. Every pixel in the resulting mask is replaced by a breadth-first
     nearest-neighbor fill from the closest surviving real map pixel — a
     cheap "clone stamp" that extends adjacent terrain into the bad region
     instead of leaving a transparent hole (the canvas draws this image as
     an opaque background at (0,0), so a hole would show through).

Usage: python3 scripts/clean-assets.py <assets-dir> [--report scripts/asset-patches.json]
Requires: pillow, numpy (pip install pillow numpy)
"""
import argparse
import json
import sys
from collections import deque
from pathlib import Path

try:
    import numpy as np
    from PIL import Image
except ImportError:
    print(
        "clean-assets.py: pillow/numpy not installed (pip install pillow numpy) "
        "— skipping asset cleanup, PNGs will keep their ripper watermarks/key colors.",
        file=sys.stderr,
    )
    sys.exit(0)

KEY_COLORS = [
    ("teal", np.array([0, 202, 168])),
    ("magenta", np.array([191, 127, 207])),
]
KEY_THRESHOLD = 12
CLOSE_RADIUS = 5
# Caps how far morphological closing may grow beyond the original
# border-connected key region, so bridging small text gaps can never balloon
# into erasing a large chunk of real, unrelated map art.
CLOSE_GROWTH_CAP = 10


def dilate(mask: "np.ndarray", radius: int) -> "np.ndarray":
    m = mask
    for _ in range(radius):
        p = np.pad(m, 1, mode="constant", constant_values=False)
        m = m | p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:]
    return m


def erode(mask: "np.ndarray", radius: int) -> "np.ndarray":
    m = mask
    for _ in range(radius):
        p = np.pad(m, 1, mode="constant", constant_values=True)
        m = m & p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:]
    return m


def border_connected_key_mask(arr: "np.ndarray") -> tuple["np.ndarray", list[str]]:
    """Pixels matching a key color, restricted to the region reachable from
    an image edge by walking only through key-colored pixels."""
    h, w, _ = arr.shape
    key_mask = np.zeros((h, w), dtype=bool)
    matched: list[str] = []
    for name, color in KEY_COLORS:
        d = np.abs(arr - color).sum(axis=2)
        hit = d <= KEY_THRESHOLD
        if hit.any():
            matched.append(name)
        key_mask |= hit
    if not key_mask.any():
        return key_mask, matched

    visited = np.zeros((h, w), dtype=bool)
    q: deque[tuple[int, int]] = deque()

    def seed(y: int, x: int) -> None:
        if key_mask[y, x] and not visited[y, x]:
            visited[y, x] = True
            q.append((x, y))

    for x in range(w):
        seed(0, x)
        seed(h - 1, x)
    for y in range(h):
        seed(y, 0)
        seed(y, w - 1)

    while q:
        x, y = q.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and key_mask[ny, nx] and not visited[ny, nx]:
                visited[ny, nx] = True
                q.append((nx, ny))

    return visited, matched


def nearest_neighbor_fill(arr: "np.ndarray", bad: "np.ndarray") -> "np.ndarray":
    h, w, _ = arr.shape
    out = arr.copy()
    filled = ~bad
    q: deque[tuple[int, int]] = deque()
    ys, xs = np.where(filled)
    for y, x in zip(ys.tolist(), xs.tolist()):
        q.append((x, y))
    while q:
        x, y = q.popleft()
        val = out[y, x]
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and not filled[ny, nx]:
                filled[ny, nx] = True
                out[ny, nx] = val
                q.append((nx, ny))
    return out


def box_blur_masked(arr: "np.ndarray", mask: "np.ndarray", iterations: int = 3) -> "np.ndarray":
    """Softens the nearest-neighbor fill's streaky seams by averaging each
    patched pixel with its neighbors, repeatedly. Only pixels inside `mask`
    are ever modified, and unpatched pixels are never used to seed color
    outside the mask, so real map art is untouched."""
    out = arr.astype(float)
    mask_f = mask.astype(float)[:, :, None]
    for _ in range(iterations):
        padded = np.pad(out, ((1, 1), (1, 1), (0, 0)), mode="edge")
        avg = (
            padded[:-2, 1:-1] + padded[2:, 1:-1] + padded[1:-1, :-2] + padded[1:-1, 2:] + out
        ) / 5
        out = np.where(mask_f > 0, avg, out)
    return out


def clean_file(path: Path) -> dict | None:
    im = Image.open(path).convert("RGBA")
    rgb = np.array(im.convert("RGB")).astype(int)
    border_bad, matched = border_connected_key_mask(rgb)
    if not border_bad.any():
        return None

    closed = erode(dilate(border_bad, CLOSE_RADIUS), CLOSE_RADIUS)
    growth_cap = dilate(border_bad, CLOSE_GROWTH_CAP)
    bad = closed & growth_cap

    ys, xs = np.where(bad)
    bbox = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]

    fixed_rgb = nearest_neighbor_fill(rgb, bad)
    fixed_rgb = box_blur_masked(fixed_rgb, bad)
    out = np.array(im)
    out[:, :, 0] = fixed_rgb[:, :, 0]
    out[:, :, 1] = fixed_rgb[:, :, 1]
    out[:, :, 2] = fixed_rgb[:, :, 2]
    Image.fromarray(out, "RGBA").save(path)

    return {
        "file": path.name,
        "keyColors": matched,
        "boundingBox": bbox,
        "pixelsPatched": int(bad.sum()),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("assets_dir")
    parser.add_argument("--report", default=None)
    args = parser.parse_args()

    assets_dir = Path(args.assets_dir)
    report = []
    for path in sorted(assets_dir.glob("*.png")):
        result = clean_file(path)
        if result:
            report.append(result)
            print(
                f"clean-assets: {result['file']} — patched {result['pixelsPatched']}px "
                f"({', '.join(result['keyColors'])}) bbox={result['boundingBox']}"
            )

    if args.report:
        Path(args.report).write_text(json.dumps(report, indent=2) + "\n")
        print(f"clean-assets: wrote report for {len(report)} file(s) to {args.report}")
    elif not report:
        print("clean-assets: no key-colored ripper artifacts found.")


if __name__ == "__main__":
    main()
