// Recolors a district's background/sprite sheets to stand in for a distinct
// location (see data/districts.json's recolorFilter). Baked once into an
// offscreen canvas at load time instead of calling ctx.filter every frame.
//
// Some WebKit builds expose CanvasRenderingContext2D.filter but silently
// ignore it, so we feature-test it once and fall back to a manual per-pixel
// recolor (via getImageData) replicating the handful of CSS filter functions
// this project actually uses: brightness, contrast, saturate, grayscale,
// sepia, hue-rotate. Matrices are the standard ones from the CSS/SVG Filter
// Effects spec.

type PixelFn = (r: number, g: number, b: number) => [number, number, number];

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function fnBrightness(amount: number): PixelFn {
  return (r, g, b) => [r * amount, g * amount, b * amount];
}

function fnContrast(amount: number): PixelFn {
  const intercept = 128 * (1 - amount);
  return (r, g, b) => [r * amount + intercept, g * amount + intercept, b * amount + intercept];
}

function fnSaturate(amount: number): PixelFn {
  const lr = 0.213,
    lg = 0.715,
    lb = 0.072;
  return (r, g, b) => [
    (lr + (1 - lr) * amount) * r + (lg - lg * amount) * g + (lb - lb * amount) * b,
    (lr - lr * amount) * r + (lg + (1 - lg) * amount) * g + (lb - lb * amount) * b,
    (lr - lr * amount) * r + (lg - lg * amount) * g + (lb + (1 - lb) * amount) * b,
  ];
}

function fnGrayscale(amount: number): PixelFn {
  const lr = 0.2126,
    lg = 0.7152,
    lb = 0.0722;
  return (r, g, b) => {
    const gray = lr * r + lg * g + lb * b;
    return [r + amount * (gray - r), g + amount * (gray - g), b + amount * (gray - b)];
  };
}

function fnSepia(amount: number): PixelFn {
  return (r, g, b) => {
    const sr = 0.393 * r + 0.769 * g + 0.189 * b;
    const sg = 0.349 * r + 0.686 * g + 0.168 * b;
    const sb = 0.272 * r + 0.534 * g + 0.131 * b;
    return [r + amount * (sr - r), g + amount * (sg - g), b + amount * (sb - b)];
  };
}

function fnHueRotate(deg: number): PixelFn {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const m = [
    0.213 + cos * 0.787 - sin * 0.213,
    0.715 - cos * 0.715 - sin * 0.715,
    0.072 - cos * 0.072 + sin * 0.928,
    0.213 - cos * 0.213 + sin * 0.143,
    0.715 + cos * 0.285 + sin * 0.14,
    0.072 - cos * 0.072 - sin * 0.283,
    0.213 - cos * 0.213 - sin * 0.787,
    0.715 - cos * 0.715 + sin * 0.715,
    0.072 + cos * 0.928 + sin * 0.072,
  ] as const;
  return (r, g, b) => [
    m[0] * r + m[1] * g + m[2] * b,
    m[3] * r + m[4] * g + m[5] * b,
    m[6] * r + m[7] * g + m[8] * b,
  ];
}

const FILTER_FACTORIES: Record<string, (value: number) => PixelFn> = {
  brightness: fnBrightness,
  contrast: fnContrast,
  saturate: fnSaturate,
  grayscale: fnGrayscale,
  sepia: fnSepia,
  "hue-rotate": fnHueRotate,
};

function parseFilterChain(filter: string): PixelFn[] {
  const re = /([\w-]+)\(([-\d.]+)(deg|%)?\)/g;
  const fns: PixelFn[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(filter))) {
    const name = m[1]!;
    let value = parseFloat(m[2]!);
    if (m[3] === "%") value /= 100;
    const factory = FILTER_FACTORIES[name];
    if (factory) fns.push(factory(value));
  }
  return fns;
}

/** Applies a CSS-filter-like string to ImageData in place, pixel by pixel. */
export function applyFilterToImageData(data: ImageData, filter: string): void {
  const fns = parseFilterChain(filter);
  if (fns.length === 0) return;
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    let r = px[i]!;
    let g = px[i + 1]!;
    let b = px[i + 2]!;
    for (const fn of fns) [r, g, b] = fn(r, g, b);
    px[i] = clamp255(r);
    px[i + 1] = clamp255(g);
    px[i + 2] = clamp255(b);
  }
}

let cachedFilterSupport: boolean | null = null;

/** Feature-detects whether ctx.filter is actually honored on <canvas> (some
 * WebKit builds expose the property but silently no-op it). */
export function supportsCanvasFilter(): boolean {
  if (cachedFilterSupport !== null) return cachedFilterSupport;
  const c = document.createElement("canvas");
  c.width = 2;
  c.height = 2;
  const ctx = c.getContext("2d");
  if (!ctx || typeof ctx.filter === "undefined") {
    cachedFilterSupport = false;
    return false;
  }
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, 2, 2);
  ctx.filter = "invert(1)";
  ctx.fillRect(0, 0, 2, 2);
  const sample = ctx.getImageData(0, 0, 1, 1).data;
  cachedFilterSupport = (sample[0] ?? 0) > 200;
  return cachedFilterSupport;
}

// Cache of baked canvases, keyed by (source image, filter string) — so
// repeated calls for the same pair (e.g. several residents sharing one rig
// sheet + tint, see src/residents.ts) reuse one canvas instead of re-baking.
// Keyed on the source image's identity (not its URL) since recolored
// characters/districts and resident tint variants all recolor from
// already-loaded <img> elements, never raw URLs.
const recolorCache = new WeakMap<HTMLImageElement, Map<string, HTMLCanvasElement>>();

/** Pre-bakes a recolored copy of `source` into a new canvas, once per
 * (source, filter) pair — cached so the main render loop never calls
 * ctx.filter per frame, and so multiple callers asking for the same tint of
 * the same sheet share one baked canvas. */
export function bakeRecolor(source: HTMLImageElement, filter: string): HTMLCanvasElement {
  let byFilter = recolorCache.get(source);
  if (!byFilter) {
    byFilter = new Map();
    recolorCache.set(source, byFilter);
  }
  const cached = byFilter.get(filter);
  if (cached) return cached;

  const canvas = document.createElement("canvas");
  canvas.width = source.naturalWidth || source.width;
  canvas.height = source.naturalHeight || source.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  if (supportsCanvasFilter()) {
    ctx.filter = filter;
    ctx.drawImage(source, 0, 0);
    ctx.filter = "none";
  } else {
    ctx.drawImage(source, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    applyFilterToImageData(imageData, filter);
    ctx.putImageData(imageData, 0, 0);
  }

  byFilter.set(filter, canvas);
  return canvas;
}
