// Reefhue UI: drag-and-drop, live preview, quality readout, batch queue, export.
// All analysis runs in engine.wasm (Rust) on the user's machine; exports
// evaluate the per-pixel formula on the GPU when available (gpu.js).
import { Engine, buildSettings, smoothAuto, PRESETS, DEFAULTS, S } from './engine.js';
import { GpuRenderer } from './gpu.js';
import { exportVideo, exportImage, thumbSize } from './pipeline.js';
import { openMp4 } from './mp4.js';
import { makeZip } from './zip.js';
import { loadPhotoFile, decodePhoto, describe } from './image.js';
import { demoPhoto, demoClip } from './demo.js';

const $ = (id) => document.getElementById(id);
const PREVIEW_MAX = 1600; // long edge of the live preview buffer

const SLIDERS = [
  { group: 'Restore', items: [
    { key: 'strength', label: 'Strength', min: 0, max: 100, fmt: (v) => `${v}%` },
    { key: 'red', label: 'Red recovery', min: 0, max: 200, fmt: (v) => `${v}%`, tip: 'Rebuilds the red channel from green (Ancuti α)' },
    { key: 'balance', label: 'Colour balance', min: 0, max: 150, fmt: (v) => `${v}%`, tip: 'Share of the measured white balance applied' },
    { key: 'dehaze', label: 'Dehaze', min: 0, max: 200, fmt: (v) => `${v}%`, tip: 'Removes the blue-green veil of backscatter' },
  ] },
  { group: 'Light', items: [
    { key: 'exposure', label: 'Exposure', min: -2, max: 2, step: 0.05, fmt: (v) => `${v > 0 ? '+' : ''}${(+v).toFixed(2)} EV` },
    { key: 'contrast', label: 'Contrast', min: -100, max: 100 },
    { key: 'shadows', label: 'Shadows', min: -100, max: 100 },
    { key: 'highlights', label: 'Highlights', min: -100, max: 100 },
  ] },
  { group: 'Colour', items: [
    { key: 'temp', label: 'Warmth', min: -100, max: 100 },
    { key: 'tint', label: 'Tint', min: -100, max: 100, tip: 'Positive adds magenta, negative adds green' },
    { key: 'saturation', label: 'Saturation', min: -100, max: 100 },
    { key: 'vibrance', label: 'Vibrance', min: -100, max: 100 },
  ] },
  { group: 'Water', items: [
    { key: 'water', label: 'Water saturation', min: -100, max: 100, tip: 'Saturation of blue and cyan water only' },
    { key: 'waterHue', label: 'Water hue', min: -100, max: 100, tip: 'Positive turns water turquoise, negative deep blue' },
    { key: 'waterLum', label: 'Water brightness', min: -100, max: 100, tip: 'Lighten or darken the water without touching the subject' },
  ] },
  { group: 'Detail', items: [
    { key: 'clarity', label: 'Clarity', min: 0, max: 100, tip: 'Large-radius local contrast' },
  ] },
];
const signed = (v) => (v > 0 ? `+${v}` : `${v}`);
const KEYS = Object.keys(DEFAULTS);

const st = {
  eng: null, gpu: null,
  items: [], cur: null, nextId: 1,
  kind: null, bitmap: null,
  srcW: 0, srcH: 0, pw: 0, ph: 0, tw: 1, th: 1, src: null, out: null, thumb: null,
  auto: null, smooth: null, lastT: null, fps: 30,
  view: 'split', split: 0.5, holdBefore: false,
  beforeM: null, afterM: null,
  batch: null, // {abort: AbortController} while processing
  busy: false,
};

const v = $('video');
const work = document.createElement('canvas');
const workCtx = work.getContext('2d', { willReadFrequently: true });
const thumbC = document.createElement('canvas');
const thumbCtx = thumbC.getContext('2d', { willReadFrequently: true });
const beforeCtx = $('beforeCanvas').getContext('2d');
const afterCtx = $('afterCanvas').getContext('2d');
const downloadsCap = window.claude?.use ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null);

// ------------------------------------------------------------------ util
function toast(msg, ms = 4200) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, ms);
}
function busy(text, frac) {
  $('busy').hidden = text == null;
  if (text != null) {
    $('busyText').textContent = text;
    $('busyBar').style.width = `${Math.round((frac ?? 0) * 100)}%`;
  }
}
const once = (el, ev) => new Promise((res) => el.addEventListener(ev, res, { once: true }));
const fmtTime = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const fmtDur = (t) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;
const fmtMB = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(b >= 1e7 ? 0 : 1)} MB`);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const presetValues = (k) => Object.fromEntries(KEYS.map((key) => [key, PRESETS[k][key] ?? DEFAULTS[key]]));
const isVideoFile = (f) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name);
const isImageFile = (f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|avif|gif|bmp|heic|heif)$/i.test(f.name) || (!f.type && !isVideoFile(f));
const baseName = (n) => n.replace(/\.[^.]+$/, '') || 'reefhue';

// ----------------------------------------------------------- item model
function isCustom(item) {
  if (item.preset !== 'auto' || item.locked) return true;
  const a = presetValues('auto');
  return KEYS.some((k) => item.user[k] !== a[k]);
}
function chipLabel(item) {
  if (!isCustom(item)) return 'Auto';
  return item.preset !== 'auto' ? `${PRESETS[item.preset].label}${KEYS.some((k) => item.user[k] !== presetValues(item.preset)[k]) ? ' · edited' : ''}` : 'Custom';
}
function outputOpts(sel = $('qOutput').value) {
  const [format, short] = sel.split(':');
  return { format, maxShort: +short || null };
}
const signature = (item, opts) => JSON.stringify({ p: item.preset, u: item.user, l: !!item.locked, o: item.kind === 'video' ? opts : null });

/** Call after any settings change on an item. */
function itemEdited(item) {
  if (item.status === 'done' && item.result && item.result.sig !== signature(item, item.result.opts)) {
    item.status = 'stale';
    item.stateText = 'Settings changed, process again';
  } else if (item.status === 'stale' && item.result && item.result.sig === signature(item, item.result.opts)) {
    item.status = 'done';
    item.stateText = doneText(item.result);
  }
  updateItemEl(item);
  syncThisFile();
  syncBatchButtons();
}

function doneText(r) {
  const parts = [fmtMB(r.blob.size)];
  if (r.info?.fps) parts.push(`${r.info.fps.toFixed(0)} fps`);
  return `Done · ${parts.join(' · ')}`;
}

// ---------------------------------------------------------------- sliders
function buildUI() {
  const host = $('sliders');
  for (const g of SLIDERS) {
    const sec = document.createElement('section');
    sec.className = 'group';
    sec.innerHTML = `<h2>${g.group}</h2>`;
    for (const s of g.items) {
      const row = document.createElement('div');
      row.className = 'slider';
      row.innerHTML = `<label for="s-${s.key}">${s.label}</label><output id="o-${s.key}" for="s-${s.key}"></output>
        <input type="range" id="s-${s.key}" min="${s.min}" max="${s.max}" step="${s.step ?? 1}">
        ${s.tip ? `<span class="tip">${s.tip}</span>` : ''}`;
      const input = row.querySelector('input');
      const changed = () => {
        if (!st.cur) return;
        syncSliders();
        if (s.key === 'red' || s.key === 'balance') reanalyze();
        requestRender();
        itemEdited(st.cur);
      };
      input.addEventListener('input', () => { if (st.cur) { st.cur.user[s.key] = +input.value; changed(); } });
      input.addEventListener('dblclick', () => { if (st.cur) { st.cur.user[s.key] = presetValues(st.cur.preset)[s.key]; changed(); } });
      sec.append(row);
    }
    host.append(sec);
  }
  for (const [k, p] of Object.entries(PRESETS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'preset';
    b.dataset.key = k;
    b.innerHTML = `<b>${p.label}</b><small>${p.note}</small>`;
    b.addEventListener('click', () => applyPreset(k));
    $(p.look ? 'looks' : 'presets').append(b);
  }
  syncSliders();
}

function applyPreset(k) {
  if (!st.cur) return;
  st.cur.preset = k;
  st.cur.user = presetValues(k);
  syncSliders();
  reanalyze();
  requestRender();
  itemEdited(st.cur);
}

function syncSliders() {
  const item = st.cur;
  const user = item ? item.user : DEFAULTS;
  const base = presetValues(item ? item.preset : 'auto');
  for (const g of SLIDERS) for (const s of g.items) {
    const val = user[s.key];
    $(`s-${s.key}`).value = val;
    const o = $(`o-${s.key}`);
    o.textContent = s.fmt ? s.fmt(val) : signed(val);
    o.classList.toggle('changed', val !== base[s.key]);
  }
  const edited = KEYS.some((k) => user[k] !== base[k]);
  for (const b of document.querySelectorAll('.preset')) {
    const on = item && b.dataset.key === item.preset;
    b.setAttribute('aria-pressed', !!on);
    b.classList.toggle('modified', !!on && edited);
  }
}

function syncThisFile() {
  const show = st.items.length > 1 && !!st.cur;
  $('thisFile').hidden = !show;
  if (!show) return;
  const chip = $('tfChip');
  chip.textContent = chipLabel(st.cur);
  chip.classList.toggle('custom', isCustom(st.cur));
  $('tfAuto').disabled = !isCustom(st.cur);
}

// ---------------------------------------------------------------- layout
function fitStage() {
  if (!st.srcW) return { w: 0, h: 0 };
  const wrapEl = $('stageWrap');
  const narrow = window.innerWidth <= 900;
  const pad = narrow ? 12 : 24;
  if (narrow) {
    // pinned on top while scrolling the settings, so keep it to ~40% of the screen
    const w = wrapEl.clientWidth - pad;
    wrapEl.style.height = `${Math.round(Math.min(window.innerHeight * 0.4, (w * st.srcH) / st.srcW) + pad)}px`;
  } else wrapEl.style.height = '';
  const wrap = wrapEl.getBoundingClientRect();
  const sc = Math.min((wrap.width - pad) / st.srcW, (wrap.height - pad) / st.srcH);
  const stage = $('stage');
  stage.style.width = `${Math.max(1, Math.floor(st.srcW * sc))}px`;
  stage.style.height = `${Math.max(1, Math.floor(st.srcH * sc))}px`;
  return { w: st.srcW * sc, h: st.srcH * sc };
}

function layoutPreview() {
  const disp = fitStage();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const want = Math.min(PREVIEW_MAX, Math.max(480, Math.max(disp.w, disp.h) * dpr));
  const sc = Math.min(1, want / Math.max(st.srcW, st.srcH));
  st.pw = Math.max(1, Math.round(st.srcW * sc));
  st.ph = Math.max(1, Math.round(st.srcH * sc));
  for (const c of [work, $('beforeCanvas'), $('afterCanvas')]) { c.width = st.pw; c.height = st.ph; }
  [st.tw, st.th] = thumbSize(st.srcW, st.srcH);
  thumbC.width = st.tw;
  thumbC.height = st.th;
  st.out = new ImageData(st.pw, st.ph);
}

function grab(source) {
  workCtx.drawImage(source, 0, 0, st.pw, st.ph);
  st.src = workCtx.getImageData(0, 0, st.pw, st.ph);
  beforeCtx.putImageData(st.src, 0, 0);
  thumbCtx.drawImage(source, 0, 0, st.tw, st.th);
  st.thumb = thumbCtx.getImageData(0, 0, st.tw, st.th).data;
}

// --------------------------------------------------------------- analysis
function analyzeNow(newFrame, t) {
  const item = st.cur;
  const a = item.locked || { data: st.thumb, w: st.tw, h: st.th };
  const raw = st.eng.analyze(a.data, a.w, a.h, item.user.red / 100, item.user.balance / 100);
  if (!newFrame) { st.smooth = raw; st.lastT = t; st.auto = raw; return; }
  st.auto = smoothAuto(raw, t, st);
}

function reanalyze(newFrame = false) {
  if (!st.thumb || !st.cur) return;
  analyzeNow(newFrame && st.kind === 'video' && !v.paused, st.kind === 'video' ? v.currentTime : 0);
  showAuto();
}

function showAuto() {
  const a = st.auto;
  if (!a) return;
  $('autoWater').textContent = a[S.GREEN_WATER] > 0.5 ? 'Green' : 'Blue';
  $('autoRed').textContent = `${Math.round((a[S.MEAN] / Math.max(1e-3, a[S.MEAN + 1])) * 100)} %`;
  const lift = a[S.GAIN] / Math.max(0.05, a[S.WHITE] - a[S.BLACK]);
  $('autoGain').textContent = `×${lift.toFixed(1)}`;
}

// ---------------------------------------------------------------- render
let queued = false;
function requestRender() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; render(); });
}

function render() {
  if (!st.src || !st.auto || !st.cur) return;
  st.eng.process(st.src.data, st.pw, st.ph, buildSettings(st.auto, st.cur.user), st.out.data, st.thumb, st.tw, st.th);
  afterCtx.putImageData(st.out, 0, 0);
  scheduleMetrics();
}

let metricsTimer = 0;
let lastMetrics = 0;
function scheduleMetrics() {
  clearTimeout(metricsTimer);
  const playing = st.kind === 'video' && !v.paused;
  const wait = playing ? Math.max(0, 250 - (performance.now() - lastMetrics)) : 120;
  metricsTimer = setTimeout(() => {
    if (!st.src) return;
    lastMetrics = performance.now();
    st.beforeM = st.eng.metrics(st.src.data, st.pw, st.ph, 60000);
    st.afterM = st.eng.metrics(st.out.data, st.pw, st.ph, 60000);
    drawReadout();
  }, wait);
}

// --------------------------------------------------------------- readout
const CSS = getComputedStyle(document.documentElement);
const tok = (n) => CSS.getPropertyValue(n).trim();

function castName(a, b) {
  const h = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  const names = ['red', 'orange', 'yellow', 'yellow-green', 'green', 'cyan', 'blue', 'magenta'];
  return names[Math.floor(((h + 22.5) % 360) / 45)];
}

function drawCast() {
  const c = $('castPlot');
  const g = c.getContext('2d');
  const W = c.width, cx = W / 2, R = W / 2 - 14, unit = R / 40;
  g.clearRect(0, 0, W, W);
  for (let i = 0; i < 72; i++) {
    const a0 = (i / 72) * Math.PI * 2, a1 = ((i + 1) / 72) * Math.PI * 2;
    g.strokeStyle = `hsl(${(380 - (i * 5)) % 360} 70% 55% / 0.85)`;
    g.lineWidth = 5;
    g.beginPath(); g.arc(cx, cx, R + 6, -a1, -a0); g.stroke();
  }
  g.strokeStyle = tok('--line'); g.lineWidth = 1;
  for (const r of [10, 20, 40]) { g.beginPath(); g.arc(cx, cx, r * unit, 0, Math.PI * 2); g.stroke(); }
  g.beginPath(); g.moveTo(cx - R, cx); g.lineTo(cx + R, cx); g.moveTo(cx, cx - R); g.lineTo(cx, cx + R); g.stroke();
  g.fillStyle = tok('--muted'); g.font = `500 13px ${tok('--font-display')}`;
  g.fillText('+b*', cx + 4, 26); g.fillText('−b*', cx + 4, W - 18); g.fillText('+a*', W - 40, cx - 5); g.fillText('−a*', 18, cx - 5);
  const pt = (m) => {
    const d = Math.hypot(m.a, m.b), k = d > 40 ? 40 / d : 1;
    return [cx + m.a * k * unit, cx - m.b * k * unit];
  };
  if (!st.beforeM) return;
  const [bx, by] = pt(st.beforeM), [ax, ay] = pt(st.afterM);
  g.strokeStyle = tok('--muted'); g.setLineDash([3, 3]);
  g.beginPath(); g.moveTo(bx, by); g.lineTo(ax, ay); g.stroke(); g.setLineDash([]);
  g.lineWidth = 2; g.strokeStyle = tok('--ink');
  g.beginPath(); g.arc(bx, by, 6, 0, Math.PI * 2); g.stroke();
  g.fillStyle = tok('--red'); g.strokeStyle = tok('--ground');
  g.beginPath(); g.arc(ax, ay, 7, 0, Math.PI * 2); g.fill(); g.stroke();
}

function drawHist() {
  const c = $('histPlot');
  const g = c.getContext('2d');
  const W = c.width, H = c.height, half = H / 2 - 4;
  g.clearRect(0, 0, W, H);
  const cols = ['rgb(255 84 70 / 0.8)', 'rgb(80 212 112 / 0.8)', 'rgb(72 132 255 / 0.85)'];
  const draw = (hist, top) => {
    let mx = 1;
    for (let ch = 0; ch < 3; ch++) for (let i = 2; i < 254; i++) mx = Math.max(mx, hist[ch * 256 + i]);
    g.globalCompositeOperation = 'lighter';
    for (let ch = 0; ch < 3; ch++) {
      g.fillStyle = cols[ch];
      g.beginPath(); g.moveTo(0, top + half);
      for (let i = 0; i < 256; i++) g.lineTo((i / 255) * W, top + half - Math.min(1, hist[ch * 256 + i] / mx) * (half - 2));
      g.lineTo(W, top + half); g.closePath(); g.fill();
    }
    g.globalCompositeOperation = 'source-over';
  };
  g.fillStyle = tok('--ground'); g.fillRect(0, 0, W, half); g.fillRect(0, half + 8, W, half);
  if (!st.beforeM) return;
  draw(st.beforeM.hist, 0);
  draw(st.afterM.hist, half + 8);
}

function drawReadout() {
  drawCast();
  drawHist();
  const b = st.beforeM, a = st.afterM;
  const rows = [
    ['Highlight cast', '<abbr title="Tint of the brightest 20 % of the frame (sand, skin, slate, foam) as distance from neutral grey on the CIE a*b* plane. Open water may stay blue. Lower is better.">ΔE</abbr>', b.cast, a.cast, -1, 1],
    ['Colourfulness', '<abbr title="Hasler–Süsstrunk colourfulness M. Higher means more colour variety.">M</abbr>', b.colorfulness, a.colorfulness, 1, 0],
    ['Contrast', '<abbr title="Standard deviation of lightness L*.">σL*</abbr>', b.stdL, a.stdL, 1, 1],
    ['Tonal range', '<abbr title="L* span between the 1st and 99th percentile.">L* 1–99%</abbr>', b.rangeL, a.rangeL, 1, 0],
    ['UCIQE', '<abbr title="Underwater colour image quality evaluation (Yang & Sowmya 2015): chroma spread, lightness contrast and saturation. Higher is better.">score</abbr>', b.uciqe, a.uciqe, 1, 2],
    ['Clipped', '<abbr title="Pixels at pure black or white in any channel.">pixels</abbr>', b.clipped * 100, a.clipped * 100, -1, 1, '%'],
  ];
  $('metricRows').innerHTML = rows.map(([name, unit, x, y, dir, dp, suf = '']) => {
    const better = (y - x) * dir > (dp === 2 ? 0.005 : 0.5);
    const worse = (y - x) * dir < -(dp === 2 ? 0.005 : 0.5);
    return `<tr><td>${name} <small>${unit}</small></td><td>${x.toFixed(dp)}${suf}</td><td class="${better ? 'up' : worse ? 'down' : ''}">${y.toFixed(dp)}${suf}</td></tr>`;
  }).join('');

  const pill = $('verdict').querySelector('.pill');
  const text = $('verdict').querySelector('.vtext');
  let cls = 'good', label = 'Neutral', note = 'Highlights are neutral.';
  if (a.cast >= 12) { cls = 'bad'; label = `Strong ${castName(a.a, a.b)} cast`; note = 'Raise Red recovery or Colour balance, or try a deeper preset.'; }
  else if (a.cast >= 5) { cls = 'warn'; label = `Slight ${castName(a.a, a.b)} cast`; note = 'Fine for water-heavy shots; trim with Warmth or Tint.'; }
  if (PRESETS[st.cur?.preset]?.look) note = 'Looks are styles: a tint can be intended.';
  if (a.clipped > 0.02) { cls = cls === 'good' ? 'warn' : cls; note = `${(a.clipped * 100).toFixed(1)} % of pixels clipped. Lower Exposure, Contrast or Dehaze.`; }
  pill.className = `pill ${cls}`;
  pill.textContent = label;
  const du = a.uciqe - b.uciqe;
  text.textContent = `${note} UCIQE ${du >= 0 ? '+' : ''}${du.toFixed(3)} vs original.`;
}

// ------------------------------------------------------------- view mode
function setView(mode) {
  st.view = mode;
  for (const [id, m] of [['viewSplit', 'split'], ['viewAfter', 'after'], ['viewBefore', 'before']]) {
    $(id).classList.toggle('on', m === mode);
    $(id).setAttribute('aria-pressed', m === mode);
  }
  applyView();
}
function applyView() {
  const mode = st.holdBefore ? 'before' : st.view;
  $('stage').className = `stage view-${mode}`;
  $('afterCanvas').style.clipPath = mode === 'split' ? `inset(0 0 0 ${st.split * 100}%)` : 'none';
  $('handle').style.left = `${st.split * 100}%`;
}

function bindStage() {
  const stage = $('stage');
  let drag = false;
  const move = (e) => {
    const r = stage.getBoundingClientRect();
    st.split = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    applyView();
  };
  stage.addEventListener('pointerdown', (e) => {
    if (st.view !== 'split') return;
    drag = true; stage.setPointerCapture(e.pointerId); move(e);
  });
  stage.addEventListener('pointermove', (e) => { if (drag) move(e); });
  stage.addEventListener('pointerup', () => { drag = false; });
  stage.addEventListener('pointercancel', () => { drag = false; });
  $('viewSplit').onclick = () => setView('split');
  $('viewAfter').onclick = () => setView('after');
  $('viewBefore').onclick = () => setView('before');
  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea') && e.target.type !== 'range') return;
    if (e.key === 'b' || e.key === 'B') { if (!st.holdBefore) { st.holdBefore = true; applyView(); } }
    if (st.kind === 'video' && e.target.type !== 'range') {
      if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      if (e.key === 'ArrowRight') stepFrame(1);
      if (e.key === 'ArrowLeft') stepFrame(-1);
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'b' || e.key === 'B') { st.holdBefore = false; applyView(); }
  });
}

// ------------------------------------------------------------- queue
function addFiles(list) {
  for (const f of list) console.info('picked', f.name, `${f.size} bytes`, `type "${f.type}"`);
  const files = [...list].filter((f) => isVideoFile(f) || isImageFile(f));
  const skipped = list.length - files.length;
  if (skipped) toast(`${skipped} file${skipped > 1 ? 's' : ''} skipped: not a photo or video.`);
  if (!files.length) return [];
  // the demo placeholder makes way for the user's own files
  if (st.items.length === 1 && st.items[0].demo && st.items[0].status === 'ready') st.items = [];
  const added = files.map((file) => ({
    id: st.nextId++, file, name: file.name, kind: isVideoFile(file) ? 'video' : 'image', size: file.size,
    w: 0, h: 0, duration: 0, fps: 0, thumbUrl: '',
    preset: 'auto', user: presetValues('auto'), locked: null,
    status: 'ready', progress: 0, stateText: 'Ready', result: null,
  }));
  for (const item of added) item.ready = item.kind === 'image' ? readPhoto(item) : Promise.resolve();
  st.items.push(...added);
  renderQueue();
  probeAll(added);
  // open the first new file, unless a batch is running and the user is looking at another one
  if (!st.cur || !st.items.includes(st.cur) || !st.batch) selectItem(added[0]);
  return added;
}

// Photos are read into memory once, one at a time: files picked through
// Android's file browser can fail when the same file is read twice at once.
let photoChain = Promise.resolve();
function readPhoto(item) {
  const original = item.file;
  photoChain = photoChain.then(async () => {
    try {
      const { file, info } = await loadPhotoFile(original);
      console.info('read', describe(info, item.name));
      item.file = file;
      item.info = info;
      item.size = info.size;
      if (info.w) { item.w = info.w; item.h = info.h; }
    } catch (e) {
      item.status = 'error';
      item.unplayable = true;
      item.stateText = e.message;
      item.errorDetails = e.details || '';
      throw e;
    }
  });
  return photoChain;
}

function photoError(item, e) {
  const details = [item.info ? describe(item.info, item.name) : item.name, e.details || item.errorDetails].filter(Boolean).join(' — ');
  console.error('[reefhue] photo', details, e);
  return { message: e.message || String(e), details };
}

async function probeAll(items) {
  for (const item of items) {
    try { await probe(item); } catch (e) { console.warn('probe', item.name, e); }
    updateItemEl(item);
  }
}

async function probe(item) {
  const c = document.createElement('canvas');
  c.width = 112; c.height = 84;
  const g = c.getContext('2d');
  const cover = (src, w, h) => {
    const k = Math.max(112 / w, 84 / h);
    g.drawImage(src, (112 - w * k) / 2, (84 - h * k) / 2, w * k, h * k);
  };
  if (item.kind === 'image') {
    try {
      await item.ready;
      const bmp = await decodePhoto(item.file, item.info, { maxEdge: 224 });
      if (!item.w) { item.w = bmp.width; item.h = bmp.height; }
      cover(bmp, bmp.width, bmp.height);
      bmp.close?.();
    } catch (e) {
      const pe = photoError(item, e);
      item.status = 'error';
      item.unplayable = true;
      item.stateText = pe.message;
      item.errorDetails = pe.details;
      return;
    }
  } else {
    let codec = null;
    try {
      const d = await openMp4(item.file);
      if (d.video) {
        item.fps = Math.round((d.video.samples.count / Math.max(d.video.duration, 1e-3)) * 100) / 100;
        codec = d.video.family;
      }
    } catch { /* not MP4: fps from playback later */ }
    const tv = document.createElement('video');
    tv.muted = true; tv.playsInline = true; tv.preload = 'auto';
    const url = URL.createObjectURL(item.file);
    tv.src = url;
    try {
      await Promise.race([once(tv, 'loadeddata'), once(tv, 'error').then(() => { throw new Error('cannot play'); })]);
      item.w = tv.videoWidth; item.h = tv.videoHeight; item.duration = tv.duration;
      if (!item.w) throw new Error('no video');
      tv.currentTime = Math.min(1, (tv.duration || 0) / 3);
      await Promise.race([once(tv, 'seeked'), new Promise((r) => setTimeout(r, 1500))]);
      cover(tv, tv.videoWidth, tv.videoHeight);
    } catch {
      item.status = 'error';
      item.stateText = codec === 'hevc' ? 'This browser cannot decode HEVC (H.265)'
        : codec === 'av1' ? 'This browser cannot decode AV1' : 'This browser cannot play this file';
      item.unplayable = true;
    } finally {
      tv.removeAttribute('src'); tv.load();
      URL.revokeObjectURL(url);
    }
  }
  item.thumbUrl = c.toDataURL('image/jpeg', 0.8);
}

function itemMeta(item) {
  const p = [];
  if (item.kind === 'video' && item.duration) p.push(fmtDur(item.duration));
  if (item.w) p.push(`${item.w}×${item.h}`);
  p.push(fmtMB(item.size));
  return p.join(' · ');
}

function itemHTML(item) {
  const custom = isCustom(item);
  return `<button type="button" class="q-main" data-act="select">
      <img class="q-thumb" alt="" src="${item.thumbUrl || 'data:image/gif;base64,R0lGODlhAQABAAAAACw='}">
      <span class="q-name" title="${esc(item.name)}">${esc(item.name)}</span>
      <span class="q-meta">${esc(itemMeta(item))}</span>
      <span class="q-line"><span class="q-chip${custom ? ' custom' : ''}">${esc(chipLabel(item))}</span><span class="q-state">${esc(item.stateText)}</span></span>
      <i class="q-bar" style="--p:${(item.progress * 100).toFixed(1)}%"></i>
    </button>
    <button type="button" class="q-x" data-act="remove" aria-label="Remove ${esc(item.name)}" title="Remove">×</button>
    ${item.result && item.status !== 'processing' ? `<button type="button" class="q-dl" data-act="download" aria-label="Download ${esc(item.name)}" title="Download">↓</button>` : ''}`;
}

function renderQueue() {
  const show = st.items.length > 1;
  $('queue').hidden = !show;
  $('app').classList.toggle('has-queue', show);
  const list = $('qList');
  list.innerHTML = '';
  for (const item of st.items) {
    const li = document.createElement('li');
    li.className = 'q-item';
    li.dataset.id = item.id;
    li.dataset.status = item.status;
    li.setAttribute('aria-current', item === st.cur ? 'true' : 'false');
    li.innerHTML = itemHTML(item);
    list.append(li);
  }
  syncBatchButtons();
  syncThisFile();
  if (show !== renderQueue.was) { renderQueue.was = show; if (st.srcW) setTimeout(relayout, 0); }
}

function updateItemEl(item) {
  const li = $('qList').querySelector(`[data-id="${item.id}"]`);
  if (!li) return;
  li.dataset.status = item.status;
  li.setAttribute('aria-current', item === st.cur ? 'true' : 'false');
  li.innerHTML = itemHTML(item);
}

function syncBatchButtons() {
  const vids = st.items;
  const done = vids.filter((i) => i.status === 'done').length;
  const todo = vids.filter((i) => i.status !== 'done' && i.status !== 'processing' && !i.unplayable).length;
  const total = vids.reduce((a, i) => a + i.size, 0);
  $('qCount').textContent = `${vids.length} files · ${fmtMB(total)}`;
  const pb = $('qProcess');
  if (st.batch) { pb.textContent = 'Stop'; pb.disabled = false; pb.classList.remove('primary'); }
  else {
    pb.textContent = todo ? `Process ${todo === vids.length ? 'all' : todo} ${todo === 1 ? 'file' : 'files'}` : 'All processed';
    pb.disabled = !todo;
    pb.classList.toggle('primary', !!todo);
  }
  $('qZip').disabled = !done || !!st.batch;
  $('qZip').textContent = done && done < vids.length ? `Download ${done} done (.zip)` : 'Download all (.zip)';
  if (!st.batch) {
    const stale = vids.filter((i) => i.status === 'stale').length;
    const err = vids.filter((i) => i.status === 'error').length;
    const bits = [];
    if (done) bits.push(`${done} done`);
    if (stale) bits.push(`${stale} changed since processing`);
    if (err) bits.push(`${err} failed`);
    $('qStatus').textContent = bits.length ? bits.join(' · ') : 'Every file uses Auto unless you change its settings. Click a file to preview and adjust it.';
  }
  $('exportBtn').disabled = !st.cur;
}

function removeItem(item) {
  if (item.status === 'processing') { toast('This file is being processed. Stop the batch first.'); return; }
  const i = st.items.indexOf(item);
  st.items.splice(i, 1);
  if (st.cur === item) {
    const next = st.items[Math.min(i, st.items.length - 1)];
    if (next) selectItem(next);
    else { st.cur = null; stopVideo(); clearPreview(); }
  }
  renderQueue();
}

function clearPreview() {
  st.src = null; st.srcW = 0;
  beforeCtx.clearRect(0, 0, 9999, 9999); afterCtx.clearRect(0, 0, 9999, 9999);
  $('fileName').textContent = 'Add photos or videos to start';
  $('fileMeta').textContent = '';
  $('transport').hidden = true;
}

async function selectItem(item) {
  if (!item) return;
  st.cur = item;
  if (/^Could not open/.test($('toast').textContent)) $('toast').hidden = true;
  for (const li of $('qList').children) li.setAttribute('aria-current', li.dataset.id === String(item.id) ? 'true' : 'false');
  syncSliders();
  syncThisFile();
  $('lockAuto').checked = !!item.locked;
  const showError = (message, details) => {
    stopVideo(); clearPreview();
    $('fileName').textContent = item.name;
    $('fileMeta').textContent = message;
    toast(`Could not open ${item.name}: ${message}${details ? `\nDetails: ${details}` : ''}`, 15000);
  };
  if (item.unplayable) { showError(item.stateText, item.errorDetails); return; }
  try {
    if (item.kind === 'video') await loadVideo(item);
    else await loadImage(item);
  } catch (err) {
    console.error(err);
    if (st.cur !== item) return;
    if (item.kind === 'image') {
      const pe = photoError(item, err);
      item.status = 'error'; item.unplayable = true; item.stateText = pe.message; item.errorDetails = pe.details;
      updateItemEl(item);
      showError(pe.message, pe.details);
    } else showError(`${err.message || err}. This browser may not decode that video format.`);
  }
}

// ------------------------------------------------------------- loading
function setFileLabel() {
  const item = st.cur;
  $('fileName').textContent = item.name;
  const extra = st.kind === 'video' ? ` · ${fmtTime(v.duration)} · ${(+st.fps).toFixed(st.fps % 1 ? 2 : 0)} fps` : '';
  const w = st.kind === 'image' && item.w ? item.w : st.srcW, h = st.kind === 'image' && item.h ? item.h : st.srcH;
  $('fileMeta').textContent = `${w}×${h}${extra}`;
  $('exportBtn').disabled = false;
}

async function loadImage(item) {
  await item.ready;
  if (item.unplayable) throw Object.assign(new Error(item.stateText), { details: item.errorDetails });
  // the preview only needs screen resolution: decode downscaled to save memory
  const bmp = await decodePhoto(item.file, item.info, { maxEdge: PREVIEW_MAX });
  if (st.cur !== item) { bmp.close?.(); return; }
  st.bitmap?.close?.();
  stopVideo();
  st.kind = 'image'; st.bitmap = bmp;
  st.srcW = bmp.width; st.srcH = bmp.height; st.smooth = null;
  $('transport').hidden = true;
  $('lockRow').hidden = true;
  layoutPreview();
  grab(bmp);
  reanalyze();
  render();
  setFileLabel();
}

function stopVideo() {
  if (v.src) { v.pause(); URL.revokeObjectURL(v.src); v.removeAttribute('src'); v.load(); }
}

async function estimateFps() {
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return 30;
  const times = [];
  await new Promise((res) => {
    const cb = (_, md) => {
      times.push(md.mediaTime);
      if (times.length < 14 && !v.ended) v.requestVideoFrameCallback(cb); else res();
    };
    v.requestVideoFrameCallback(cb);
    v.play().catch(res);
    setTimeout(res, 1500);
  });
  v.pause();
  const d = [];
  for (let i = 1; i < times.length; i++) if (times[i] > times[i - 1]) d.push(times[i] - times[i - 1]);
  if (!d.length) return 30;
  d.sort((a, b) => a - b);
  const fps = 1 / d[Math.floor(d.length / 4)];
  const common = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];
  return common.reduce((best, c) => (Math.abs(c - fps) < Math.abs(best - fps) ? c : best), 30);
}

async function loadVideo(item) {
  stopVideo();
  v.muted = true;
  v.src = URL.createObjectURL(item.file);
  await Promise.race([once(v, 'loadeddata'), once(v, 'error').then(() => { throw new Error('unsupported video'); })]);
  if (st.cur !== item) return;
  if (!Number.isFinite(v.duration)) {
    v.currentTime = 1e9; await once(v, 'durationchange'); v.currentTime = 0; await once(v, 'seeked');
  }
  st.kind = 'video'; st.bitmap = null;
  st.srcW = v.videoWidth; st.srcH = v.videoHeight; st.smooth = null;
  st.fps = item.fps || (item.fps = await estimateFps());
  await seekTo(0);
  if (st.cur !== item) return;
  layoutPreview();
  grab(v);
  reanalyze();
  render();
  $('transport').hidden = false;
  $('lockRow').hidden = false;
  setMuted(true);
  updateTime();
  setFileLabel();
}

function relayout() {
  if (!st.cur || !st.srcW) return;
  layoutPreview();
  grab(st.kind === 'image' ? st.bitmap : v);
  reanalyze();
  render();
}

// ------------------------------------------------------------- video
function onFrame(_, md) {
  if (st.kind !== 'video' || !st.cur) return;
  grab(v);
  analyzeNow(true, md?.mediaTime ?? v.currentTime);
  showAuto();
  render();
  updateTime();
  if (!v.paused && !v.ended) v.requestVideoFrameCallback(onFrame);
}
function frameLoop() {
  if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(onFrame);
  else {
    const tick = () => { if (!v.paused) { onFrame(); requestAnimationFrame(tick); } };
    requestAnimationFrame(tick);
  }
}
function togglePlay() {
  if (v.paused) { v.play(); frameLoop(); } else v.pause();
}
v.addEventListener('play', () => { $('playBtn').textContent = '❚❚'; $('playBtn').setAttribute('aria-label', 'Pause'); });
v.addEventListener('pause', () => { $('playBtn').textContent = '▶'; $('playBtn').setAttribute('aria-label', 'Play'); });
v.addEventListener('seeked', () => {
  if (st.kind !== 'video' || !v.paused || !st.cur) return;
  grab(v); reanalyze(); render(); updateTime();
});
function stepFrame(n) {
  v.pause();
  v.currentTime = Math.min(v.duration, Math.max(0, v.currentTime + n / st.fps));
}
function updateTime() {
  $('timeLabel').textContent = `${fmtTime(v.currentTime)} / ${fmtTime(v.duration || 0)}`;
  if (document.activeElement !== $('scrub')) $('scrub').value = Math.round((v.currentTime / (v.duration || 1)) * 1000);
}
function setMuted(m) {
  v.muted = m;
  $('muteBtn').setAttribute('aria-pressed', m);
  $('muteBtn').textContent = m ? 'Sound off' : 'Sound on';
}

/** Seek and wait until the new frame is actually presented. */
function seekTo(t) {
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

// ------------------------------------------------------------- export
async function saveBlob(blob, filename) {
  const dl = await downloadsCap;
  if (dl) {
    try {
      await dl.save({ filename, data: blob });
      return true;
    } catch (e) {
      if (e?.code === 'declined') return false;
      if (!['unavailable', 'not_granted', 'capability_disabled', 'capability_removed'].includes(e?.code)) throw new Error(e?.message || 'save failed');
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  return true;
}

/** Process one item with the given output options; stores and returns the result. */
async function processItem(item, opts, onProgress, signal) {
  const user = { ...item.user };
  const sig = signature(item, opts);
  let r;
  if (item.kind === 'image') {
    const fmt = opts.imageFormat || (/png$/i.test(item.file.type) ? 'png' : 'jpeg');
    onProgress?.({ frac: 0.5, text: 'Processing photo…' });
    await item.ready;
    r = await exportImage({ file: item.file, info: item.info, eng: st.eng, user, locked: item.locked, format: fmt });
  } else {
    r = await exportVideo({
      file: item.file, eng: st.eng, gpu: st.gpu, user, locked: item.locked,
      opts: { format: opts.format, maxShort: opts.maxShort, fps: item.fps || 30 }, onProgress, signal,
    });
  }
  item.result = { blob: r.blob, name: `${baseName(item.name)}-reefhue.${r.ext}`, info: r.info, sig, opts };
  item.status = item.result.sig === signature(item, opts) ? 'done' : 'stale';
  item.progress = 1;
  item.stateText = item.status === 'done' ? doneText(item.result) : 'Settings changed, process again';
  return item.result;
}

function progressText(p) {
  if (p.eta != null && p.fps) return `${Math.round(p.frac * 100)}% · ${p.fps.toFixed(0)} fps · ${Math.ceil(p.eta)} s left`;
  return p.text || `${Math.round((p.frac || 0) * 100)}%`;
}

async function runBatch() {
  if (st.batch) { st.batch.abort.abort(); return; }
  const opts = outputOpts();
  const todo = st.items.filter((i) => i.status !== 'done' && !i.unplayable);
  if (!todo.length) return;
  st.batch = { abort: new AbortController() };
  for (const i of todo) { i.status = 'queued'; i.stateText = 'Waiting'; i.progress = 0; updateItemEl(i); }
  syncBatchButtons();
  const t0 = performance.now();
  let ok = 0, failed = 0, n = 0;
  for (const item of todo) {
    if (st.batch.abort.signal.aborted) break;
    if (!st.items.includes(item)) continue;
    n++;
    item.status = 'processing'; item.stateText = 'Starting…'; item.progress = 0;
    updateItemEl(item);
    $('qStatus').textContent = `Processing ${n} of ${todo.length}: ${item.name}`;
    let lastPaint = 0;
    try {
      await processItem(item, opts, (p) => {
        item.progress = p.frac || 0;
        item.stateText = progressText(p);
        const now = performance.now();
        if (now - lastPaint > 200) { lastPaint = now; updateItemEl(item); }
      }, st.batch.abort.signal);
      ok++;
    } catch (e) {
      if (e?.name === 'AbortError') { item.status = 'ready'; item.stateText = 'Stopped'; item.progress = 0; }
      else { console.error(e); item.status = 'error'; item.stateText = `Failed: ${e.message || e}`; failed++; }
    }
    updateItemEl(item);
  }
  for (const i of st.items) if (i.status === 'queued') { i.status = i.result ? 'stale' : 'ready'; i.stateText = i.result ? 'Settings changed, process again' : 'Ready'; updateItemEl(i); }
  const stopped = st.batch.abort.signal.aborted;
  st.batch = null;
  syncBatchButtons();
  const secs = Math.round((performance.now() - t0) / 1000);
  $('qStatus').textContent = `${stopped ? 'Stopped. ' : ''}${ok} processed${failed ? `, ${failed} failed` : ''} in ${fmtDur(secs)}.`;
  if (ok && !stopped) toast(`Batch done: ${ok} file${ok > 1 ? 's' : ''} ready. Use Download all.`);
}

async function downloadAll() {
  const done = st.items.filter((i) => i.status === 'done' && i.result);
  if (!done.length) return;
  const zb = $('qZip');
  zb.disabled = true;
  try {
    $('qStatus').textContent = 'Packing zip…';
    const zip = await makeZip(done.map((i) => ({ name: i.result.name, blob: i.result.blob })), (f) => {
      $('qStatus').textContent = `Packing zip… ${Math.round(f * 100)}%`;
    });
    const d = new Date();
    const name = `reefhue-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.zip`;
    if (await saveBlob(zip, name)) toast(`Saved ${name} (${done.length} files, ${fmtMB(zip.size)})`);
  } catch (e) {
    toast(`Could not save the zip: ${e.message || e}`);
  } finally {
    syncBatchButtons();
  }
}

// ------------------------------------------------------------- export sheet
let sheetAbort = null;
function videoSizes() {
  const even = (x) => Math.max(2, Math.round(x / 2) * 2);
  const out = [{ label: `Original · ${st.srcW}×${st.srcH}`, short: 0 }];
  for (const target of [2160, 1080, 720]) {
    const short = Math.min(st.srcW, st.srcH);
    if (short > target) {
      const k = target / short;
      out.push({ label: `${target}p · ${even(st.srcW * k)}×${even(st.srcH * k)}`, short: target });
    }
  }
  return out;
}

function openSheet() {
  const item = st.cur;
  if (!item) return;
  $('exportErr').hidden = true;
  $('exportProgress').hidden = true;
  $('sheetGo').disabled = false;
  const isVideo = item.kind === 'video';
  $('sheetImage').hidden = isVideo;
  $('sheetVideo').hidden = !isVideo;
  const fresh = item.status === 'done' && item.result;
  $('sheetGo').textContent = fresh ? `Download ${fmtMB(item.result.blob.size)}` : 'Process and download';
  if (isVideo) {
    const sel = $('vidRes');
    sel.innerHTML = videoSizes().map((s) => `<option value="${s.short}">${s.label}</option>`).join('');
    const o = outputOpts();
    sel.value = String(o.maxShort || 0);
    if (sel.selectedIndex < 0) sel.selectedIndex = 0;
    $('vidFormat').value = o.format;
    const frames = Math.round((v.duration || item.duration) * (item.fps || st.fps));
    $('vidNote').textContent = fresh
      ? `Already processed: ${item.result.info.codec}, ${item.result.info.width}×${item.result.info.height}, sound ${item.result.info.audio}.`
      : `${frames} frames are restored on this device: decoded with WebCodecs, colour-corrected by the Rust engine${st.gpu ? ' on the GPU' : ''}, then encoded. Keep this tab open while it runs.`;
  } else {
    $('imgFormat').value = /png$/i.test(item.file.type) ? 'png' : 'jpeg';
    $('imgNote').textContent = `Full resolution, ${item.w || st.srcW}×${item.h || st.srcH} px. Processed locally; the file never leaves this device. Camera metadata (EXIF) is not copied.`;
  }
  const changeOpt = () => {
    if (item.status === 'done') $('sheetGo').textContent = 'Process and download';
  };
  $('vidRes').onchange = changeOpt;
  $('vidFormat').onchange = changeOpt;
  $('imgFormat').onchange = changeOpt;
  $('sheet').hidden = false;
}

async function runSheet() {
  const item = st.cur;
  const go = $('sheetGo');
  go.disabled = true;
  $('exportErr').hidden = true;
  const prog = (p) => {
    $('exportProgress').hidden = false;
    $('exportBar').style.width = `${((p.frac || 0) * 100).toFixed(1)}%`;
    $('exportText').textContent = p.eta != null && p.fps ? `${p.text} · ${p.fps.toFixed(1)} fps · about ${Math.ceil(p.eta)} s left` : p.text || '';
    item.progress = p.frac || 0;
  };
  try {
    let res = item.result;
    const wantNew = go.textContent.startsWith('Process');
    if (wantNew) {
      if (item.status === 'processing') throw new Error('This file is already being processed in the batch.');
      const opts = item.kind === 'video'
        ? { format: $('vidFormat').value, maxShort: +$('vidRes').value || null }
        : { imageFormat: $('imgFormat').value };
      sheetAbort = new AbortController();
      st.busy = true;
      item.status = 'processing'; item.stateText = 'Processing…';
      updateItemEl(item);
      v.pause();
      res = await processItem(item, opts, (p) => { prog(p); item.stateText = progressText(p); }, sheetAbort.signal);
      updateItemEl(item);
      syncBatchButtons();
    }
    prog({ frac: 1, text: 'Saving…' });
    if (await saveBlob(res.blob, res.name)) {
      const i = res.info || {};
      toast(`Saved ${res.name} (${fmtMB(res.blob.size)}${i.seconds ? `, ${Math.round(i.seconds)} s, ${i.fps.toFixed(0)} fps` : ''})`);
    }
    $('sheet').hidden = true;
  } catch (e) {
    console.error(e);
    if (item.status === 'processing') { item.status = item.result ? 'stale' : 'ready'; item.stateText = e.name === 'AbortError' ? 'Stopped' : 'Ready'; updateItemEl(item); }
    $('exportErr').textContent = e.name === 'AbortError' ? 'Export cancelled.' : e.message || String(e);
    $('exportErr').hidden = false;
    go.disabled = false;
  } finally {
    st.busy = false;
    sheetAbort = null;
  }
}

// ------------------------------------------------------------- speed test
async function speedTest() {
  const rows = $('speedRows');
  const go = $('speedGo');
  go.disabled = true;
  const tr = (label, sub, fps, secs) => `<tr><td>${label}<small>${sub}</small></td><td>${fps}</td><td>${secs}</td></tr>`;
  rows.innerHTML = tr('Rendering test clip…', '1920×1080, 4 s, 120 frames', '', '');
  $('speedNote').textContent = '';
  const results = [];
  try {
    // key frame every 2 s, like most phone and action cameras
    const clip = await demoClip(null, { width: 1920, height: 1080, seconds: 4, gop: 60 });
    const file = new File([clip.blob], clip.name, { type: clip.type });
    const modes = [
      { label: 'Previous method', sub: 'seek every frame, Rust/WASM on the CPU', opts: { forceCompat: true }, gpu: null },
      { label: 'Direct decoding', sub: 'WebCodecs decode, Rust/WASM on the CPU', opts: {}, gpu: null },
      { label: 'Direct decoding + GPU', sub: 'WebCodecs decode, Rust analysis, WebGL2 shader', opts: {}, gpu: st.gpu },
    ];
    for (const m of modes) {
      if (m.label.includes('GPU') && !st.gpu) { results.push({ m, skip: 'WebGL2 not available' }); continue; }
      rows.innerHTML = results.map((r) => tr(r.m.label, r.m.sub, r.skip ? '—' : r.info.fps.toFixed(1), r.skip ? r.skip : `${r.info.seconds.toFixed(1)} s`)).join('')
        + tr(m.label, m.sub, '…', '');
      const r = await exportVideo({ file, eng: st.eng, gpu: m.gpu, user: presetValues('auto'), locked: null, opts: { format: 'mp4', fps: 30, ...m.opts } });
      results.push({ m, info: r.info });
    }
    rows.innerHTML = results.map((r) => tr(r.m.label, r.m.sub, r.skip ? '—' : r.info.fps.toFixed(1), r.skip ? r.skip : `${r.info.seconds.toFixed(1)} s`)).join('');
    const base = results[0]?.info?.fps, best = Math.max(...results.filter((r) => r.info).map((r) => r.info.fps));
    const fast = results.find((r) => r.info && r.info.path === 'fast');
    $('speedNote').textContent = base
      ? `Fastest method is ${(best / base).toFixed(1)}× the previous one on this device. ${fast ? `Encoder: ${fast.info.codec}. ` : ''}Times include decoding, analysis, colour correction and encoding.`
      : '';
    window.reefhueSpeed = results.map((r) => ({ label: r.m.label, ...(r.info || { skip: r.skip }) }));
  } catch (e) {
    $('speedNote').textContent = `Speed test failed: ${e.message || e}`;
  } finally {
    go.disabled = false;
    go.textContent = 'Run again';
  }
}

// ------------------------------------------------------------- debug log
// Open the page with #debug (or tap "debug log") to see errors on screen,
// handy on phones where DevTools aren't available.
const debugLines = [];
function dlog(kind, args) {
  const text = args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}${a.details ? ` [${a.details}]` : ''}` : typeof a === 'object' ? (() => { try { return JSON.stringify(a); } catch { return String(a); } })() : String(a))).join(' ');
  debugLines.push(`${new Date().toISOString().slice(11, 23)} ${kind} ${text}`);
  if (debugLines.length > 300) debugLines.shift();
  const pre = document.getElementById('debugLog');
  if (pre && !document.getElementById('debug').hidden) { pre.textContent = debugLines.join('\n'); pre.scrollTop = pre.scrollHeight; }
}
for (const kind of ['error', 'warn', 'info']) {
  const orig = console[kind].bind(console);
  console[kind] = (...a) => { dlog(kind.toUpperCase(), a); orig(...a); };
}
window.addEventListener('error', (e) => dlog('UNCAUGHT', [e.message, `${e.filename}:${e.lineno}`]));
window.addEventListener('unhandledrejection', (e) => dlog('REJECTION', [e.reason]));
function showDebug(on) {
  $('debug').hidden = !on;
  if (on) { $('debugLog').textContent = debugLines.join('\n'); }
}
// Shadow under the pinned preview once the page scrolls beneath it (phones).
function watchPinnedPreview() {
  const pane = $('previewPane');
  const mark = document.createElement('div');
  mark.setAttribute('aria-hidden', 'true');
  pane.before(mark);
  new IntersectionObserver(([e]) => pane.classList.toggle('stuck', !e.isIntersecting && e.boundingClientRect.top < 0)).observe(mark);
}

function bindDebug() {
  const version = document.querySelector('meta[name="reefhue-version"]')?.content || 'dev';
  $('version').textContent = version;
  dlog('INFO', [`Reefhue ${version}`, navigator.userAgent, `cores ${navigator.hardwareConcurrency}`, `memory ${navigator.deviceMemory ?? '?'} GB`,
    `WebCodecs ${typeof VideoEncoder !== 'undefined'}`, `screen ${screen.width}x${screen.height}@${devicePixelRatio}`]);
  $('debugLink').onclick = (e) => { e.preventDefault(); showDebug(true); };
  $('debugClose').onclick = () => showDebug(false);
  $('debugCopy').onclick = async () => {
    const text = debugLines.join('\n');
    try { await navigator.clipboard.writeText(text); toast('Debug log copied.'); } catch {
      const r = document.createRange(); r.selectNodeContents($('debugLog'));
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      toast('Select-all done: copy with your device menu.');
    }
  };
  if (/debug/.test(location.hash) || /debug/.test(location.search)) showDebug(true);
}

// ------------------------------------------------------------- wiring
function bindInputs() {
  $('fileInput').addEventListener('change', (e) => { if (e.target.files.length) addFiles(e.target.files); e.target.value = ''; });
  let depth = 0;
  window.addEventListener('dragenter', (e) => { if ([...e.dataTransfer.types].includes('Files')) { depth++; $('drop').hidden = false; } });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; $('drop').hidden = true; } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault(); depth = 0; $('drop').hidden = true;
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
  $('qList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const item = st.items.find((i) => String(i.id) === btn.closest('.q-item').dataset.id);
    if (!item) return;
    if (btn.dataset.act === 'select') selectItem(item);
    if (btn.dataset.act === 'remove') removeItem(item);
    if (btn.dataset.act === 'download' && item.result) saveBlob(item.result.blob, item.result.name);
  });
  $('qProcess').onclick = runBatch;
  $('qZip').onclick = downloadAll;
  $('qOutput').onchange = () => { for (const i of st.items) itemEdited(i); };
  $('tfAuto').onclick = () => {
    if (!st.cur) return;
    st.cur.locked = null;
    $('lockAuto').checked = false;
    applyPreset('auto');
  };
  $('tfAll').onclick = () => {
    const src = st.cur;
    if (!src) return;
    let n = 0;
    for (const i of st.items) {
      if (i === src) continue;
      i.preset = src.preset;
      i.user = { ...src.user };
      i.locked = null;
      itemEdited(i);
      n++;
    }
    toast(`Settings copied to ${n} other file${n === 1 ? '' : 's'}.`);
  };
  $('exportBtn').onclick = openSheet;
  $('sheetCancel').onclick = () => { if (sheetAbort) sheetAbort.abort(); else $('sheet').hidden = true; };
  $('sheetGo').onclick = runSheet;
  $('resetBtn').onclick = () => st.cur && applyPreset(st.cur.preset);
  $('playBtn').onclick = togglePlay;
  $('stepBack').onclick = () => stepFrame(-1);
  $('stepFwd').onclick = () => stepFrame(1);
  $('muteBtn').onclick = () => setMuted(!v.muted);
  $('scrub').addEventListener('input', (e) => { v.pause(); v.currentTime = (+e.target.value / 1000) * v.duration; });
  $('lockAuto').addEventListener('change', (e) => {
    if (!st.cur) return;
    st.cur.locked = e.target.checked ? { data: st.thumb.slice(), w: st.tw, h: st.th } : null;
    reanalyze(); requestRender(); itemEdited(st.cur);
  });
  $('demoPhotoBtn').onclick = () => loadDemoPhoto(true);
  $('demoClipBtn').onclick = async () => {
    try {
      busy('Rendering a demo clip in the browser…', 0);
      const clip = await demoClip((f) => busy('Rendering a demo clip in the browser…', f));
      busy(null);
      addFiles([new File([clip.blob], clip.name, { type: clip.type })]);
    } catch (e) {
      toast(e.message || String(e));
    } finally { busy(null); }
  };
  $('speedBtn').onclick = () => { $('speed').hidden = false; };
  $('speedClose').onclick = () => { $('speed').hidden = true; };
  $('speedGo').onclick = speedTest;
  let rt = 0;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(relayout, 120);
  });
}

async function loadDemoPhoto(select) {
  busy('Drawing the demo reef…', 0.3);
  try {
    const blob = await demoPhoto();
    const file = new File([blob], 'demo-reef-9m.jpg', { type: 'image/jpeg' });
    const [item] = addFiles([file]);
    if (item) item.demo = !select;
  } finally { busy(null); }
}

async function main() {
  bindDebug();
  watchPinnedPreview();
  buildUI();
  bindStage();
  bindInputs();
  applyView();
  drawCast();
  drawHist();
  renderQueue();
  try {
    const b64 = globalThis.REEFHUE_WASM_B64;
    const src = b64 ? Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)) : new URL('engine.wasm', import.meta.url);
    st.eng = await Engine.load(src);
  } catch (e) {
    $('fileName').textContent = 'The colour engine failed to load';
    toast(`WebAssembly engine failed to load: ${e.message}`, 10000);
    return;
  }
  st.gpu = GpuRenderer.create();
  await loadDemoPhoto(false);
}

window.reefhue = st; // handy for debugging and automated tests
main();
