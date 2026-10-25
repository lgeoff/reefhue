// HEIC/HEIF photos (iPhones, many Android phones), without a decoder library.
//
// A HEIC file is an ISO-BMFF container whose picture is HEVC-coded, usually
// as a grid of 512×512 tiles. The container is parsed here and every tile is
// decoded by the browser's own HEVC decoder (WebCodecs), which phones and
// most computers have in hardware. Tiles are stitched, rotated/mirrored as the
// file says, and returned as a JPEG.

const fourcc = (u8, p) => String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);

function boxes(u8, start, end) {
  const out = [];
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p), hdr = 8;
    const type = fourcc(u8, p + 4);
    if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hdr = 16; } else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    out.push({ type, start: p, body: p + hdr, end: p + size });
    p += size;
  }
  return out;
}

/** Parse the HEIF item structure. Exported for tests. */
export function parseHeif(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const top = boxes(u8, 0, u8.length);
  const meta = top.find((b) => b.type === 'meta');
  if (!meta) throw new Error('This HEIC file has no image index.');
  const kids = boxes(u8, meta.body + 4, meta.end);
  const get = (t) => kids.find((b) => b.type === t);
  const uN = (p, n) => (n === 0 ? 0 : n === 2 ? dv.getUint16(p) : n === 4 ? dv.getUint32(p) : Number(dv.getBigUint64(p)));

  const pitm = get('pitm');
  const primary = u8[pitm.body] === 0 ? dv.getUint16(pitm.body + 4) : dv.getUint32(pitm.body + 4);

  const items = new Map();
  const iinf = get('iinf');
  const iinfV = u8[iinf.body];
  for (const infe of boxes(u8, iinf.body + 4 + (iinfV === 0 ? 2 : 4), iinf.end)) {
    const v = u8[infe.body];
    if (v < 2) continue;
    const id = v === 2 ? dv.getUint16(infe.body + 4) : dv.getUint32(infe.body + 4);
    const tp = infe.body + 4 + (v === 2 ? 2 : 4) + 2;
    items.set(id, { id, type: fourcc(u8, tp), props: [], extents: [], refs: {} });
  }

  const iloc = get('iloc');
  {
    let p = iloc.body;
    const v = u8[p]; p += 4;
    const offSize = u8[p] >> 4, lenSize = u8[p] & 15, baseSize = u8[p + 1] >> 4, idxSize = v ? u8[p + 1] & 15 : 0; p += 2;
    const count = v < 2 ? dv.getUint16(p) : dv.getUint32(p); p += v < 2 ? 2 : 4;
    for (let i = 0; i < count; i++) {
      const id = v < 2 ? dv.getUint16(p) : dv.getUint32(p); p += v < 2 ? 2 : 4;
      let method = 0;
      if (v === 1 || v === 2) { method = dv.getUint16(p) & 15; p += 2; }
      p += 2; // data reference index
      const base = uN(p, baseSize); p += baseSize;
      const n = dv.getUint16(p); p += 2;
      const it = items.get(id);
      for (let k = 0; k < n; k++) {
        if (idxSize) p += idxSize;
        const off = uN(p, offSize); p += offSize;
        const len = uN(p, lenSize); p += lenSize;
        it?.extents.push({ method, off: base + off, len });
      }
    }
  }

  const iref = get('iref');
  if (iref) {
    const v = u8[iref.body];
    for (const r of boxes(u8, iref.body + 4, iref.end)) {
      let p = r.body;
      const from = v === 0 ? dv.getUint16(p) : dv.getUint32(p); p += v === 0 ? 2 : 4;
      const n = dv.getUint16(p); p += 2;
      const to = [];
      for (let k = 0; k < n; k++) { to.push(v === 0 ? dv.getUint16(p) : dv.getUint32(p)); p += v === 0 ? 2 : 4; }
      const it = items.get(from);
      if (it) it.refs[r.type] = to;
    }
  }

  const iprp = get('iprp');
  const ip = boxes(u8, iprp.body, iprp.end);
  const props = boxes(u8, ip.find((b) => b.type === 'ipco').body, ip.find((b) => b.type === 'ipco').end);
  for (const ipma of ip.filter((b) => b.type === 'ipma')) {
    let p = ipma.body;
    const v = u8[p], flags = u8[p + 3]; p += 4;
    const n = dv.getUint32(p); p += 4;
    for (let i = 0; i < n; i++) {
      const id = v < 1 ? dv.getUint16(p) : dv.getUint32(p); p += v < 1 ? 2 : 4;
      const c = u8[p++];
      for (let k = 0; k < c; k++) {
        const idx = flags & 1 ? dv.getUint16(p) & 0x7fff : u8[p] & 0x7f; p += flags & 1 ? 2 : 1;
        const b = props[idx - 1];
        if (b) items.get(id)?.props.push(b);
      }
    }
  }

  const idat = get('idat');
  const dataOf = (it) => {
    let len = 0;
    for (const e of it.extents) len += e.len;
    const out = new Uint8Array(len);
    let o = 0;
    for (const e of it.extents) {
      const src = e.method === 1 ? idat.body + e.off : e.off;
      out.set(u8.subarray(src, src + e.len), o); o += e.len;
    }
    return out;
  };
  const prop = (it, t) => it.props.find((b) => b.type === t);
  const size = (it) => { const b = prop(it, 'ispe'); return b ? { w: dv.getUint32(b.body + 4), h: dv.getUint32(b.body + 8) } : null; };

  const main = items.get(primary);
  if (!main) throw new Error('This HEIC file has no primary image.');
  const transforms = main.props.filter((b) => b.type === 'irot' || b.type === 'imir').map((b) => ({ type: b.type, v: u8[b.body] }));
  let layout;
  if (main.type === 'grid') {
    const g = dataOf(main);
    const big = g[1] & 1;
    const rows = g[2] + 1, cols = g[3] + 1;
    const w = big ? new DataView(g.buffer).getUint32(4) : (g[4] << 8) | g[5];
    const h = big ? new DataView(g.buffer).getUint32(8) : (g[6] << 8) | g[7];
    const tiles = (main.refs.dimg || []).map((id) => items.get(id));
    layout = { w, h, rows, cols, tiles };
  } else if (main.type === 'hvc1') {
    const s = size(main);
    layout = { w: s?.w, h: s?.h, rows: 1, cols: 1, tiles: [main] };
  } else {
    throw new Error(main.type === 'av01' ? 'This HEIF holds an AV1 (AVIF) picture: rename it to .avif.' : `This HEIC uses an unsupported picture type (${main.type}).`);
  }
  const t0 = layout.tiles[0];
  if (!t0 || t0.type !== 'hvc1') throw new Error('This HEIC file has no HEVC tiles.');
  const hvcC = prop(t0, 'hvcC');
  const tileSize = size(t0);
  return {
    ...layout, transforms, tileW: tileSize?.w, tileH: tileSize?.h,
    hvcC: u8.slice(hvcC.body, hvcC.end),
    tileData: (i) => dataOf(layout.tiles[i]),
  };
}

/** WebCodecs codec string for an hvcC record, e.g. "hvc1.1.6.L93.B0". */
export function hevcCodec(c) {
  const space = c[1] >> 6, tier = (c[1] >> 5) & 1, profile = c[1] & 31;
  let compat = ((c[2] << 24) | (c[3] << 16) | (c[4] << 8) | c[5]) >>> 0, rev = 0;
  for (let i = 0; i < 32; i++) { rev = (rev << 1) | (compat & 1); compat >>>= 1; }
  const cons = Array.from(c.subarray(6, 12));
  while (cons.length && cons[cons.length - 1] === 0) cons.pop();
  return ['hvc1', `${['', 'A', 'B', 'C'][space]}${profile}`, (rev >>> 0).toString(16).toUpperCase(), `${tier ? 'H' : 'L'}${c[12]}`, ...cons.map((b) => b.toString(16).toUpperCase())].join('.');
}

/** Decode a HEIC to JPEG bytes. Resolves {bytes, w, h, note}. */
export async function heicToJpeg(u8, name) {
  const notSupported = () => {
    const e = new Error('This browser can’t decode HEVC, which HEIC photos use. Share or export the photo as JPEG (on iPhone: Settings › Camera › Formats › Most Compatible).');
    e.details = `${name} · HEVC decoding not available`;
    return e;
  };
  if (typeof VideoDecoder === 'undefined') throw notSupported();
  const h = parseHeif(u8);
  const codec = hevcCodec(h.hvcC);
  const config = { codec, description: h.hvcC, optimizeForLatency: true };
  const ok = await VideoDecoder.isConfigSupported(config).then((r) => r.supported, () => false);
  if (!ok) throw notSupported();

  const canvas = new OffscreenCanvas(h.w, h.h);
  const g = canvas.getContext('2d');
  let failed = null;
  const dec = new VideoDecoder({
    output: (frame) => {
      const i = frame.timestamp;
      const x = (i % h.cols) * (h.tileW || frame.displayWidth), y = Math.floor(i / h.cols) * (h.tileH || frame.displayHeight);
      g.drawImage(frame, x, y, h.tileW || frame.displayWidth, h.tileH || frame.displayHeight);
      frame.close();
    },
    error: (e) => { failed = e; },
  });
  dec.configure(config);
  for (let i = 0; i < h.tiles.length; i++) {
    dec.decode(new EncodedVideoChunk({ type: 'key', timestamp: i, data: h.tileData(i) }));
    // keep the decoder's queue short on phones
    if (dec.decodeQueueSize > 8) await new Promise((r) => dec.addEventListener('dequeue', r, { once: true }));
  }
  await dec.flush().catch((e) => { failed ||= e; });
  dec.close();
  if (failed) { const e = new Error('This HEIC photo could not be decoded.'); e.details = `${name} · ${codec} · ${failed.message || failed}`; throw e; }

  // rotation (anticlockwise quarter turns) and mirroring, in file order
  let out = canvas;
  for (const t of h.transforms) {
    const turns = t.type === 'irot' ? t.v & 3 : 0;
    const w = turns % 2 ? out.height : out.width, hh = turns % 2 ? out.width : out.height;
    const c = new OffscreenCanvas(w, hh);
    const cg = c.getContext('2d');
    if (t.type === 'irot') {
      cg.translate(w / 2, hh / 2);
      cg.rotate((-turns * Math.PI) / 2);
      cg.drawImage(out, -out.width / 2, -out.height / 2);
    } else if (t.v & 1) { cg.translate(0, hh); cg.scale(1, -1); cg.drawImage(out, 0, 0); } // horizontal axis: top-bottom
    else { cg.translate(w, 0); cg.scale(-1, 1); cg.drawImage(out, 0, 0); } // vertical axis: left-right
    out = c;
  }
  const bytes = new Uint8Array(await (await out.convertToBlob({ type: 'image/jpeg', quality: 0.96 })).arrayBuffer());
  return { bytes, w: out.width, h: out.height, note: `HEIC · ${h.tiles.length > 1 ? `${h.tiles.length} tiles` : 'single image'}` };
}
