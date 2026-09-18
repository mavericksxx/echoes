import json, math
from collections import Counter, deque
from PIL import Image
CELL=16

def derive(path, patch, thresh=0.62, cover=0.90):
    """patch = (cx0,cy0,cx1,cy1) cell rect of known-clear floor. Its pixel
    colours (covering `cover` of the patch) become the floor palette; a cell
    is walkable if `thresh` of its pixels are in that palette. Result is
    restricted to the component containing the patch, so a visually similar
    but unreachable region elsewhere can't leak in."""
    im=Image.open(path).convert('RGBA'); px=im.load(); w,h=im.size
    cols=math.ceil(w/CELL); rows=math.ceil(h/CELL)
    c=Counter()
    for cy in range(patch[1],patch[3]+1):
        for cx in range(patch[0],patch[2]+1):
            for y in range(cy*CELL,min((cy+1)*CELL,h)):
                for x in range(cx*CELL,min((cx+1)*CELL,w)):
                    p=px[x,y]
                    if p[3]>=128: c[p[:3]]+=1
    tot=sum(c.values()); pal=set(); acc=0
    for col,n in c.most_common():
        pal.add(col); acc+=n
        if acc/tot>=cover: break
    cand=[[False]*cols for _ in range(rows)]
    for cy in range(rows):
        for cx in range(cols):
            t=0; g=0
            for y in range(cy*CELL,min((cy+1)*CELL,h)):
                for x in range(cx*CELL,min((cx+1)*CELL,w)):
                    p=px[x,y]; t+=1
                    if p[3]>=128 and p[:3] in pal: g+=1
            cand[cy][cx]= t>0 and g/t>=thresh
    seed=(patch[0],patch[1])
    grid=[['#']*cols for _ in range(rows)]
    if cand[seed[1]][seed[0]]:
        q=deque([seed]); seen={seed}
        while q:
            x,y=q.popleft(); grid[y][x]='.'
            for dx,dy in((1,0),(-1,0),(0,1),(0,-1)):
                n=(x+dx,y+dy)
                if 0<=n[0]<cols and 0<=n[1]<rows and cand[n[1]][n[0]] and n not in seen:
                    seen.add(n); q.append(n)
    return {"cell":CELL,"cols":cols,"rows":rows,"grid":[''.join(r) for r in grid]}, len(pal)
