// Phase 13a ("Show it off"): PNG snapshot + short recorded clip of the
// village canvas — plain browser APIs (canvas#toBlob, canvas#captureStream,
// MediaRecorder), no new dependencies, no server round-trip. Kept in its own
// module so src/main.ts's wiring is just "call these, hook up two buttons".

const RECORD_MAX_MS = 10_000;
// Tried in order — the first one MediaRecorder.isTypeSupported() accepts
// wins. mp4 first: where a browser supports it (Safari 16.4+), an .mp4
// needs no separate player/converter to share; webm is the universal
// fallback everywhere else.
const RECORD_MIME_CANDIDATES = ["video/mp4", "video/webm;codecs=vp9", "video/webm"];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "echoes-2026-09-19" — local date. */
function dateStamp(d = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Not revoked synchronously — Safari in particular needs the click's own
  // download/navigation to actually start first.
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** A small paper-plate caption stamped along the bottom of a snapshot —
 * same paper-background/ink-text treatment as src/world-render.ts's
 * drawFestivalDecor name plate, not a new look. */
function drawStamp(ctx: CanvasRenderingContext2D, w: number, h: number, text: string): void {
  const barH = Math.max(20, Math.round(h * 0.05));
  ctx.save();
  ctx.fillStyle = "rgba(220, 214, 189, 0.9)"; // --paper
  ctx.fillRect(0, h - barH, w, barH);
  ctx.fillStyle = "#1d2748"; // --ink
  ctx.font = `600 ${Math.max(11, Math.round(barH * 0.44))}px "Zen Kaku Gothic New", -apple-system, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 10, h - barH / 2 + 1);
  ctx.restore();
}

/** Flattens the game canvas and its screen-space caption overlay (two
 * separate canvases — see index.html and src/main.ts's fitCaptionLayer)
 * into one PNG and downloads it. Both canvases already hold the current
 * frame (main.ts's rAF loop redraws every tick), so this just reads their
 * existing backing stores — no preserveDrawingBuffer dance needed, that's a
 * WebGL-only concern and this app is plain Canvas2D throughout (see
 * CHANGELOG's Phase 1 entry). Output is sized to captionCanvas's own
 * device-pixel resolution, not gameCanvas's low-res backing store — the two
 * canvases cover the same visible box (fitCaptionLayer), but gameCanvas is
 * an integer-zoomed, deliberately small backing store, and sizing the flat
 * output to it would downscale the caption layer's crisp text 4-6x into
 * illegibility. */
export function takeSnapshot(gameCanvas: HTMLCanvasElement, captionCanvas: HTMLCanvasElement, caption: string | null): void {
  const out = document.createElement("canvas");
  out.width = captionCanvas.width;
  out.height = captionCanvas.height;
  const ctx = out.getContext("2d");
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false; // keep the pixel art crisp, matches #game's own setting
  ctx.drawImage(gameCanvas, 0, 0, out.width, out.height);
  // captionCanvas is already at this same device-pixel resolution — drawn
  // 1:1, no scaling, so its text stays exactly as crisp as it renders live.
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(captionCanvas, 0, 0);
  if (caption) drawStamp(ctx, out.width, out.height, caption);
  out.toBlob((blob) => {
    if (blob) download(blob, `echoes-${dateStamp()}.png`);
  }, "image/png");
}

// ---------------------------------------------------------------------------
// Recorded clip — records the game canvas only, not the caption overlay:
// compositing two live canvases into a third at a steady frame rate for a
// 10s clip isn't worth the extra moving parts here (SPEC.md Phase 13 asks
// for "the canvas", singular).
// ---------------------------------------------------------------------------

/** Whether this browser can record at all — captureStream and MediaRecorder
 * both need to exist (older iOS Safari has neither). Callers hide the
 * Record control entirely when this is false. */
export function isRecordingSupported(): boolean {
  return (
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function" &&
    typeof MediaRecorder !== "undefined"
  );
}

function pickMimeType(): string | null {
  return RECORD_MIME_CANDIDATES.find((mime) => MediaRecorder.isTypeSupported(mime)) ?? null;
}

export interface Recording {
  /** Stops early (recording also stops itself automatically at
   * RECORD_MAX_MS). Safe to call more than once. */
  stop(): void;
}

/** Starts recording `canvas` for up to RECORD_MAX_MS. `onTick` fires on a
 * short interval with the remaining time (for a countdown readout); `onDone`
 * fires once with the finished clip. Returns null if no candidate mime type
 * is accepted — callers should already have checked isRecordingSupported()
 * before offering the control at all, but this double-checks the specific
 * mime types. */
export function startRecording(
  canvas: HTMLCanvasElement,
  onTick: (remainingMs: number) => void,
  onDone: (blob: Blob, mimeType: string) => void,
): Recording | null {
  const mimeType = pickMimeType();
  if (!mimeType) return null;

  const stream = canvas.captureStream(30);
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (ev) => {
    if (ev.data.size > 0) chunks.push(ev.data);
  });
  // A mid-recording failure (device/codec issue) still fires "stop" right
  // after — logged here only so it isn't silently swallowed, onDone still
  // runs and callers already guard against an empty blob.
  recorder.addEventListener("error", (ev) => {
    console.error("MediaRecorder error", ev);
  });

  const startedAt = performance.now();
  let tickTimer: number | undefined;
  const tick = (): void => {
    const remaining = Math.max(0, RECORD_MAX_MS - (performance.now() - startedAt));
    onTick(remaining);
    if (remaining > 0) tickTimer = window.setTimeout(tick, 200);
  };

  recorder.addEventListener("stop", () => {
    window.clearTimeout(tickTimer);
    stream.getTracks().forEach((track) => track.stop());
    onDone(new Blob(chunks, { type: mimeType }), mimeType);
  });

  recorder.start();
  tick();
  const maxTimer = window.setTimeout(() => {
    if (recorder.state !== "inactive") recorder.stop();
  }, RECORD_MAX_MS);

  return {
    stop: () => {
      window.clearTimeout(maxTimer);
      if (recorder.state !== "inactive") recorder.stop();
    },
  };
}

/** "mp4" or "webm", matching whichever mime type actually got recorded. */
export function extensionFor(mimeType: string): string {
  return mimeType.startsWith("video/mp4") ? "mp4" : "webm";
}

export function downloadRecording(blob: Blob, mimeType: string): void {
  download(blob, `echoes-${dateStamp()}.${extensionFor(mimeType)}`);
}
