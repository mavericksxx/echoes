import sys
import numpy as np
from PIL import Image
from collections import Counter

def keyout(src, dst, bg_colors, threshold=30):
    im = Image.open(src).convert("RGBA")
    arr = np.array(im)
    rgb = arr[:, :, :3].astype(int)
    alpha = arr[:, :, 3].copy()
    for c in bg_colors:
        d = np.abs(rgb - np.array(c)).sum(axis=2)
        alpha[d <= threshold] = 0
    arr[:, :, 3] = alpha
    Image.fromarray(arr, "RGBA").save(dst)
    print(f"{src} -> {dst} keyed {bg_colors}")

def auto_bg(path, n=2):
    im = Image.open(path).convert("RGB")
    arr = np.array(im)
    flat = arr.reshape(-1, 3)
    common = [c for c, _ in Counter(map(tuple, flat[::5])).most_common(n)]
    corner = tuple(arr[0, 0])
    colors = list(dict.fromkeys([corner] + common))  # corner first, dedup
    return colors

if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    if len(sys.argv) > 3:
        # explicit colors as r,g,b;r,g,b
        bg_colors = [tuple(int(x) for x in trip.split(",")) for trip in sys.argv[3].split(";")]
    else:
        bg_colors = auto_bg(src)
        print("auto-detected bg:", bg_colors)
    keyout(src, dst, bg_colors)
