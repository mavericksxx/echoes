#!/usr/bin/env python3
"""Crops individual shop/house interior assets out of the two multi-interior
rip sheets (raw/konoha_shops_589804.png, raw/konoha_houses_589805.png) into
standalone PNGs in the assets source folder, so Phase 2.5's recolored
districts can point at a real interior instead of a tinted copy of the town
map (see SPEC.md "Phase 2.5"). Sibling to clean-assets.py — run *before*
`npm run assets:sync` (which copies from --assets-dir into public/assets/ and
then runs clean-assets.py on the copies to key out any leftover teal
border pixels at the crop edges).

Both sheets are pre-cropped: each interior already renders as a complete,
framed room graphic (ornate border + floor + a signage banner for shops) —
these rects were found with prototypes/konoha-demo/cc.py (connected
components against the sheet's background colors) and confirmed by eye
(see BACKLOG.md / the Phase 2.5 audit). Two of the twelve interiors overlap
content already cropped in Phase 1 (ramen_interior.png = the ramen shop,
house_interior.png = one of the six houses, cropped slightly tighter) — this
script only emits the other ten, which is what Phase 2.5 actually needs.

This script also keys out the resident NPC rig sheet
(raw/hiddenleafninja_79019.png) into the assets dir: unlike the map/character
sheets already in assets/ (shipped as RGBA with a real transparent
background), this rip is a flat RGB image on a solid sky-blue field
(128,184,248) — clean-assets.py's border-connected inpaint (built for opaque
map backgrounds) is the wrong tool here, since inpainting would smear blurred
color blobs around each character instead of leaving them transparent. A
plain global color-distance key is safe for this sheet: the nearest non-key
pixel is 144 apart in raw channel-sum distance (checked against the actual
sheet), so a threshold of 20 can't clip real art.

Usage: python3 scripts/crop-interiors.py <raw-dir> <assets-dir>
Requires: pillow, numpy (pip install pillow numpy)
"""
import argparse
import sys
from pathlib import Path

try:
    import numpy as np
    from PIL import Image
except ImportError:
    print(
        "crop-interiors.py: pillow/numpy not installed (pip install pillow numpy) — skipping interior crops.",
        file=sys.stderr,
    )
    sys.exit(0)

NINJA_RIG_SHEET = "hiddenleafninja_79019.png"
NINJA_RIG_KEY_COLOR = (128, 184, 248)
NINJA_RIG_KEY_THRESHOLD = 20

# [x0, y0, x1, y1] content boxes, found via cc.py against
# konoha_shops_589804.png (832x707) and konoha_houses_589805.png (1299x810).
SHOP_CROPS = {
    "shop_sweets.png": (301, 37, 501, 268),
    "shop_weapons.png": (560, 20, 784, 268),
    # (34, 52, 242, 268) is the ramen shop — already cropped as ramen_interior.png in Phase 1, skipped here.
    "shop_flower.png": (556, 294, 796, 591),
    "shop_ninja.png": (10, 318, 250, 591),
    "shop_general.png": (304, 319, 528, 591),
}

HOUSE_CROPS = {
    "house_garden.png": (17, 16, 424, 287),
    # (509, 0, 973, 400) is the same house as house_interior.png (Phase 1, cropped a bit tighter), skipped here.
    "house_study.png": (1049, 41, 1225, 297),
    "house_dining.png": (16, 307, 392, 708),
    "house_bedroom.png": (960, 406, 1296, 758),
    "house_bathhouse.png": (439, 426, 911, 754),
}


def crop_all(raw_dir: Path, assets_dir: Path) -> None:
    assets_dir.mkdir(parents=True, exist_ok=True)
    jobs = [
        ("konoha_shops_589804.png", SHOP_CROPS),
        ("konoha_houses_589805.png", HOUSE_CROPS),
    ]
    for sheet_name, crops in jobs:
        sheet_path = raw_dir / sheet_name
        if not sheet_path.exists():
            print(f"crop-interiors: missing raw sheet {sheet_path}, skipping its crops.", file=sys.stderr)
            continue
        im = Image.open(sheet_path).convert("RGB")
        for out_name, box in crops.items():
            crop = im.crop(box)
            out_path = assets_dir / out_name
            crop.save(out_path)
            print(f"crop-interiors: {sheet_name}{list(box)} -> {out_path.name} ({crop.width}x{crop.height})")


def key_out_ninja_rig(raw_dir: Path, assets_dir: Path) -> None:
    src = raw_dir / NINJA_RIG_SHEET
    if not src.exists():
        print(f"crop-interiors: missing raw sheet {src}, skipping rig keying.", file=sys.stderr)
        return
    im = Image.open(src).convert("RGBA")
    arr = np.array(im)
    rgb = arr[:, :, :3].astype(int)
    dist = np.abs(rgb - np.array(NINJA_RIG_KEY_COLOR)).sum(axis=2)
    arr[:, :, 3] = np.where(dist <= NINJA_RIG_KEY_THRESHOLD, 0, arr[:, :, 3])
    out_path = assets_dir / NINJA_RIG_SHEET
    Image.fromarray(arr, "RGBA").save(out_path)
    print(f"crop-interiors: keyed out {NINJA_RIG_KEY_COLOR} background -> {out_path.name}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("raw_dir")
    parser.add_argument("assets_dir")
    args = parser.parse_args()
    raw_dir, assets_dir = Path(args.raw_dir), Path(args.assets_dir)
    crop_all(raw_dir, assets_dir)
    key_out_ninja_rig(raw_dir, assets_dir)


if __name__ == "__main__":
    main()
