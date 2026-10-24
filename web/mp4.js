// MP4 / MOV demuxer and muxer, no dependencies.
//
// Demuxer: reads only the `moov` index of a File (works for multi-GB clips),
// returns per-track sample tables and WebCodecs decoder configs. Sample data
// is read lazily with File.slice.
// Muxer: H.264 / HEVC video from VideoEncoder plus AAC (copied from the
// source, or encoded) or Opus audio, `moov` first ("fast start"), 64-bit
// offsets when the file passes 4 GB. Large outputs are held as Blobs so the
// browser can page them to disk.

const td = new TextDecoder();
const te = new TextEncoder();
const fourcc = (u8, o) => td.decode(u8.subarray(o, o + 4));

// ------------------------------------------------------------- reading ----

class Box {
  constructor(u8, start, end) {
    this.u8 = u8;
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    this.start = start;
    this.end = end;
  }
  *children(from = this.start) {
    let o = from;
    while (o + 8 <= this.end) {
      let size = this.dv.getUint32(o);
      const type = fourcc(this.u8, o + 4);
      let hdr = 8;
      if (size === 1) { size = Number(this.dv.getBigUint64(o + 8)); hdr = 16; } else if (size === 0) size = this.end - o;
      if (size < hdr || o + size > this.end) break;
      yield { type, start: o, content: o + hdr, end: o + size };
      o += size;
    }
  }
  find(type, from) {
    for (const c of this.children(from)) if (c.type === type) return c;
    return null;
  }
}

function path(root, u8, ...types) {
  let box = root;
  let cur = null;
  for (const t of types) {
    const b = new Box(u8, cur ? cur.content : box.start, cur ? cur.end : box.end);
    cur = b.find(t);
    if (!cur) return null;
  }
  return cur;
}

const hex = (n, w = 2) => n.toString(16).padStart(w, '0');

function avcCodec(type, avcC) {
  return `${type}.${hex(avcC[1])}${hex(avcC[2])}${hex(avcC[3])}`;
}

function hevcCodec(type, h) {
  const space = h[1] >> 6, tier = (h[1] >> 5) & 1, profile = h[1] & 31;
  let compat = ((h[2] << 24) | (h[3] << 16) | (h[4] << 8) | h[5]) >>> 0;
  let rev = 0;
  for (let i = 0; i < 32; i++) { rev = (rev << 1) | (compat & 1); compat >>>= 1; }
  const cons = Array.from(h.subarray(6, 12));
  while (cons.length && cons[cons.length - 1] === 0) cons.pop();
  const parts = [type, `${['', 'A', 'B', 'C'][space]}${profile}`, (rev >>> 0).toString(16), `${tier ? 'H' : 'L'}${h[12]}`];
  for (const c of cons) parts.push(c.toString(16));
  return parts.join('.');
}

function readDescLen(u8, o) {
  let len = 0, n = 0;
  for (; n < 4; n++) {
    const b = u8[o + n];
    len = (len << 7) | (b & 0x7f);
    if (!(b & 0x80)) { n++; break; }
  }
  return [len, o + n];
}

/** AudioSpecificConfig and object type from an esds box body (after version/flags). */
function parseEsds(u8, o, end) {
  let objectType = 0x40, asc = null;
  while (o < end) {
    const tag = u8[o];
    const [len, p] = readDescLen(u8, o + 1);
    if (tag === 0x03) {
      let q = p + 2;
      const flags = u8[q++];
      if (flags & 0x80) q += 2;
      if (flags & 0x40) q += 1 + u8[q];
      if (flags & 0x20) q += 2;
      o = q;
      continue;
    }
    if (tag === 0x04) { objectType = u8[p]; o = p + 13; continue; }
    if (tag === 0x05) { asc = u8.slice(p, p + len); break; }
    o = p + len;
  }
  return { objectType, asc };
}

function parseSampleEntry(u8, dv, entry, handler) {
  const type = fourcc(u8, entry.start + 4);
  const info = { entryType: type, raw: u8.slice(entry.start, entry.end) };
  if (handler === 'vide') {
    info.codedWidth = dv.getUint16(entry.content + 24);
    info.codedHeight = dv.getUint16(entry.content + 26);
    const kids = new Box(u8, entry.content + 78, entry.end);
    for (const c of kids.children()) {
      const body = u8.subarray(c.content, c.end);
      if (c.type === 'avcC') { info.codec = avcCodec(type, body); info.description = body.slice(); info.family = 'avc'; }
      if (c.type === 'hvcC') { info.codec = hevcCodec(type, body); info.description = body.slice(); info.family = 'hevc'; }
      if (c.type === 'vpcC') {
        info.codec = `vp09.${hex(body[4])}.${hex(body[5])}.${hex(body[6] >> 4)}`; info.family = 'vp9';
      }
      if (c.type === 'av1C') {
        const prof = body[1] >> 5, lvl = body[1] & 31, tierH = body[2] >> 7, hb = (body[2] >> 6) & 1, tw = (body[2] >> 5) & 1;
        info.codec = `av01.${prof}.${hex(lvl)}${tierH ? 'H' : 'M'}.${hb ? (tw ? '12' : '10') : '08'}`;
        info.description = body.slice(); info.family = 'av1';
      }
    }
  } else if (handler === 'soun') {
    const ver = dv.getUint16(entry.content + 8);
    info.channels = dv.getUint16(entry.content + 16);
    info.sampleSize = dv.getUint16(entry.content + 18);
    info.sampleRate = dv.getUint32(entry.content + 24) >>> 16;
    let kidsAt = entry.content + 28 + (ver === 1 ? 16 : ver === 2 ? 36 : 0);
    if (ver === 2) info.sampleRate = Math.round(dv.getFloat64(entry.content + 32));
    const scan = (from, to) => {
      for (const c of new Box(u8, from, to).children()) {
        if (c.type === 'esds') {
          const { objectType, asc } = parseEsds(u8, c.content + 4, c.end);
          info.asc = asc;
          info.objectType = objectType;
          if (objectType === 0x40 && asc) {
            let aot = asc[0] >> 3;
            if (aot === 31) aot = 32 + (((asc[0] & 7) << 3) | (asc[1] >> 5));
            info.codec = `mp4a.40.${aot}`;
            info.family = 'aac';
          } else if (objectType === 0x6b || objectType === 0x69) { info.codec = 'mp3'; info.family = 'mp3'; }
        } else if (c.type === 'wave') scan(c.content, c.end);
        else if (c.type === 'dOps') { info.family = 'opus'; info.codec = 'opus'; info.dOps = u8.slice(c.content, c.end); }
      }
    };
    scan(kidsAt, entry.end);
    if (!info.family) info.family = type.trim();
  }
  return info;
}

function parseTrak(u8, trak, movieTimescale) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const box = new Box(u8, trak.content, trak.end);
  const tkhd = box.find('tkhd');
  const t = {};
  if (tkhd) {
    const v = u8[tkhd.content];
    const o = tkhd.content + (v === 1 ? 32 : 20);
    t.id = dv.getUint32(tkhd.content + (v === 1 ? 20 : 12));
    // o points at duration; matrix follows 20 bytes later in both versions
    t.matrix = u8.slice(o + 20, o + 56);
    t.displayWidth = dv.getUint32(o + 56) / 65536;
    t.displayHeight = dv.getUint32(o + 60) / 65536;
  }
  const mdia = box.find('mdia');
  if (!mdia) return null;
  const md = new Box(u8, mdia.content, mdia.end);
  const mdhd = md.find('mdhd');
  const hdlr = md.find('hdlr');
  if (!mdhd || !hdlr) return null;
  const mv = u8[mdhd.content];
  t.timescale = dv.getUint32(mdhd.content + (mv === 1 ? 20 : 12));
  t.handler = fourcc(u8, hdlr.content + 8);
  if (t.handler !== 'vide' && t.handler !== 'soun') return null;
  t.type = t.handler === 'vide' ? 'video' : 'audio';

  // edit list: initial delay (empty edit) and media start time
  t.mediaTime = 0;
  t.delay = 0;
  const elst = path(box, u8, 'edts', 'elst');
  if (elst) {
    const v = u8[elst.content];
    const n = dv.getUint32(elst.content + 4);
    let o = elst.content + 8;
    for (let i = 0; i < n; i++) {
      const dur = v === 1 ? Number(dv.getBigUint64(o)) : dv.getUint32(o);
      const mt = v === 1 ? Number(dv.getBigInt64(o + 8)) : dv.getInt32(o + 4);
      o += v === 1 ? 20 : 12;
      if (mt === -1) { t.delay += dur / movieTimescale; continue; }
      t.mediaTime = mt;
      break;
    }
  }

  const stbl = path(md, u8, 'minf', 'stbl');
  if (!stbl) return null;
  const sb = new Box(u8, stbl.content, stbl.end);
  const stsd = sb.find('stsd');
  const first = new Box(u8, stsd.content + 8, stsd.end).children().next().value;
  Object.assign(t, parseSampleEntry(u8, dv, first, t.handler));

  // sample sizes
  let sizes;
  const stsz = sb.find('stsz');
  const stz2 = sb.find('stz2');
  if (stsz) {
    const fixed = dv.getUint32(stsz.content + 4), n = dv.getUint32(stsz.content + 8);
    sizes = new Uint32Array(n);
    if (fixed) sizes.fill(fixed);
    else for (let i = 0; i < n; i++) sizes[i] = dv.getUint32(stsz.content + 12 + i * 4);
  } else if (stz2) {
    const field = u8[stz2.content + 7], n = dv.getUint32(stz2.content + 8);
    sizes = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const o = stz2.content + 12;
      sizes[i] = field === 16 ? dv.getUint16(o + i * 2) : field === 8 ? u8[o + i] : (i & 1 ? u8[o + (i >> 1)] & 15 : u8[o + (i >> 1)] >> 4);
    }
  } else return null;
  const n = sizes.length;

  // chunk offsets
  const stco = sb.find('stco'), co64 = sb.find('co64');
  const cbox = stco || co64;
  const nChunks = dv.getUint32(cbox.content + 4);
  const chunkOff = new Float64Array(nChunks);
  for (let i = 0; i < nChunks; i++) {
    chunkOff[i] = stco ? dv.getUint32(cbox.content + 8 + i * 4) : Number(dv.getBigUint64(cbox.content + 8 + i * 8));
  }
  // samples per chunk
  const stsc = sb.find('stsc');
  const ne = dv.getUint32(stsc.content + 4);
  const offsets = new Float64Array(n);
  let s = 0;
  for (let e = 0; e < ne; e++) {
    const firstChunk = dv.getUint32(stsc.content + 8 + e * 12) - 1;
    const per = dv.getUint32(stsc.content + 12 + e * 12);
    const lastChunk = e + 1 < ne ? dv.getUint32(stsc.content + 8 + (e + 1) * 12) - 1 : nChunks;
    for (let c = firstChunk; c < lastChunk && s < n; c++) {
      let o = chunkOff[c];
      for (let k = 0; k < per && s < n; k++) { offsets[s] = o; o += sizes[s]; s++; }
    }
  }
  // timing
  const dts = new Float64Array(n), dur = new Float64Array(n), cto = new Float64Array(n);
  const stts = sb.find('stts');
  {
    const m = dv.getUint32(stts.content + 4);
    let i = 0, tcur = 0;
    for (let e = 0; e < m; e++) {
      const count = dv.getUint32(stts.content + 8 + e * 8), delta = dv.getUint32(stts.content + 12 + e * 8);
      for (let k = 0; k < count && i < n; k++) { dts[i] = tcur; dur[i] = delta; tcur += delta; i++; }
    }
  }
  const ctts = sb.find('ctts');
  if (ctts) {
    const m = dv.getUint32(ctts.content + 4);
    let i = 0;
    for (let e = 0; e < m; e++) {
      const count = dv.getUint32(ctts.content + 8 + e * 8), off = dv.getInt32(ctts.content + 12 + e * 8);
      for (let k = 0; k < count && i < n; k++) cto[i++] = off;
    }
  }
  const stss = sb.find('stss');
  let key = null;
  if (stss) {
    key = new Uint8Array(n);
    const m = dv.getUint32(stss.content + 4);
    for (let e = 0; e < m; e++) key[dv.getUint32(stss.content + 8 + e * 4) - 1] = 1;
  }
  t.samples = { count: n, offsets, sizes, dts, dur, cto, key };
  const lastDur = n ? dur[n - 1] : 0;
  t.duration = n ? (dts[n - 1] + lastDur - t.mediaTime) / t.timescale : 0;
  t.bytes = sizes.reduce((a, b) => a + b, 0);
  return t;
}

/** Parse the moov box of an MP4/MOV File. Throws if the file is not MP4/MOV. */
export async function openMp4(file) {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const t0 = fourcc(head, 4);
  if (!['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(t0)) throw new Error('not an MP4/MOV file');
  let o = 0, moov = null, brand = '';
  while (o + 8 <= file.size) {
    const h = new Uint8Array(await file.slice(o, o + 16).arrayBuffer());
    const dv = new DataView(h.buffer);
    let size = dv.getUint32(0);
    const type = fourcc(h, 4);
    if (size === 1) size = Number(dv.getBigUint64(8));
    else if (size === 0) size = file.size - o;
    if (size < 8) break;
    if (type === 'ftyp') brand = fourcc(h, 8);
    if (type === 'moov') {
      if (size > 512 * 1024 * 1024) throw new Error('moov box too large');
      moov = new Uint8Array(await file.slice(o, o + size).arrayBuffer());
      break;
    }
    o += size;
  }
  if (!moov) throw new Error('no moov box (file is incomplete or fragmented)');
  const root = new Box(moov, 8, moov.length);
  const mvhd = root.find('mvhd');
  const dv = new DataView(moov.buffer);
  const movieTimescale = mvhd ? dv.getUint32(mvhd.content + (moov[mvhd.content] === 1 ? 20 : 12)) : 1000;
  const tracks = [];
  for (const c of root.children()) if (c.type === 'trak') { const t = parseTrak(moov, c, movieTimescale); if (t) tracks.push(t); }
  const video = tracks.find((t) => t.type === 'video' && t.samples.count) || null;
  const audio = tracks.find((t) => t.type === 'audio' && t.samples.count) || null;
  return { brand, movieTimescale, video, audio, file };
}

/** Sequential sample reader with an 8 MB read-ahead window. */
export class SampleReader {
  constructor(file, track) {
    this.file = file;
    this.t = track;
    this.winStart = 0;
    this.win = new Uint8Array(0);
  }
  async read(i) {
    const s = this.t.samples, off = s.offsets[i], size = s.sizes[i];
    if (off < this.winStart || off + size > this.winStart + this.win.length) {
      const len = Math.max(size, 8 << 20);
      this.winStart = off;
      this.win = new Uint8Array(await this.file.slice(off, Math.min(this.file.size, off + len)).arrayBuffer());
    }
    return this.win.subarray(off - this.winStart, off - this.winStart + size);
  }
}

// ------------------------------------------------------------- writing ----

class Out {
  constructor() { this.parts = []; this.size = 0; }
  u8(v) { this.parts.push(Uint8Array.of(v & 255)); this.size += 1; return this; }
  u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v); return this.bytes(b); }
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0); return this.bytes(b); }
  i32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v); return this.bytes(b); }
  u64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(Math.round(v))); return this.bytes(b); }
  str(s) { return this.bytes(te.encode(s)); }
  zeros(n) { return this.bytes(new Uint8Array(n)); }
  bytes(b) { this.parts.push(b); this.size += b.length; return this; }
  join() { const o = new Uint8Array(this.size); let p = 0; for (const b of this.parts) { o.set(b, p); p += b.length; } return o; }
}
function box(type, ...body) {
  const o = new Out();
  let size = 8;
  for (const b of body) size += b.length;
  o.u32(size).str(type);
  for (const b of body) o.bytes(b);
  return o.join();
}
const full = (type, version, flags, ...body) => box(type, Uint8Array.of(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...body);
const w = (fn) => { const o = new Out(); fn(o); return o.join(); };
const IDENTITY = w((o) => { o.u32(0x10000).u32(0).u32(0).u32(0).u32(0x10000).u32(0).u32(0).u32(0).u32(0x40000000); });

function descr(tag, body) {
  const len = body.length;
  return w((o) => { o.u8(tag).u8(0x80 | ((len >> 21) & 127)).u8(0x80 | ((len >> 14) & 127)).u8(0x80 | ((len >> 7) & 127)).u8(len & 127).bytes(body); });
}

/** mp4a sample entry with esds for an AAC AudioSpecificConfig. */
export function mp4aEntry(asc, channels, sampleRate, bitrate = 128000) {
  const dsi = descr(0x05, asc);
  const dcd = descr(0x04, w((o) => { o.u8(0x40).u8(0x15).u8(0).u16(0).u32(bitrate).u32(bitrate).bytes(dsi); }));
  const es = descr(0x03, w((o) => { o.u16(0).u8(0).bytes(dcd).bytes(descr(0x06, Uint8Array.of(2))); }));
  const esds = full('esds', 0, 0, es);
  return box('mp4a', w((o) => {
    o.zeros(6).u16(1).zeros(8).u16(channels).u16(16).u16(0).u16(0).u32((Math.min(sampleRate, 65535) << 16) >>> 0);
  }), esds);
}

/** Opus sample entry with dOps (preSkip in samples at 48 kHz). */
export function opusEntry(channels, inputRate, preSkip = 312) {
  const dops = box('dOps', w((o) => { o.u8(0).u8(channels).u16(preSkip).u32(inputRate).u16(0).u8(0); }));
  return box('Opus', w((o) => { o.zeros(6).u16(1).zeros(8).u16(channels).u16(16).u16(0).u16(0).u32((48000 << 16) >>> 0); }), dops);
}

function videoEntry(family, width, height, description) {
  const head = w((o) => {
    o.zeros(6).u16(1).zeros(16).u16(width).u16(height).u32(0x480000).u32(0x480000).u32(0).u16(1).zeros(32).u16(0x18).u16(0xffff);
  });
  return family === 'hevc' ? box('hvc1', head, box('hvcC', description)) : box('avc1', head, box('avcC', description));
}

/** Holds encoded data as a growing list of Blobs so large exports page to disk. */
class SpillStore {
  constructor() { this.pending = []; this.pendingBytes = 0; this.blobs = []; this.index = []; }
  add(u8) {
    this.index.push([this.blobs.length, this.pendingBytes, u8.length]);
    this.pending.push(u8);
    this.pendingBytes += u8.length;
    if (this.pendingBytes >= 32 << 20) this.flush();
  }
  flush() {
    if (!this.pending.length) return;
    this.blobs.push(new Blob(this.pending));
    this.pending = [];
    this.pendingBytes = 0;
  }
  slice(i) {
    const [b, off, len] = this.index[i];
    return this.blobs[b].slice(off, off + len);
  }
}

/**
 * MP4 writer for one video track (H.264 or HEVC from VideoEncoder) and an
 * optional audio track. Audio samples are Blobs (e.g. slices of the source
 * File, copied without re-encoding) or Uint8Arrays from AudioEncoder.
 */
export class Mp4Writer {
  /**
   * @param {{family:'avc'|'hevc', width:number, height:number, timescale?:number,
   *          matrix?:Uint8Array, displayWidth?:number, displayHeight?:number}} video
   * @param {{entry:Uint8Array, timescale:number, mediaTime?:number}|null} audio
   */
  constructor(video, audio = null) {
    this.v = { timescale: 90000, ...video };
    this.a = audio;
    this.store = new SpillStore();
    this.vs = []; // {cts (µs), dur (µs), key}
    this.as = []; // {data, dts, dur} in audio timescale
    this.description = null;
  }
  addVideo(chunk, meta) {
    if (meta?.decoderConfig?.description && !this.description) {
      const d = meta.decoderConfig.description;
      this.description = d instanceof Uint8Array ? d.slice() : new Uint8Array(ArrayBuffer.isView(d) ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d.slice(0));
    }
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.store.add(data);
    this.vs.push({ cts: chunk.timestamp, dur: chunk.duration || 0, key: chunk.type === 'key' });
  }
  addAudio(data, dts, dur) { this.as.push({ data, dts, dur }); }

  get videoBytes() { return this.store.index.reduce((a, x) => a + x[2], 0); }

  finalize() {
    if (!this.description) throw new Error('encoder produced no decoder configuration');
    this.store.flush();
    const V = this.v, A = this.a;
    const vts = V.timescale;
    const n = this.vs.length;
    // durations: fill gaps from timestamps, last frame repeats previous
    const toTs = (us) => Math.round((us * vts) / 1e6);
    const cts = this.vs.map((s) => toTs(s.cts));
    const sorted = cts.slice().sort((a, b) => a - b);
    const reordered = cts.some((c, i) => c !== sorted[i]);
    const base = sorted[0] || 0;
    const dts = sorted.map((c) => c - base);
    const vdur = dts.map((d, i) => (i + 1 < n ? dts[i + 1] - d : (toTs(this.vs[i].dur) || (n > 1 ? dts[i] - dts[i - 1] : 3000))));
    const vDurationTs = dts.length ? dts[n - 1] + vdur[n - 1] : 0;

    // interleave by time
    const order = [];
    for (let i = 0; i < n; i++) order.push({ t: (cts[i] - base) / vts, track: 1, i });
    if (A) {
      const mt = A.mediaTime || 0;
      for (let i = 0; i < this.as.length; i++) order.push({ t: (this.as[i].dts - mt) / A.timescale, track: 2, i });
    }
    order.sort((a, b) => a.t - b.t || a.track - b.track);
    const sizeOf = (e) => (e.track === 1 ? this.store.index[e.i][2] : (this.as[e.i].data.size ?? this.as[e.i].data.length));
    let mdatBytes = 0;
    for (const e of order) mdatBytes += sizeOf(e);

    const build = (use64, offsets) => {
      const stco = (list) => (use64
        ? full('co64', 0, 0, w((o) => { o.u32(list.length); for (const x of list) o.u64(x); }))
        : full('stco', 0, 0, w((o) => { o.u32(list.length); for (const x of list) o.u32(x); })));
      const stts = (durs) => {
        const runs = [];
        for (const d of durs) { const last = runs[runs.length - 1]; if (last && last[1] === d) last[0]++; else runs.push([1, d]); }
        return full('stts', 0, 0, w((o) => { o.u32(runs.length); for (const [c, d] of runs) o.u32(c).u32(d); }));
      };
      const stsz = (sizes) => full('stsz', 0, 0, w((o) => { o.u32(0).u32(sizes.length); for (const s of sizes) o.u32(s); }));
      const stsc = full('stsc', 0, 0, w((o) => { o.u32(1).u32(1).u32(1).u32(1); }));
      const dref = box('dinf', full('dref', 0, 0, w((o) => o.u32(1)), full('url ', 0, 1)));
      const movieTs = 1000;
      const vDurMovie = Math.round((vDurationTs / vts) * movieTs);

      const vSizes = this.store.index.map((x) => x[2]);
      const keys = [];
      this.vs.forEach((s, i) => { if (s.key) keys.push(i + 1); });
      const vStbl = [
        full('stsd', 0, 0, w((o) => o.u32(1)), videoEntry(V.family, V.width, V.height, this.description)),
        stts(vdur),
        full('stss', 0, 0, w((o) => { o.u32(keys.length); for (const k of keys) o.u32(k); })),
      ];
      if (reordered) {
        vStbl.push(full('ctts', 1, 0, w((o) => { o.u32(n); for (let i = 0; i < n; i++) o.u32(1).i32(cts[i] - base - dts[i]); })));
      }
      vStbl.push(stsc, stsz(vSizes), stco(offsets.v));
      const mdhd = (ts, dur) => full('mdhd', 1, 0, w((o) => { o.u64(0).u64(0).u32(ts).u64(dur).u16(0x55c4).u16(0); }));
      const hdlr = (type, name) => full('hdlr', 0, 0, w((o) => { o.u32(0).str(type).zeros(12).str(name).u8(0); }));
      const tkhd = (id, dur, vol, matrix, wd, ht) => full('tkhd', 1, 3, w((o) => {
        o.u64(0).u64(0).u32(id).u32(0).u64(dur).zeros(8).u16(0).u16(0).u16(vol).u16(0).bytes(matrix).u32(Math.round(wd * 65536)).u32(Math.round(ht * 65536));
      }));
      const vtrak = box('trak',
        tkhd(1, vDurMovie, 0, V.matrix || IDENTITY, V.displayWidth || V.width, V.displayHeight || V.height),
        box('mdia', mdhd(vts, vDurationTs), hdlr('vide', 'Reefhue video'),
          box('minf', full('vmhd', 0, 1, new Uint8Array(8)), dref, box('stbl', ...vStbl))));
      const traks = [vtrak];
      let aDurMovie = 0;
      if (A && this.as.length) {
        const adur = this.as.map((s) => s.dur);
        const aTotal = adur.reduce((x, y) => x + y, 0);
        const mt = A.mediaTime || 0;
        aDurMovie = Math.round(((aTotal - mt) / A.timescale) * movieTs);
        const kids = [];
        if (mt > 0) {
          kids.push(box('edts', full('elst', 1, 0, w((o) => { o.u32(1).u64(Math.max(0, aDurMovie)).u64(mt).u16(1).u16(0); }))));
        }
        traks.push(box('trak',
          tkhd(2, aDurMovie, 0x0100, IDENTITY, 0, 0), ...kids,
          box('mdia', mdhd(A.timescale, aTotal), hdlr('soun', 'Reefhue audio'),
            box('minf', full('smhd', 0, 0, new Uint8Array(4)), dref,
              box('stbl', full('stsd', 0, 0, w((o) => o.u32(1)), A.entry), stts(adur), stsc,
                stsz(this.as.map((s) => s.data.size ?? s.data.length)), stco(offsets.a))))));
      }
      const mvhd = full('mvhd', 1, 0, w((o) => {
        o.u64(0).u64(0).u32(movieTs).u64(Math.max(vDurMovie, aDurMovie)).u32(0x10000).u16(0x100).zeros(10).bytes(IDENTITY).zeros(24).u32(traks.length + 1);
      }));
      return box('moov', mvhd, ...traks);
    };

    const brands = V.family === 'hevc' ? ['isom', 'iso2', 'mp41'] : ['isom', 'iso2', 'avc1', 'mp41'];
    const ftyp = box('ftyp', w((o) => { o.str('isom').u32(512); for (const b of brands) o.str(b); }));
    const zeroOffsets = { v: new Array(n).fill(0), a: new Array(this.as.length).fill(0) };
    let use64 = false;
    let moov = build(false, zeroOffsets);
    let mdatHdr = mdatBytes + 8 > 0xffffffff ? 16 : 8;
    if (ftyp.length + moov.length + mdatHdr + mdatBytes > 0xffffffff) { use64 = true; moov = build(true, zeroOffsets); }
    let p = ftyp.length + moov.length + mdatHdr;
    const offsets = { v: new Array(n), a: new Array(this.as.length) };
    const parts = [];
    for (const e of order) {
      if (e.track === 1) { offsets.v[e.i] = p; parts.push(this.store.slice(e.i)); } else { offsets.a[e.i] = p; parts.push(this.as[e.i].data); }
      p += sizeOf(e);
    }
    moov = build(use64, offsets);
    const mdat = mdatHdr === 16
      ? w((o) => { o.u32(1).str('mdat').u64(mdatBytes + 16); })
      : w((o) => { o.u32(mdatBytes + 8).str('mdat'); });
    return new Blob([ftyp, moov, mdat, ...parts], { type: 'video/mp4' });
  }
}
