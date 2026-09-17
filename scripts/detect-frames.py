#!/usr/bin/env python3
"""Finds tight sprite-frame bounding boxes on the ripped Naruto DS sheets.

The hand-guessed rects in data/characters.json often clip real sprite pixels
(hair, weapons, raised limbs) or include dead padding. This script finds the
actual sprite silhouette using alpha-channel connected components, merging
parts that are near-touching (e.g. spiky hair or a held weapon that isn't
pixel-adjacent to the body) so a single sprite doesn't get reported as several
fragments.

It does NOT relocate an animation to a different part of the sheet — `refine`
only tightens the box around whatever region a rect already points at. Rows
that are simply wrong (e.g. walk_up duplicating walk_down's coordinates) must
first be pointed at the right neighborhood by hand; use the `locate` command
to find real coordinates by scanning a region you've identified by eye in a
contact sheet (see the `contact` command), then `refine` to tighten it.

Usage:
  python3 scripts/detect-frames.py refine [--char ID] [--write]
      Tightens every anims/idle/specials rect. Prints old -> new for every
      rect that changed by more than 1px on any edge. --write saves the
      result back to data/characters.json (formatting preserved as
      json.dumps(..., indent=2)).

  python3 scripts/detect-frames.py crop OUT_DIR [--char ID]
      Dumps every current frame rect as its own PNG crop (2x nearest-neighbor
      scaled) into OUT_DIR/<char>/<anim>_<i>.png, for visual inspection.

  python3 scripts/detect-frames.py contact OUT_DIR [--char ID]
      Dumps one contact-sheet PNG per character (idle, all 4 walk dirs,
      specials) into OUT_DIR/<char>.png.

  python3 scripts/detect-frames.py locate SHEET_KEY X0 Y0 X1 Y1
      Lists every merged connected component inside the given sheet-pixel
      window, sorted left to right, with its tight bbox. Use this to find
      real coordinates for a row you've spotted by eye (e.g. a missing
      walk_up back-facing pose) before hand-editing characters.json.

Requires: pillow, numpy.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
ASSETS_DIR = ROOT / "public" / "assets"

ALPHA_THRESHOLD = 24
MERGE_RADIUS = 1  # px — bridges small gaps between hair/weapon and body.
# Frames on these sheets are packed with only ~2-4px gaps between them, so
# this must stay small enough to never bridge an inter-frame gap. A larger
# radius (tried during development) tightens a few characters' hair/prop
# tips further, but starts merging adjacent frames together on the
# tighter-packed sheets — a much worse failure than slightly-loose padding.
SEARCH_MARGIN = 6  # px — how far past an existing rect `refine` looks
MIN_COMPONENT_AREA = 4  # px — ignore stray anti-aliasing flecks


def load_json(name):
    return json.loads((DATA_DIR / name).read_text())


def dumps_compact(obj, indent=0):
    """json.dumps with indent=2, except an array of plain numbers (a rect or
    point) stays on one line — matches data/characters.json's existing style."""
    pad = "  " * indent
    pad2 = "  " * (indent + 1)
    if isinstance(obj, list):
        if not obj:
            return "[]"
        if all(isinstance(x, (int, float)) for x in obj):
            return "[" + ", ".join(json.dumps(x) for x in obj) + "]"
        items = [pad2 + dumps_compact(x, indent + 1) for x in obj]
        return "[\n" + ",\n".join(items) + "\n" + pad + "]"
    if isinstance(obj, dict):
        if not obj:
            return "{}"
        items = [pad2 + json.dumps(k) + ": " + dumps_compact(v, indent + 1) for k, v in obj.items()]
        return "{\n" + ",\n".join(items) + "\n" + pad + "}"
    return json.dumps(obj)


_alpha_cache = {}


def sheet_alpha(sheet_key, assets):
    if sheet_key in _alpha_cache:
        return _alpha_cache[sheet_key]
    entry = assets[sheet_key]
    path = ASSETS_DIR / entry["file"]
    if not path.exists():
        print(f"error: {path} not found (run `npm run assets:sync` first)", file=sys.stderr)
        sys.exit(1)
    im = Image.open(path).convert("RGBA")
    arr = np.array(im)
    alpha = arr[:, :, 3] > ALPHA_THRESHOLD
    _alpha_cache[sheet_key] = (alpha, im)
    return alpha, im


def dilate(mask, radius):
    m = mask
    for _ in range(radius):
        p = np.pad(m, 1, mode="constant", constant_values=False)
        m = m | p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:]
    return m


def label_components(mask):
    """Flood-fill labeling of a small boolean array. Returns (labels, count)."""
    h, w = mask.shape
    labels = np.zeros((h, w), dtype=np.int32)
    cur = 0
    ys, xs = np.where(mask)
    seen = set(zip(ys.tolist(), xs.tolist()))
    for y0, x0 in zip(ys.tolist(), xs.tolist()):
        if labels[y0, x0] != 0:
            continue
        cur += 1
        stack = [(y0, x0)]
        labels[y0, x0] = cur
        while stack:
            y, x = stack.pop()
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and labels[ny, nx] == 0:
                    labels[ny, nx] = cur
                    stack.append((ny, nx))
    return labels, cur


def components_in_window(alpha, x0, y0, x1, y1, margin=0):
    """Merged connected components inside [x0-margin,x1+margin) x
    [y0-margin,y1+margin), clipped to the sheet. Returns a list of
    (bbox, area) with bbox = [ax0,ay0,ax1,ay1] in full-sheet coords, tight
    around the *original* (non-dilated) alpha pixels."""
    h, w = alpha.shape
    wx0, wy0 = max(0, x0 - margin), max(0, y0 - margin)
    wx1, wy1 = min(w, x1 + margin), min(h, y1 + margin)
    crop = alpha[wy0:wy1, wx0:wx1]
    if not crop.any():
        return []
    dilated = dilate(crop, MERGE_RADIUS)
    labels, n = label_components(dilated)
    out = []
    for lbl in range(1, n + 1):
        comp = crop & (labels == lbl)
        area = int(comp.sum())
        if area < MIN_COMPONENT_AREA:
            continue
        ys, xs = np.where(comp)
        bbox = [wx0 + int(xs.min()), wy0 + int(ys.min()), wx0 + int(xs.max()) + 1, wy0 + int(ys.max()) + 1]
        out.append((bbox, area))
    return out


def overlap_area(a, b):
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    ox = max(0, min(ax1, bx1) - max(ax0, bx0))
    oy = max(0, min(ay1, by1) - max(ay0, by0))
    return ox * oy



# How much bigger a "refined" bbox is allowed to be than the rect it started
# from, as a fraction of the original's area. Legitimate tightening only ever
# GROWS a rect to pick up a clipped limb/hair/prop tip, so it should stay
# close to the original size. A much bigger bbox means MERGE_RADIUS's dilation
# (see its own comment) bridged the real ~2-4px gap to the *next frame* on a
# tightly-packed sheet, fusing two or three poses into one blob — this is what
# silently produced the overlapping walk_down rects the sprite-facing-fix pass
# found on sasuke, gaara, temari and kakashi (a frame's rect ballooning to
# ~1.7-2.5x, absorbing part of its neighbour). Rejecting oversized candidates
# here means a future `refine --write` on a tightly-packed sheet fails loudly
# ("no plausible tight bbox") instead of silently writing a wider, overlapping
# rect — see cmd_refine's caller for how this surfaces.
MAX_AREA_GROWTH = 1.6


def refine_rect(alpha, rect):
    """Best tight bbox near `rect`, chosen by overlap with the original guess
    (falls back to nearest-centroid, then largest, if nothing overlaps).
    Returns None if nothing plausible is found nearby, OR if the best
    candidate is implausibly larger than `rect` (see MAX_AREA_GROWTH) —
    almost always a sign frames were merged across a real inter-frame gap,
    not a genuinely tighter box."""
    comps = components_in_window(alpha, *rect, margin=SEARCH_MARGIN)
    if not comps:
        return None
    def score(item):
        bbox, area = item
        ov = overlap_area(bbox, rect)
        if ov > 0:
            return (2, ov)
        # no overlap: prefer the component whose center is closest to rect's
        cx, cy = (rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2
        bcx, bcy = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
        dist = ((cx - bcx) ** 2 + (cy - bcy) ** 2) ** 0.5
        return (1, -dist)
    best = max(comps, key=score)
    bbox = best[0]
    orig_area = max(1, (rect[2] - rect[0]) * (rect[3] - rect[1]))
    bbox_area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
    if bbox_area > orig_area * MAX_AREA_GROWTH:
        return None
    return bbox


def iter_rects(char_def):
    """Yields (label, rect, sheet_field) for every rect on a character."""
    for anim, frames in char_def["anims"].items():
        for i, rect in enumerate(frames):
            yield f"{anim}[{i}]", rect, "sheet"
    yield "idle", char_def["idle"], "sheet"
    for i, rect in enumerate(char_def.get("specials", [])):
        yield f"specials[{i}]", rect, "battleSheet"


def cmd_refine(args):
    characters = load_json("characters.json")
    assets = load_json("assets.json")
    changed = 0
    total = 0
    for c in characters:
        if args.char and c["id"] != args.char:
            continue
        for label, rect, sheet_field in iter_rects(c):
            total += 1
            alpha, _ = sheet_alpha(c[sheet_field], assets)
            new_rect = refine_rect(alpha, rect)
            if new_rect is None:
                print(f"  ! {c['id']}.{label}: no plausible tight bbox found near {rect} "
                      f"(no alpha pixels, or the only candidate looked merged with a neighbour)")
                continue
            if list(new_rect) != list(rect):
                edge_delta = max(abs(a - b) for a, b in zip(new_rect, rect))
                if edge_delta > 1:
                    changed += 1
                    print(f"  {c['id']}.{label}: {rect} -> {new_rect}")
                if args.write:
                    if sheet_field == "sheet":
                        # write back into the anims/idle structure
                        if label == "idle":
                            c["idle"] = new_rect
                        else:
                            anim, idx = label[:-1].split("[")
                            c["anims"][anim][int(idx)] = new_rect
                    else:
                        idx = int(label[len("specials["):-1])
                        c["specials"][idx] = new_rect
    print(f"\n{changed}/{total} rect(s) changed by >1px.")
    if args.write:
        (DATA_DIR / "characters.json").write_text(dumps_compact(characters) + "\n")
        print("Wrote data/characters.json")


def cmd_crop(args):
    characters = load_json("characters.json")
    assets = load_json("assets.json")
    out = Path(args.out_dir)
    for c in characters:
        if args.char and c["id"] != args.char:
            continue
        cdir = out / c["id"]
        cdir.mkdir(parents=True, exist_ok=True)
        for label, rect, sheet_field in iter_rects(c):
            _, im = sheet_alpha(c[sheet_field], assets)
            x0, y0, x1, y1 = rect
            crop = im.crop((x0, y0, x1, y1))
            w, h = crop.size
            crop = crop.resize((max(1, w * 3), max(1, h * 3)), Image.NEAREST)
            fname = label.replace("[", "_").replace("]", "")
            crop.save(cdir / f"{fname}.png")
    print(f"Wrote crops to {out}")


DIRS = ["down", "left", "right", "up"]


def cmd_contact(args):
    characters = load_json("characters.json")
    assets = load_json("assets.json")
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for c in characters:
        if args.char and c["id"] != args.char:
            continue
        _, im = sheet_alpha(c["sheet"], assets)
        _, bimg = sheet_alpha(c["battleSheet"], assets)
        rows = []
        rows.append([c["idle"]])
        for d in DIRS:
            rows.append(c["anims"][f"walk_{d}"])
        specials_row = c.get("specials", [])
        cell = 48
        cols = max(len(r) for r in rows + [specials_row]) if specials_row else max(len(r) for r in rows)
        n_rows = len(rows) + (1 if specials_row else 0)
        sheet_out = Image.new("RGBA", (cols * cell, n_rows * cell), (40, 40, 40, 255))
        for ri, row in enumerate(rows):
            for ci, rect in enumerate(row):
                x0, y0, x1, y1 = rect
                w, h = x1 - x0, y1 - y0
                crop = im.crop((x0, y0, x1, y1))
                k = max(1, min(cell // max(1, w), cell // max(1, h)))
                crop = crop.resize((w * k, h * k), Image.NEAREST)
                sheet_out.alpha_composite(crop, (ci * cell + (cell - w * k) // 2, ri * cell + (cell - h * k) // 2))
        if specials_row:
            ri = len(rows)
            for ci, rect in enumerate(specials_row):
                x0, y0, x1, y1 = rect
                w, h = x1 - x0, y1 - y0
                crop = bimg.crop((x0, y0, x1, y1))
                k = max(1, min(cell // max(1, w), cell // max(1, h)))
                crop = crop.resize((max(1, w * k), max(1, h * k)), Image.NEAREST)
                sheet_out.alpha_composite(crop, (ci * cell + (cell - crop.width) // 2, ri * cell + (cell - crop.height) // 2))
        sheet_out.save(out / f"{c['id']}.png")
    print(f"Wrote contact sheets to {out}")


def cmd_locate(args):
    assets = load_json("assets.json")
    alpha, _ = sheet_alpha(args.sheet, assets)
    comps = components_in_window(alpha, args.x0, args.y0, args.x1, args.y1, margin=0)
    comps.sort(key=lambda item: item[0][0])
    for bbox, area in comps:
        print(f"  bbox={bbox} area={area}")
    if not comps:
        print("  (no components found in that window)")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    pr = sub.add_parser("refine")
    pr.add_argument("--char")
    pr.add_argument("--write", action="store_true")
    pr.set_defaults(func=cmd_refine)

    pc = sub.add_parser("crop")
    pc.add_argument("out_dir")
    pc.add_argument("--char")
    pc.set_defaults(func=cmd_crop)

    pk = sub.add_parser("contact")
    pk.add_argument("out_dir")
    pk.add_argument("--char")
    pk.set_defaults(func=cmd_contact)

    pl = sub.add_parser("locate")
    pl.add_argument("sheet")
    pl.add_argument("x0", type=int)
    pl.add_argument("y0", type=int)
    pl.add_argument("x1", type=int)
    pl.add_argument("y1", type=int)
    pl.set_defaults(func=cmd_locate)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
