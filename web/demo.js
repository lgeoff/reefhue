// Procedural demo material: a reef scene with a diver's colour slate, drawn in
// true colour and then "photographed underwater" with a per-channel
// attenuation + backscatter model. Lets the app open in a working state and
// gives a known-good reference (the slate's whites should come back neutral).
import { WebMWriter, pickVideoCodec } from './webm.js';
import { Mp4Writer } from './mp4.js';
import { pickMp4Encoder } from './pipeline.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// Classic colour-checker patch colours (sRGB) + a grey ramp.
const PATCHES = ['#735244', '#c29682', '#627a9d', '#576c43', '#8580b1', '#67bdaa',
  '#d67e2c', '#505ba6', '#c15a63', '#5e3c6c', '#9dbc40', '#e0a32e'];
const GREYS = ['#f3f3f2', '#c8c8c8', '#a0a0a0', '#7a7a79', '#555555', '#343434'];

/** Draw the scene; returns the true-colour canvas and a distance map in metres. */
function drawReef(W, H, seed, slateX) {
  const R = rng(seed);
  const tc = new OffscreenCanvas(W, H);
  const dc = new OffscreenCanvas(W, H);
  const t = tc.getContext('2d');
  const d = dc.getContext('2d');
  const dist = (m) => { const v = Math.round(Math.min(20, m) / 20 * 255); return `rgb(${v},${v},${v})`; };
  const both = (path, colour, metres) => {
    t.fillStyle = colour; d.fillStyle = dist(metres);
    path(t); t.fill(); path(d); d.fill();
  };

  // open water far away
  t.fillStyle = '#24323a'; t.fillRect(0, 0, W, H);
  d.fillStyle = dist(20); d.fillRect(0, 0, W, H);

  // distant reef ridge
  for (let i = 0; i < 9; i++) {
    const x = R() * W, w = W * (0.12 + R() * 0.2), h = H * (0.12 + R() * 0.12);
    both((c) => { c.beginPath(); c.ellipse(x, H * 0.62, w, h, 0, Math.PI, 0); }, ['#5d4b55', '#4f5240', '#6b5546'][i % 3], 10 + R() * 3);
  }

  // sand floor with a distance gradient (far at horizon, near at the bottom)
  const floor = (c) => {
    c.beginPath(); c.moveTo(0, H * 0.66);
    for (let x = 0; x <= W; x += W / 8) c.quadraticCurveTo(x + W / 16, H * (0.62 + R() * 0.06), x + W / 8, H * 0.66);
    c.lineTo(W, H); c.lineTo(0, H); c.closePath();
  };
  t.fillStyle = '#cdb68c'; floor(t); t.fill();
  const g = d.createLinearGradient(0, H * 0.62, 0, H);
  g.addColorStop(0, dist(9)); g.addColorStop(1, dist(1.2));
  d.fillStyle = g; floor(d); d.fill();
  for (let i = 0; i < 900; i++) { // sand texture
    t.fillStyle = R() < 0.5 ? 'rgba(120,96,60,0.25)' : 'rgba(255,245,220,0.25)';
    t.fillRect(R() * W, H * (0.66 + R() * 0.34), 2 + R() * 3, 1 + R() * 2);
  }

  // rocks
  for (let i = 0; i < 6; i++) {
    const x = R() * W, y = H * (0.66 + R() * 0.12), r = H * (0.06 + R() * 0.06);
    both((c) => { c.beginPath(); c.ellipse(x, y, r * 1.6, r, 0, 0, Math.PI * 2); }, '#6b5a4a', 3.5 + R() * 2);
  }

  // brain coral domes
  for (let i = 0; i < 4; i++) {
    const x = W * (0.1 + R() * 0.8), y = H * 0.74, r = H * (0.07 + R() * 0.05), m = 3 + R();
    both((c) => { c.beginPath(); c.ellipse(x, y, r * 1.4, r, 0, Math.PI, 0); c.closePath(); }, '#c98a4a', m);
    t.strokeStyle = 'rgba(90,50,20,0.55)'; t.lineWidth = 2;
    for (let k = 0; k < 7; k++) {
      t.beginPath(); t.ellipse(x, y, r * 1.4 * (1 - k / 8), r * (1 - k / 8), 0, Math.PI, 0); t.stroke();
    }
  }

  // branching corals
  const colours = ['#e2583e', '#d94f8a', '#8c5bbf', '#f2a33a', '#e8e0d0'];
  function branch(x, y, ang, len, w, depth, colour, m) {
    if (depth === 0 || len < 4) return;
    const x2 = x + Math.cos(ang) * len, y2 = y + Math.sin(ang) * len;
    for (const [c, s] of [[t, colour], [d, dist(m)]]) {
      c.strokeStyle = s; c.lineCap = 'round'; c.lineWidth = w;
      c.beginPath(); c.moveTo(x, y); c.lineTo(x2, y2); c.stroke();
    }
    const n = 2 + (R() < 0.4 ? 1 : 0);
    for (let i = 0; i < n; i++) branch(x2, y2, ang + (R() - 0.5) * 1.1, len * (0.68 + R() * 0.15), w * 0.72, depth - 1, colour, m);
  }
  for (let i = 0; i < 11; i++) {
    const x = W * (0.03 + R() * 0.94), y = H * (0.72 + R() * 0.1);
    branch(x, y, -Math.PI / 2 + (R() - 0.5) * 0.4, H * (0.08 + R() * 0.06), H * 0.018, 6, colours[i % colours.length], 2.6 + R() * 1.6);
  }

  // sea fan
  for (let k = 0; k < 40; k++) {
    const a = -Math.PI * (0.15 + 0.7 * k / 40), x0 = W * 0.18, y0 = H * 0.8, L = H * (0.25 + R() * 0.06);
    for (const [c, s] of [[t, '#9b3a7a'], [d, dist(3)]]) {
      c.strokeStyle = s; c.lineWidth = 2.2; c.beginPath(); c.moveTo(x0, y0);
      c.quadraticCurveTo(x0 + Math.cos(a) * L * 0.5 + 8, y0 + Math.sin(a) * L * 0.5, x0 + Math.cos(a) * L, y0 + Math.sin(a) * L); c.stroke();
    }
  }

  // fish
  const fish = (x, y, s, body, stripe, m) => {
    both((c) => { c.beginPath(); c.ellipse(x, y, s, s * 0.5, 0, 0, Math.PI * 2); }, body, m);
    both((c) => { c.beginPath(); c.moveTo(x - s * 0.9, y); c.lineTo(x - s * 1.5, y - s * 0.45); c.lineTo(x - s * 1.5, y + s * 0.45); c.closePath(); }, body, m);
    if (stripe) {
      t.fillStyle = stripe;
      for (const o of [-0.35, 0.25]) { t.beginPath(); t.ellipse(x + s * o, y, s * 0.1, s * 0.45, 0, 0, Math.PI * 2); t.fill(); }
    }
    t.fillStyle = '#111'; t.beginPath(); t.arc(x + s * 0.6, y - s * 0.1, s * 0.08, 0, Math.PI * 2); t.fill();
  };
  fish(W * 0.42, H * 0.46, H * 0.045, '#f26a1b', '#ffffff', 2.4);
  fish(W * 0.47, H * 0.40, H * 0.03, '#f26a1b', '#ffffff', 2.6);
  fish(W * 0.66, H * 0.33, H * 0.05, '#f4cf2f', null, 3.2);
  fish(W * 0.30, H * 0.30, H * 0.035, '#3a5fd0', '#f4cf2f', 4);

  // diver's colour slate, close to the camera
  const sw = H * 0.42, sh = H * 0.3, sx = slateX ?? W * 0.66, sy = H * 0.6;
  for (const [c, s] of [[t, '#f2f2ee'], [d, dist(1.1)]]) {
    c.save(); c.translate(sx, sy); c.rotate(-0.06); c.fillStyle = s;
    c.beginPath(); c.roundRect(0, 0, sw, sh, sw * 0.04); c.fill(); c.restore();
  }
  t.save(); t.translate(sx, sy); t.rotate(-0.06);
  const pw = sw * 0.14, gap = sw * 0.02, ox = sw * 0.06, oy = sh * 0.1;
  PATCHES.forEach((col, i) => { t.fillStyle = col; t.fillRect(ox + (i % 6) * (pw + gap), oy + Math.floor(i / 6) * (pw + gap), pw, pw); });
  GREYS.forEach((col, i) => { t.fillStyle = col; t.strokeStyle = '#888'; t.fillRect(ox + i * (pw + gap), oy + 2 * (pw + gap), pw, pw * 0.7); t.strokeRect(ox + i * (pw + gap), oy + 2 * (pw + gap), pw, pw * 0.7); });
  t.fillStyle = '#222'; t.font = `600 ${Math.round(sh * 0.09)}px sans-serif`;
  t.fillText('WB SLATE · 12 m', ox, sh * 0.93);
  t.restore();

  const dd = d.getImageData(0, 0, W, H).data;
  const metres = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) metres[i] = (dd[i * 4] / 255) * 20;
  return { truth: t.getImageData(0, 0, W, H), metres };
}

const toLin = new Float32Array(256).map((_, i) => {
  const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const toSrgb = (x) => {
  x = Math.min(1, Math.max(0, x));
  return 255 * (x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055);
};

/** Simulate a camera at `depth` metres in blue ocean water. */
function underwater(img, metres, depth = 9, seed = 3) {
  const R = rng(seed);
  const beta = [0.38, 0.07, 0.045];
  const veil = [0.012, 0.13, 0.30];
  const n = metres.length, s = img.data;
  const lin = new Float32Array(n * 3);
  const lums = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const z = metres[i];
    for (let c = 0; c < 3; c++) {
      const T = Math.exp(-beta[c] * (depth + z));
      lin[i * 3 + c] = toLin[s[i * 4 + c]] * T + veil[c] * (1 - Math.exp(-0.2 * z));
    }
    lums[i] = 0.2126 * lin[i * 3] + 0.7152 * lin[i * 3 + 1] + 0.0722 * lin[i * 3 + 2];
  }
  const sorted = lums.slice().sort();
  const k = 0.82 / Math.max(1e-4, sorted[Math.floor(n * 0.995)]);
  const out = new ImageData(img.width, img.height);
  for (let i = 0; i < n; i++) {
    const noise = (R() - 0.5) * 0.006;
    for (let c = 0; c < 3; c++) out.data[i * 4 + c] = toSrgb(lin[i * 3 + c] * k + noise);
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

/** A 1600×1067 demo photo as a Blob (JPEG). */
export async function demoPhoto() {
  const W = 1600, H = 1067;
  const { truth, metres } = drawReef(W, H, 11);
  const c = new OffscreenCanvas(W, H);
  c.getContext('2d').putImageData(underwater(truth, metres), 0, 0);
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
}

/**
 * A panning demo clip encoded in the browser: MP4 (H.264) when the browser
 * can encode it, otherwise WebM. Resolves {blob, name, type}.
 */
export async function demoClip(onProgress, { width = 1280, height = 720, seconds = 4, gop = 30 } = {}) {
  const fw = width, fh = height, fps = 30;
  const H = Math.max(1080, fh), W = Math.round(H * 2.37);
  const { truth, metres } = drawReef(W, H, 5, W * 0.59);
  const scene = new OffscreenCanvas(W, H);
  scene.getContext('2d').putImageData(underwater(truth, metres, 10), 0, 0);
  const mp4 = await pickMp4Encoder(fw, fh, fps, fw * fh * fps * 0.1);
  let writer, config, ext;
  if (mp4) {
    writer = new Mp4Writer({ family: mp4.family, width: fw, height: fh });
    config = mp4.config;
    ext = 'mp4';
  } else {
    const pick = await pickVideoCodec(fw, fh, fps);
    if (!pick) throw new Error('This browser cannot encode video (WebCodecs VideoEncoder missing).');
    writer = new WebMWriter({ width: fw, height: fh, codec: pick.matroska });
    config = pick.config;
    ext = 'webm';
  }
  const enc = new VideoEncoder({ output: (ch, meta) => writer.addVideo(ch, meta), error: (e) => { throw e; } });
  enc.configure(config);
  const frame = new OffscreenCanvas(fw, fh);
  const fc = frame.getContext('2d');
  const R = rng(2);
  const bubbles = Array.from({ length: 40 }, () => ({ x: R() * fw, y: fh + R() * fh, r: 2 + R() * 7, v: 1.5 + R() * 3 }));
  const total = fps * seconds;
  const cropW = H * fw / fh;
  for (let i = 0; i < total; i++) {
    const sx = (W - cropW) * (i / (total - 1));
    fc.drawImage(scene, sx, 0, cropW, H, 0, 0, fw, fh);
    fc.strokeStyle = 'rgba(200,235,255,0.55)'; fc.lineWidth = 1.5;
    for (const b of bubbles) {
      b.y -= b.v; b.x += Math.sin((i + b.r * 10) / 9) * 0.6;
      if (b.y < -10) b.y = fh + 10;
      fc.beginPath(); fc.arc(b.x, b.y, b.r, 0, Math.PI * 2); fc.stroke();
    }
    const vf = new VideoFrame(frame, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
    enc.encode(vf, { keyFrame: i % gop === 0 });
    vf.close();
    if (enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 5));
    onProgress?.(i / total);
  }
  await enc.flush();
  enc.close();
  const blob = ext === 'mp4' ? writer.finalize() : writer.finalize(seconds * 1000);
  return { blob, name: `demo-reef-clip.${ext}`, type: ext === 'mp4' ? 'video/mp4' : 'video/webm' };
}
