// Export pipeline: turns one photo or video into its restored version.
//
// Fast path (MP4/MOV with a codec the browser decodes):
//   File ─ mp4.js demux ─ VideoDecoder ─ per-frame Rust analysis on a
//   256 px thumbnail ─ GPU shader (gpu.js) or Rust/WASM ─ VideoEncoder
//   (H.264 / HEVC, hardware when available) ─ MP4 muxer, original AAC sound
//   copied untouched. No seeking, no full-size pixel copies on the GPU path.
// Compatibility path (anything else the <video> element can play):
//   seek frame by frame, same processing, MP4 when H.264 encoding exists,
//   otherwise WebM (VP9/VP8 + Opus).

import { buildSettings, smoothAuto } from './engine.js';
import { openMp4, SampleReader, Mp4Writer, mp4aEntry, opusEntry } from './mp4.js';
import { WebMWriter, pickVideoCodec, encodeAudioTrack } from './webm.js';
import { loadPhotoFile, decodeForExport } from './image.js';
import { getPool } from './pool.js';
import { specksOn, detectSpecks, fillSpecks } from './specks.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const even = (x) => Math.max(2, Math.round(x / 2) * 2);
export class Fallback extends Error {}

/** Thumbnail size used for analysis (same rule as the preview). */
export function thumbSize(w, h) {
  const s = Math.min(1, 256 / Math.max(w, h));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

function aborted(signal) {
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
}

// ----------------------------------------------------------- encoders ----

const AVC_LEVELS = [ // [level_idc, max macroblocks/frame, max macroblocks/s]
  [0x1f, 3600, 108000], [0x28, 8192, 245760], [0x2a, 8704, 522240], [0x32, 22080, 589824],
  [0x33, 36864, 983040], [0x34, 36864, 2073600], [0x3c, 139264, 4177920], [0x3d, 139264, 8355840], [0x3e, 139264, 16711680],
];
const HEVC_LEVELS = [ // [level*30, max luma samples/frame, max luma samples/s]
  [93, 983040, 33177600], [120, 2228224, 66846720], [123, 2228224, 133693440], [150, 8912896, 267386880],
  [153, 8912896, 534773760], [156, 8912896, 1069547520], [183, 35651584, 2139095040],
];

function avcCodec(w, h, fps) {
  const fs = Math.ceil(w / 16) * Math.ceil(h / 16);
  const l = AVC_LEVELS.find(([, mfs, mbps]) => fs <= mfs && fs * fps <= mbps);
  return l ? `avc1.6400${l[0].toString(16)}` : null;
}
function hevcCodec(w, h, fps) {
  const ls = w * h;
  const l = HEVC_LEVELS.find(([, mfs, mps]) => ls <= mfs && ls * fps <= mps);
  return l ? `hvc1.1.6.L${l[0]}.B0` : null;
}

/** Best MP4 video encoder config the browser supports, or null. */
export async function pickMp4Encoder(w, h, fps, sourceBps, preferHevc = false) {
  if (typeof VideoEncoder === 'undefined') return null;
  const cands = [];
  const avc = avcCodec(w, h, fps);
  const hevc = hevcCodec(w, h, fps);
  const base = Math.max(w * h * fps * 0.07, sourceBps || 0);
  const mk = (family, codec, factor) => ({
    family,
    config: {
      codec, width: w, height: h, framerate: fps, latencyMode: 'quality',
      bitrate: Math.round(Math.min(120e6, Math.max(2e6, base * factor))),
      ...(family === 'avc' ? { avc: { format: 'avc' } } : { hevc: { format: 'hevc' } }),
    },
  });
  if (hevc && preferHevc) cands.push(mk('hevc', hevc, 0.75));
  if (avc) cands.push(mk('avc', avc, 1.1));
  if (hevc && !preferHevc) cands.push(mk('hevc', hevc, 0.75));
  for (const c of cands) {
    try {
      const r = await VideoEncoder.isConfigSupported(c.config);
      if (r.supported) return c;
    } catch { /* next */ }
  }
  return null;
}

/** Decode the file's audio with Web Audio and encode AAC (or Opus) for MP4. */
async function encodeAudioMp4(file, maxSeconds) {
  if (typeof AudioEncoder === 'undefined' || file.size > 1.5e9) return null;
  let buf;
  try {
    const ctx = new OfflineAudioContext(2, 48000, 48000);
    buf = await ctx.decodeAudioData(await file.arrayBuffer());
  } catch { return null; }
  const channels = Math.min(2, buf.numberOfChannels);
  for (const codec of ['mp4a.40.2', 'opus']) {
    const config = { codec, sampleRate: 48000, numberOfChannels: channels, bitrate: 160000 };
    try { if (!(await AudioEncoder.isConfigSupported(config)).supported) continue; } catch { continue; }
    const chunks = [];
    let desc = null;
    const enc = new AudioEncoder({
      output: (c, m) => {
        if (m?.decoderConfig?.description && !desc) desc = new Uint8Array(m.decoderConfig.description.buffer ? m.decoderConfig.description.buffer.slice(0) : m.decoderConfig.description.slice(0));
        const d = new Uint8Array(c.byteLength);
        c.copyTo(d);
        chunks.push({ data: d, ts: c.timestamp, dur: c.duration });
      },
      error: (e) => console.warn(e),
    });
    enc.configure(config);
    const total = Math.min(buf.length, Math.floor(maxSeconds * 48000));
    const step = codec === 'opus' ? 960 * 5 : 1024 * 5;
    for (let s = 0; s < total; s += step) {
      const n = Math.min(step, total - s);
      const planar = new Float32Array(n * channels);
      for (let c = 0; c < channels; c++) planar.set(buf.getChannelData(c).subarray(s, s + n), c * n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: channels, timestamp: Math.round((s / 48000) * 1e6), data: planar });
      enc.encode(ad);
      ad.close();
    }
    await enc.flush();
    enc.close();
    if (!chunks.length) continue;
    let entry;
    if (codec === 'opus') {
      const preSkip = desc && desc.length >= 12 ? new DataView(desc.buffer, desc.byteOffset).getUint16(10, true) : 312;
      entry = opusEntry(channels, 48000, preSkip);
    } else {
      const asc = desc && desc.length ? desc : Uint8Array.of(0x11, channels === 1 ? 0x88 : 0x90); // AAC-LC 48 kHz
      entry = mp4aEntry(asc, channels, 48000, 160000);
    }
    const t0 = chunks[0].ts;
    return {
      label: codec === 'opus' ? 'Opus' : 'AAC',
      track: { entry, timescale: 48000, mediaTime: 0 },
      samples: chunks.map((c) => ({ data: c.data, dts: Math.round(((c.ts - t0) * 48000) / 1e6), dur: Math.round((c.dur * 48000) / 1e6) })),
    };
  }
  return null;
}

// ---------------------------------------------------------- processing ----

/** Per-frame processor shared by both paths: analysis + GPU or CPU render. */
class FrameProcessor {
  constructor(eng, gpu, user, locked, srcW, srcH, outW, outH) {
    this.eng = eng;
    this.gpu = gpu && gpu.ok ? gpu : null;
    this.user = user;
    this.locked = locked; // {data, w, h} or null
    [this.tw, this.th] = thumbSize(srcW, srcH);
    this.thumbC = new OffscreenCanvas(this.tw, this.th);
    this.thumbG = this.thumbC.getContext('2d', { willReadFrequently: true });
    this.outW = outW;
    this.outH = outH;
    if (!this.gpu) {
      this.cpuC = new OffscreenCanvas(outW, outH);
      this.cpuG = this.cpuC.getContext('2d', { willReadFrequently: true });
    }
    this.sm = { smooth: null, lastT: null };
    this.t = { thumb: 0, analyze: 0, render: 0 }; // ms totals, for the speed test
  }

  get mode() { return this.gpu ? 'gpu' : 'cpu'; }

  /** Process one source (VideoFrame / video element) at time t; returns a new VideoFrame. */
  frame(src, t, timestamp, duration) {
    const { eng, user, tw, th } = this;
    const T = this.t;
    let t0 = performance.now();
    this.thumbG.drawImage(src, 0, 0, tw, th);
    const thumb = this.thumbG.getImageData(0, 0, tw, th).data;
    let t1 = performance.now();
    T.thumb += t1 - t0;
    const a = this.locked || { data: thumb, w: tw, h: th };
    const auto = smoothAuto(eng.analyze(a.data, a.w, a.h, user.red / 100, user.balance / 100), t, this.sm);
    const settings = buildSettings(auto, user);
    t0 = performance.now();
    T.analyze += t0 - t1;
    let out;
    if (this.gpu) {
      const fd = eng.gpuFrame(settings, thumb, tw, th);
      this.gpu.render(src, this.outW, this.outH, fd);
      out = new VideoFrame(this.gpu.canvas, { timestamp, duration });
    } else {
      this.cpuG.drawImage(src, 0, 0, this.outW, this.outH);
      const img = this.cpuG.getImageData(0, 0, this.outW, this.outH);
      eng.process(img.data, this.outW, this.outH, settings, img.data, thumb, tw, th);
      this.cpuG.putImageData(img, 0, 0);
      out = new VideoFrame(this.cpuC, { timestamp, duration });
    }
    T.render += performance.now() - t0;
    return out;
  }
}

const msPer = (t, n) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Math.round((v / Math.max(1, n)) * 10) / 10]));

function outputSize(w, h, maxShort) {
  let ow = w, oh = h;
  const short = Math.min(w, h);
  if (maxShort && short > maxShort) { const k = maxShort / short; ow = w * k; oh = h * k; }
  return [even(ow), even(oh)];
}

/** Common encoder driver with back-pressure. */
function makeEncoder(onChunk) {
  let err = null;
  const enc = new VideoEncoder({ output: onChunk, error: (e) => { err = e; } });
  const E = {
    enc,
    waitMs: 0,
    async push(frame, keyFrame) {
      if (err) throw err;
      enc.encode(frame, { keyFrame });
      frame.close();
      const t0 = performance.now();
      while (enc.encodeQueueSize > 4) { if (err) throw err; await sleep(1); }
      E.waitMs += performance.now() - t0;
    },
    async done() { await enc.flush(); if (err) throw err; enc.close(); },
  };
  return E;
}

// ------------------------------------------------------------ fast path ----

async function exportFast(job) {
  const { file, eng, gpu, user, locked, opts, onProgress, signal } = job;
  let demux;
  try { demux = await openMp4(file); } catch (e) { throw new Fallback(e.message); }
  const vt = demux.video;
  if (!vt) throw new Fallback('no video track');
  if (!vt.codec) throw new Fallback(`video codec ${vt.entryType} is not supported`);
  if (typeof VideoDecoder === 'undefined') throw new Fallback('WebCodecs is not available');
  const decCfg = { codec: vt.codec, codedWidth: vt.codedWidth, codedHeight: vt.codedHeight };
  if (vt.description) decCfg.description = vt.description;
  const sup = await VideoDecoder.isConfigSupported(decCfg).catch(() => ({ supported: false }));
  if (!sup.supported) throw new Fallback(`this browser cannot decode ${vt.codec}`);

  const S = vt.samples, ts = vt.timescale;
  const fps = Math.round((S.count / Math.max(vt.duration, 1e-3)) * 100) / 100;
  const [ow, oh] = outputSize(vt.codedWidth, vt.codedHeight, opts.maxShort);
  const srcBps = (vt.bytes * 8) / Math.max(vt.duration, 1e-3);
  const wantMp4 = opts.format !== 'webm';
  const mp4enc = wantMp4 ? await pickMp4Encoder(ow, oh, fps, srcBps * (ow * oh) / (vt.codedWidth * vt.codedHeight), vt.family === 'hevc') : null;
  let writer, encCfg, container, codecLabel;
  if (mp4enc) {
    encCfg = mp4enc.config;
    container = 'mp4';
    codecLabel = mp4enc.family === 'hevc' ? 'HEVC' : 'H.264';
    writer = new Mp4Writer({
      family: mp4enc.family, width: ow, height: oh, timescale: ts >= 1000 ? ts : 90000, matrix: vt.matrix,
      displayWidth: vt.displayWidth ? (vt.displayWidth * ow) / vt.codedWidth : ow,
      displayHeight: vt.displayHeight ? (vt.displayHeight * oh) / vt.codedHeight : oh,
    });
  } else {
    const pick = await pickVideoCodec(ow, oh, fps);
    if (!pick) throw new Error('This browser cannot encode video.');
    encCfg = pick.config;
    container = 'webm';
    codecLabel = pick.matroska === 'V_VP9' ? 'VP9' : 'VP8';
    writer = new WebMWriter({ width: ow, height: oh, codec: pick.matroska });
  }

  // sound
  let audioLabel = 'none';
  const at = demux.audio;
  if (container === 'mp4' && at) {
    if (at.family === 'aac' && at.asc) {
      writer.a = { entry: mp4aEntry(at.asc, at.channels || 2, at.sampleRate || 48000), timescale: at.timescale, mediaTime: at.mediaTime };
      const A = at.samples;
      const endT = at.mediaTime + vt.duration * at.timescale + at.timescale;
      for (let i = 0; i < A.count && A.dts[i] < endT; i++) writer.addAudio(file.slice(A.offsets[i], A.offsets[i] + A.sizes[i]), A.dts[i], A.dur[i]);
      audioLabel = 'original AAC, copied';
    } else {
      onProgress?.({ frac: 0, text: 'Encoding sound…' });
      const enc = await encodeAudioMp4(file, vt.duration);
      if (enc) {
        writer.a = enc.track;
        for (const s of enc.samples) writer.addAudio(s.data, s.dts, s.dur);
        audioLabel = `${enc.label}, re-encoded`;
      }
    }
  } else if (container === 'webm' && at) {
    onProgress?.({ frac: 0, text: 'Encoding sound…' });
    if (await encodeAudioTrack(file, vt.duration, writer)) audioLabel = 'Opus, re-encoded';
  }
  aborted(signal);

  const proc = new FrameProcessor(eng, gpu, user, locked, vt.codedWidth, vt.codedHeight, ow, oh);
  const E = makeEncoder((chunk, meta) => (container === 'mp4' ? writer.addVideo(chunk, meta) : writer.addVideo(chunk)));
  E.enc.configure(encCfg);

  const frames = [];
  let decErr = null, wake = null, decodeDone = false;
  const dec = new VideoDecoder({
    output: (f) => { frames.push(f); wake?.(); },
    error: (e) => { decErr = e; wake?.(); },
  });
  dec.configure(decCfg);
  const reader = new SampleReader(file, vt);
  let next = 0;
  const mt = vt.mediaTime;
  const feed = async () => {
    while (next < S.count && dec.decodeQueueSize + frames.length < 6) {
      const data = await reader.read(next);
      const cts = S.dts[next] + S.cto[next] - mt;
      dec.decode(new EncodedVideoChunk({
        type: !S.key || S.key[next] ? 'key' : 'delta',
        timestamp: Math.round((cts * 1e6) / ts),
        duration: Math.round((S.dur[next] * 1e6) / ts),
        data,
      }));
      next++;
    }
    if (next >= S.count && !feed.flushing) {
      feed.flushing = true;
      dec.flush().then(() => { decodeDone = true; wake?.(); }, (e) => { decErr = decErr || e; wake?.(); });
    }
  };
  const total = S.count;
  const keyEvery = Math.max(1, Math.round(fps * 2));
  const t0 = performance.now();
  let n = 0, decodeWait = 0;
  const frameDur = Math.round(1e6 / (fps || 30));
  try {
    while (!(decodeDone && frames.length === 0)) {
      aborted(signal);
      await feed();
      if (decErr) throw decErr;
      if (!frames.length) {
        const tw0 = performance.now();
        await new Promise((r) => { wake = r; setTimeout(r, 25); });
        wake = null;
        decodeWait += performance.now() - tw0;
        continue;
      }
      const f = frames.shift();
      if (f.timestamp < 0) { f.close(); continue; }
      let out;
      try { out = proc.frame(f, f.timestamp / 1e6, f.timestamp, f.duration ?? frameDur); } finally { f.close(); }
      await E.push(out, n % keyEvery === 0);
      n++;
      if (n % 4 === 0 || n === total) {
        const el = (performance.now() - t0) / 1000;
        onProgress?.({ frac: Math.min(1, n / total), fps: n / el, eta: ((total - n) * el) / n, text: `Frame ${n} of ${total}` });
      }
    }
    await E.done();
  } catch (e) {
    for (const f of frames) f.close();
    try { dec.close(); } catch { /* closed */ }
    try { E.enc.close(); } catch { /* closed */ }
    throw e;
  }
  try { dec.close(); } catch { /* closed */ }
  onProgress?.({ frac: 1, text: 'Writing file…' });
  const blob = container === 'mp4' ? writer.finalize() : writer.finalize((n * 1000) / (fps || 30));
  const seconds = (performance.now() - t0) / 1000;
  return {
    blob, ext: container,
    info: {
      path: 'fast', render: proc.mode, codec: codecLabel, container, audio: audioLabel, frames: n, seconds, fps: n / seconds, width: ow, height: oh,
      msPerFrame: msPer({ ...proc.t, decodeWait, encodeWait: E.waitMs }, n),
    },
  };
}

// ---------------------------------------------------- compatibility path ----

function seekTo(v, t) {
  return new Promise((res) => {
    let gotFrame = !('requestVideoFrameCallback' in v), gotSeek = false, h = 0;
    const check = () => { if (gotFrame && gotSeek) res(); };
    if (!gotFrame) h = v.requestVideoFrameCallback(() => { gotFrame = true; check(); });
    v.addEventListener('seeked', () => {
      gotSeek = true; check();
      setTimeout(() => { if (!gotFrame) { v.cancelVideoFrameCallback(h); gotFrame = true; check(); } }, 150);
    }, { once: true });
    v.currentTime = t;
  });
}

async function exportCompat(job, fps) {
  const { file, eng, gpu, user, locked, opts, onProgress, signal } = job;
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.append(v);
  const url = URL.createObjectURL(file);
  try {
    v.src = url;
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('This browser cannot play this video file.')); });
    if (!Number.isFinite(v.duration)) { v.currentTime = 1e9; await new Promise((r) => { v.ondurationchange = r; }); }
    const W = v.videoWidth, H = v.videoHeight, dur = v.duration;
    if (!W || !H) throw new Error(job.codecHint ? `This browser cannot decode ${job.codecHint} video.` : 'This browser cannot decode the video in this file.');
    fps = fps || 30;
    const [ow, oh] = outputSize(W, H, opts.maxShort);
    const mp4enc = opts.format !== 'webm' ? await pickMp4Encoder(ow, oh, fps, (file.size * 8) / dur) : null;
    let writer, container, codecLabel, encCfg, audioLabel = 'none';
    if (mp4enc) {
      container = 'mp4'; encCfg = mp4enc.config; codecLabel = mp4enc.family === 'hevc' ? 'HEVC' : 'H.264';
      writer = new Mp4Writer({ family: mp4enc.family, width: ow, height: oh, timescale: 90000 });
      onProgress?.({ frac: 0, text: 'Encoding sound…' });
      const a = await encodeAudioMp4(file, dur);
      if (a) { writer.a = a.track; for (const s of a.samples) writer.addAudio(s.data, s.dts, s.dur); audioLabel = `${a.label}, re-encoded`; }
    } else {
      const pick = await pickVideoCodec(ow, oh, fps);
      if (!pick) throw new Error('This browser cannot encode video.');
      container = 'webm'; encCfg = pick.config; codecLabel = pick.matroska === 'V_VP9' ? 'VP9' : 'VP8';
      writer = new WebMWriter({ width: ow, height: oh, codec: pick.matroska });
      onProgress?.({ frac: 0, text: 'Encoding sound…' });
      if (await encodeAudioTrack(file, dur, writer)) audioLabel = 'Opus, re-encoded';
    }
    const proc = new FrameProcessor(eng, gpu, user, locked, W, H, ow, oh);
    const E = makeEncoder((chunk, meta) => (container === 'mp4' ? writer.addVideo(chunk, meta) : writer.addVideo(chunk)));
    E.enc.configure(encCfg);
    const total = Math.max(1, Math.floor(dur * fps + 1e-6));
    const keyEvery = Math.max(1, Math.round(fps * 2));
    const t0 = performance.now();
    let seekMs = 0;
    for (let i = 0; i < total; i++) {
      aborted(signal);
      const ts0 = performance.now();
      await seekTo(v, Math.min(dur - 1e-3, (i + 0.5) / fps));
      seekMs += performance.now() - ts0;
      const out = proc.frame(v, i / fps, Math.round((i * 1e6) / fps), Math.round(1e6 / fps));
      await E.push(out, i % keyEvery === 0);
      if (i % 3 === 0 || i === total - 1) {
        const el = (performance.now() - t0) / 1000;
        onProgress?.({ frac: (i + 1) / total, fps: (i + 1) / el, eta: (el / (i + 1)) * (total - i - 1), text: `Frame ${i + 1} of ${total}` });
      }
    }
    await E.done();
    const blob = container === 'mp4' ? writer.finalize() : writer.finalize((total * 1000) / fps);
    const seconds = (performance.now() - t0) / 1000;
    return {
      blob, ext: container,
      info: {
        path: 'compat', render: proc.mode, codec: codecLabel, container, audio: audioLabel, frames: total, seconds, fps: total / seconds, width: ow, height: oh,
        msPerFrame: msPer({ seek: seekMs, ...proc.t, encodeWait: E.waitMs }, total),
      },
    };
  } finally {
    v.removeAttribute('src'); v.load(); v.remove();
    URL.revokeObjectURL(url);
  }
}

/**
 * Restore a whole video.
 * job = {file, eng, gpu, user, locked, opts:{maxShort, format:'mp4'|'webm', fps}, onProgress, signal}
 * Resolves {blob, ext, info}.
 */
export async function exportVideo(job) {
  try {
    if (job.opts.forceCompat) throw new Fallback('compatibility path requested');
    return await exportFast(job);
  } catch (e) {
    if (!(e instanceof Fallback)) throw e;
    console.info('[reefhue] compatibility path:', e.message);
    if (/hvc1|hev1/.test(e.message)) job.codecHint = 'HEVC (H.265)';
    else if (/av01/.test(e.message)) job.codecHint = 'AV1';
    const r = await exportCompat(job, job.opts.fps);
    r.info.reason = e.message;
    return r;
  }
}

/**
 * Restore a photo at full resolution (stepping down only if the device runs
 * out of memory). Processes the image in strips so a 50 MP photo needs one
 * full-size canvas plus a small strip buffer. Resolves {blob, ext, info}.
 */
export async function exportImage({ file, info, eng, user, locked, format = 'jpeg' }) {
  const meta = info || (await loadPhotoFile(file)).info;
  const { bitmap, scaled } = await decodeForExport(file, meta);
  const w = bitmap.width, h = bitmap.height;
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0);
  const [tw, th] = thumbSize(w, h);
  const tc = new OffscreenCanvas(tw, th);
  const tg = tc.getContext('2d', { willReadFrequently: true });
  tg.drawImage(bitmap, 0, 0, tw, th);
  const thumb = tg.getImageData(0, 0, tw, th).data;
  const a = locked || { data: thumb, w: tw, h: th };
  const auto = eng.analyze(a.data, a.w, a.h, user.red / 100, user.balance / 100);
  const settings = buildSettings(auto, user);
  // every CPU core when workers are available, otherwise this thread
  const pool = await getPool();
  // backscatter removal needs the corrected image's brightness at half resolution
  const bs = specksOn(user);
  const w2 = (w + 1) >> 1, h2 = (h + 1) >> 1;
  const l2 = bs ? new Uint8Array(w2 * h2) : null;
  const keepLuma = (l, y) => { if (l) l2.set(l, (y >> 1) * w2); };
  let cores = 0;
  if (pool) {
    try {
      const band = Math.max(16, Math.floor((1 << 20) / (w * 4))); // ~1 MB bands spread well over cores
      await pool.run({ settings, thumb, tw, th, w, h, band, luma: bs ? 'half' : null, read: (y, rows) => g.getImageData(0, y, w, rows), write: (img, y, l) => { g.putImageData(img, 0, y); keepLuma(l, y); } });
      cores = pool.size;
    } catch (e) {
      console.warn('[reefhue] parallel processing failed, using one core', e);
      g.drawImage(bitmap, 0, 0); // start again from the original pixels
    }
  }
  if (!cores) {
    eng.begin(settings, thumb, tw, th);
    let strip = Math.max(16, Math.floor((4 << 20) / (w * 4))); // ~4 MB per strip
    strip += strip & 1; // even, so half-resolution rows line up
    for (let y = 0; y < h; y += strip) {
      const rows = Math.min(strip, h - y);
      const img = g.getImageData(0, y, w, rows);
      eng.rows(img.data, w, rows, y, h);
      g.putImageData(img, 0, y);
      if (bs) keepLuma(eng.lumaHalf(img.data, w, rows), y);
    }
    cores = 1;
  }
  let specks = null;
  if (bs) {
    const maxdim = Math.max(w, h);
    const det = await detectSpecks({ eng, pool: cores > 1 ? pool : null, l2, w2, h2, maxdim, user });
    await fillSpecks({ eng, pool: cores > 1 ? pool : null, g, w, h, det, maxdim });
    specks = det.count;
  }
  bitmap.close?.();
  const blob = await c.convertToBlob({ type: `image/${format}`, quality: 0.95 });
  return { blob, ext: format === 'jpeg' ? 'jpg' : format, info: { width: w, height: h, scaled, cores, specks } };
}
