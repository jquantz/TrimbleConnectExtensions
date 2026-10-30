// video.js — records the build-up animation to an MP4 file in the browser.
// Frames come from the 3D viewer's own snapshot (viewer.getSnapshot), are composed onto a
// canvas with a caption band, encoded with WebCodecs (H.264, VP9 fallback) and muxed to MP4.
// Browsers without WebCodecs fall back to a WebM recording via MediaRecorder.
import { Muxer, ArrayBufferTarget } from "./vendor/mp4-muxer.mjs?v=1.3.0";
import { AvcNormalizer } from "./h264.js?v=1.3.0";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("Could not read the 3D view snapshot."));
    img.src = src;
  });
}

/** Pick the best encoder config the browser supports for this size. */
async function pickEncoder(width, height, fps) {
  if (typeof VideoEncoder === "undefined") return null;
  const bitrate = Math.round(width * height * fps * 0.12); // ~4.4 Mbps at 720p20, ~10 Mbps at 1080p20
  // H.264 Main profile first: plays in Windows Media Player / Films & TV, QuickTime, PowerPoint and phones.
  const candidates = [
    { codec: "avc1.4d0028", mux: "avc" }, // H.264 Main 4.0
    { codec: "avc1.42e028", mux: "avc" }, // H.264 Constrained Baseline 4.0
    { codec: "avc1.640028", mux: "avc" }, // H.264 High 4.0
    { codec: "vp09.00.40.08", mux: "vp9" },
  ];
  for (const c of candidates) {
    if (c.max && width * height > c.max) continue;
    const config = { codec: c.codec, width, height, bitrate, framerate: fps, latencyMode: "quality" };
    if (c.mux === "avc") config.avc = { format: "avc" };
    try {
      const { supported } = await VideoEncoder.isConfigSupported(config);
      if (supported) return { config, mux: c.mux };
    } catch { /* try next */ }
  }
  return null;
}

/** Draw one video frame: snapshot (letterboxed) + caption band. */
function compose(ctx, W, H, img, cap) {
  ctx.fillStyle = "#20262e";
  ctx.fillRect(0, 0, W, H);
  if (img) {
    const s = Math.min(W / img.width, H / img.height);
    const w = img.width * s, h = img.height * s;
    ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
  }
  if (!cap) return;
  const u = H / 720; // scale UI to resolution
  const band = 92 * u;
  ctx.fillStyle = "rgba(18, 24, 31, 0.82)";
  ctx.fillRect(0, H - band, W, band);
  // progress bar along the top of the band
  ctx.fillStyle = "rgba(255,255,255,0.15)";
  ctx.fillRect(0, H - band, W, 5 * u);
  ctx.fillStyle = cap.accent || "#ff7a00";
  ctx.fillRect(0, H - band, W * (cap.progress || 0), 5 * u);
  const font = (wt, px) => `${wt} ${Math.round(px * u)}px "Open Sans", "Segoe UI", Arial, sans-serif`;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#ffffff";
  ctx.font = font(700, 34);
  ctx.fillText(cap.title || "", 28 * u, H - band + 50 * u);
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = font(400, 18);
  ctx.fillText(cap.sub || "", 28 * u, H - band + 78 * u);
  ctx.textAlign = "right";
  ctx.fillStyle = "#ffffff";
  ctx.font = font(600, 22);
  ctx.fillText(cap.right || "", W - 28 * u, H - band + 50 * u);
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.font = font(400, 15);
  ctx.fillText(cap.footer || "", W - 28 * u, H - band + 78 * u);
  ctx.textAlign = "left";
}

/**
 * Record the sequence.
 * @param o.count        number of steps
 * @param o.paint(k)     shows the model at step k (0 = nothing built yet)
 * @param o.snapshot()   returns a data URL of the current 3D view
 * @param o.caption(k)   returns {title, sub, right, footer, progress} or null
 * @returns {blob, ext, mime, codec}
 */
export async function recordSequence(o) {
  const [W, H] = o.size;
  const fps = o.fps || 20;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  const segments = [{ k: 0, sec: o.introSec ?? 1 }];
  for (let k = 1; k <= o.count; k++) segments.push({ k, sec: k === o.count ? o.stepSec + (o.outroSec ?? 2) : o.stepSec });
  const totalFrames = segments.reduce((a, s) => a + Math.max(1, Math.round(s.sec * fps)), 0);

  const enc = await pickEncoder(W, H, fps);
  if (enc) return recordWebCodecs(o, enc, canvas, ctx, segments, fps, totalFrames);
  if (typeof MediaRecorder !== "undefined" && canvas.captureStream) return recordMediaRecorder(o, canvas, ctx, segments, fps, totalFrames);
  throw new Error("This browser can't encode video. Use a current version of Chrome, Edge or Firefox.");
}

async function grab(o, k, W, H, ctx) {
  await o.paint(k);
  await sleep(o.settleMs ?? 350);
  const img = await loadImage(await o.snapshot());
  compose(ctx, W, H, img, o.caption ? o.caption(k) : null);
}

async function recordWebCodecs(o, enc, canvas, ctx, segments, fps, totalFrames) {
  const [W, H] = o.size;
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: enc.mux, width: W, height: H, frameRate: fps },
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });
  let encErr = null;
  const avc = new AvcNormalizer();
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (enc.mux !== "avc") return muxer.addVideoChunk(chunk, meta);
      // Re-package H.264 so strict players (Windows Media Player) accept the file:
      // 4-byte length-prefixed samples + a complete avcC header, whatever the browser's encoder produced.
      try {
        const raw = new Uint8Array(chunk.byteLength);
        chunk.copyTo(raw);
        const out = avc.process(raw, meta && meta.decoderConfig && meta.decoderConfig.description);
        const fixed = new EncodedVideoChunk({ type: chunk.type, timestamp: chunk.timestamp, duration: chunk.duration ?? undefined, data: out.data });
        const fixedMeta = out.description
          ? { decoderConfig: { ...((meta && meta.decoderConfig) || {}), codec: enc.config.codec, codedWidth: W, codedHeight: H, description: out.description } }
          : undefined;
        muxer.addVideoChunk(fixed, fixedMeta);
      } catch (e) { encErr = e; }
    },
    error: (e) => { encErr = e; },
  });
  encoder.configure(enc.config);
  const dur = 1e6 / fps;
  let f = 0;
  try {
    for (const seg of segments) {
      if (o.isCancelled()) throw new Error("cancelled");
      await grab(o, seg.k, W, H, ctx);
      const n = Math.max(1, Math.round(seg.sec * fps));
      for (let i = 0; i < n; i++) {
        if (encErr) throw encErr;
        const frame = new VideoFrame(canvas, { timestamp: Math.round(f * dur), duration: Math.round(dur) });
        encoder.encode(frame, { keyFrame: f % (fps * 2) === 0 });
        frame.close();
        f++;
        while (encoder.encodeQueueSize > 8) await sleep(5);
      }
      o.onProgress && o.onProgress(f / totalFrames, seg.k);
    }
    await encoder.flush();
    if (encErr) throw encErr;
    muxer.finalize();
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }
  return { blob: new Blob([muxer.target.buffer], { type: "video/mp4" }), ext: "mp4", mime: "video/mp4", codec: enc.config.codec };
}

async function recordMediaRecorder(o, canvas, ctx, segments, fps, totalFrames) {
  const [W, H] = o.size;
  const stream = canvas.captureStream(fps);
  const mime = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
  const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 6e6 });
  const parts = [];
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  const stopped = new Promise((r) => (rec.onstop = r));
  // render the first frame before recording starts
  await grab(o, segments[0].k, W, H, ctx);
  rec.start(1000);
  let f = 0;
  try {
    for (let si = 0; si < segments.length; si++) {
      const seg = segments[si];
      if (o.isCancelled()) throw new Error("cancelled");
      if (si > 0) {
        rec.pause();
        await grab(o, seg.k, W, H, ctx);
        rec.resume();
      }
      // keep the canvas "live" for the segment's duration (real time)
      const n = Math.max(1, Math.round(seg.sec * fps));
      const snap = ctx.getImageData(0, 0, W, H);
      for (let i = 0; i < n; i++) { ctx.putImageData(snap, 0, 0); await sleep(1000 / fps); f++; }
      o.onProgress && o.onProgress(f / totalFrames, seg.k);
    }
  } finally {
    rec.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
  }
  const isMp4 = mime.startsWith("video/mp4");
  return { blob: new Blob(parts, { type: mime || "video/webm" }), ext: isMp4 ? "mp4" : "webm", mime: mime || "video/webm", codec: mime };
}
