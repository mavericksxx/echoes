import numpy as np
from collections import deque

def connected_components(mask, min_size=15):
    """mask: 2D bool array, True=foreground. Returns list of (x0,y0,x1,y1) bboxes (exclusive x1/y1), sorted by (y0,x0)."""
    h, w = mask.shape
    visited = np.zeros_like(mask, dtype=bool)
    boxes = []
    for y in range(h):
        for x in range(w):
            if mask[y, x] and not visited[y, x]:
                # BFS
                q = deque([(x, y)])
                visited[y, x] = True
                minx, maxx, miny, maxy = x, x, y, y
                size = 0
                while q:
                    cx, cy = q.popleft()
                    size += 1
                    minx = min(minx, cx); maxx = max(maxx, cx)
                    miny = min(miny, cy); maxy = max(maxy, cy)
                    for dx, dy in ((1,0),(-1,0),(0,1),(0,-1),(1,1),(-1,-1),(1,-1),(-1,1)):
                        nx, ny = cx+dx, cy+dy
                        if 0 <= nx < w and 0 <= ny < h and mask[ny, nx] and not visited[ny, nx]:
                            visited[ny, nx] = True
                            q.append((nx, ny))
                if size >= min_size:
                    boxes.append((minx, miny, maxx+1, maxy+1))
    boxes.sort(key=lambda b: (b[1]//20, b[0]))
    return boxes

if __name__ == "__main__":
    import sys
    from PIL import Image
    path = sys.argv[1]
    im = Image.open(path).convert("RGB")
    arr = np.array(im)
    from collections import Counter
    flat = arr.reshape(-1,3)
    common = [c for c,_ in Counter(map(tuple, flat[::5])).most_common(3)]
    mask = np.ones(arr.shape[:2], dtype=bool)
    for c in common:
        d = np.abs(arr.astype(int) - np.array(c)).sum(axis=2)
        mask &= (d > 30)
    print("bg colors excluded:", common)
    boxes = connected_components(mask, min_size=int(sys.argv[2]) if len(sys.argv)>2 else 20)
    for b in boxes:
        print(b, "size", (b[2]-b[0]), "x", (b[3]-b[1]))
