// MPEG transport streams (.MTS/.M2TS from AVCHD camcorders and compacts, .TS)
// to MP4, in the browser, without re-encoding.
//
// Browsers can't play transport streams, so the H.264 video is repackaged
// into an MP4 (the same muxer the exporter uses). Everything downstream then
// treats the clip like any MP4. AAC sound is kept; AC-3, LPCM and MPEG audio
// (AVCHD usually records AC-3) can't be decoded by browsers and are left out.

import { Mp4Writer, mp4aEntry } from './mp4.js';

const STREAM = {
  0x1b: 'h264', 0x24: 'hevc', 0x0f: 'aac', 0x11: 'aac-latm', 0x81: 'AC-3', 0x87: 'E-AC-3',
  0x80: 'LPCM', 0x03: 'MPEG audio', 0x04: 'MPEG audio', 0x02: 'mpeg2', 0x01: 'mpeg1',
};

/** True when the bytes look like a transport stream (188- or 192-byte packets). */
export function sniffTs(u8) {
  for (const [stride, off] of [[188, 0], [192, 4]]) {
    let ok = u8.length >= off + stride * 3;
    for (let i = 0; ok && i < 4 && off + i * stride < u8.length; i++) ok = u8[off + i * stride] === 0x47;
    if (ok) return { stride, off };
  }
  return null;
}

// ---------------------------------------------------------------- H.264 bits
function unescape(nal) {
  const out = new Uint8Array(nal.length);
  let n = 0, zeros = 0;
  for (let i = 0; i < nal.length; i++) {
    const b = nal[i];
    if (zeros >= 2 && b === 3) { zeros = 0; continue; }
    zeros = b === 0 ? zeros + 1 : 0;
    out[n++] = b;
  }
  return out.subarray(0, n);
}

class Bits {
  constructor(u8) { this.u8 = u8; this.p = 0; }
  bit() { const v = (this.u8[this.p >> 3] >> (7 - (this.p & 7))) & 1; this.p++; return v; }
  u(n) { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + this.bit(); return v; }
  ue() { let z = 0; while (this.bit() === 0 && z < 32) z++; return z ? (2 ** z - 1 + this.u(z)) : 0; }
  se() { const k = this.ue(); return k & 1 ? (k + 1) / 2 : -k / 2; }
}

const SAR = [[1, 1], [1, 1], [12, 11], [10, 11], [16, 11], [40, 33], [24, 11], [20, 11], [32, 11], [80, 33], [18, 11], [15, 11], [64, 33], [160, 99], [4, 3], [3, 2], [2, 1]];

/** Picture size and pixel aspect from an H.264 SPS NAL (with its header byte). */
export function parseSps(nal) {
  const b = new Bits(unescape(nal.subarray(1)));
  const profile = b.u(8); b.u(8); b.u(8); b.ue();
  let chroma = 1;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chroma = b.ue();
    if (chroma === 3) b.bit();
    b.ue(); b.ue(); b.bit();
    if (b.bit()) {
      for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
        if (!b.bit()) continue;
        let last = 8, next = 8;
        for (let j = 0; j < (i < 6 ? 16 : 64); j++) { if (next) next = (last + b.se() + 256) % 256; last = next || last; }
      }
    }
  }
  b.ue();
  const poc = b.ue();
  if (poc === 0) b.ue();
  else if (poc === 1) { b.bit(); b.se(); b.se(); const n = b.ue(); for (let i = 0; i < n; i++) b.se(); }
  b.ue(); b.bit();
  const mbw = b.ue() + 1, mbh = b.ue() + 1;
  const frameMbsOnly = b.bit();
  if (!frameMbsOnly) b.bit();
  b.bit();
  let cl = 0, cr = 0, ct = 0, cb = 0;
  if (b.bit()) { cl = b.ue(); cr = b.ue(); ct = b.ue(); cb = b.ue(); }
  const cx = chroma === 0 || chroma === 3 ? 1 : 2, cy = (chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
  const width = mbw * 16 - (cl + cr) * cx;
  const height = (2 - frameMbsOnly) * mbh * 16 - (ct + cb) * cy;
  let sar = [1, 1];
  if (b.bit() && b.bit()) { // VUI with aspect ratio info
    const idc = b.u(8);
    sar = idc === 255 ? [b.u(16), b.u(16)] : SAR[idc] || [1, 1];
  }
  return { profile, width, height, interlaced: !frameMbsOnly, sar };
}

function sliceIsIntra(nal) {
  const b = new Bits(unescape(nal.subarray(1, 12)));
  b.ue();
  return b.ue() % 5 === 2;
}

/** Split an Annex B access unit into NAL units. */
function nals(u8) {
  const out = [];
  let i = 0, start = -1;
  const n = u8.length;
  while (i + 2 < n) {
    if (u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 1) {
      if (start >= 0) { let e = i; while (e > start && u8[e - 1] === 0) e--; out.push(u8.subarray(start, e)); }
      i += 3; start = i;
    } else i++;
  }
  if (start >= 0 && start < n) out.push(u8.subarray(start));
  return out;
}

function avcC(sps, pps) {
  const out = new Uint8Array(11 + sps.length + pps.length);
  out.set([1, sps[1], sps[2], sps[3], 0xff, 0xe1, sps.length >> 8, sps.length & 255]);
  out.set(sps, 8);
  let p = 8 + sps.length;
  out.set([1, pps.length >> 8, pps.length & 255], p);
  out.set(pps, p + 3);
  return out;
}

// ---------------------------------------------------------------- demux
function readPts(u8, p) {
  return (((u8[p] >> 1) & 7) * 2 ** 30) + (((u8[p + 1] << 8 | u8[p + 2]) >> 1) * 2 ** 15) + ((u8[p + 3] << 8 | u8[p + 4]) >> 1);
}

/**
 * Repackage a transport stream as MP4.
 * Resolves {file, width, height, frames, seconds, audio, droppedAudio, interlaced}.
 */
export async function transmuxTs(file, { onProgress } = {}) {
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  const fmt = sniffTs(head);
  if (!fmt) throw new Error('This file is not an MPEG transport stream.');
  const { stride, off } = fmt;

  let pmtPid = -1, videoPid = -1, audioPid = -1, videoType = '', audioType = '';
  const otherAudio = new Set();
  const pes = new Map(); // pid -> [chunks]
  const au = []; // video access units {pts, dts, nals}
  let sps = null, pps = null, info = null;
  const audioFrames = []; // {pts90, data}
  let asc = null, aRate = 0, aCh = 0;

  const handlePes = (pid, parts) => {
    let len = 0;
    for (const p of parts) len += p.length;
    const u8 = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { u8.set(p, o); o += p.length; }
    if (u8.length < 9 || u8[0] !== 0 || u8[1] !== 0 || u8[2] !== 1) return;
    const flags = u8[7], hlen = u8[8];
    const pts = flags & 0x80 ? readPts(u8, 9) : null;
    const dts = (flags & 0xc0) === 0xc0 ? readPts(u8, 14) : pts;
    const payload = u8.subarray(9 + hlen);
    if (pid === videoPid) au.push({ pts, dts, data: payload });
    else if (pid === audioPid) {
      // ADTS frames
      let p = 0, k = 0;
      while (p + 7 <= payload.length) {
        if (payload[p] !== 0xff || (payload[p + 1] & 0xf0) !== 0xf0) { p++; continue; }
        const crc = !(payload[p + 1] & 1);
        const prof = (payload[p + 2] >> 6) & 3, sfi = (payload[p + 2] >> 2) & 15;
        const ch = ((payload[p + 2] & 1) << 2) | (payload[p + 3] >> 6);
        const flen = ((payload[p + 3] & 3) << 11) | (payload[p + 4] << 3) | (payload[p + 5] >> 5);
        if (flen < 7 || p + flen > payload.length) break;
        const rate = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350][sfi];
        if (!asc) {
          asc = Uint8Array.of(((prof + 1) << 3) | (sfi >> 1), ((sfi & 1) << 7) | (ch << 3));
          aRate = rate; aCh = ch || 2;
        }
        if (pts !== null) audioFrames.push({ pts90: pts + Math.round((k * 1024 * 90000) / rate), data: payload.slice(p + (crc ? 9 : 7), p + flen) });
        p += flen; k++;
      }
    }
  };

  const section = (payload, pusi) => (pusi ? payload.subarray(1 + payload[0]) : payload);
  const CHUNK = (4 << 20) - ((4 << 20) % stride);
  let pos = 0;
  const total = file.size;
  while (pos < total) {
    const buf = new Uint8Array(await file.slice(pos, Math.min(total, pos + CHUNK)).arrayBuffer());
    for (let p = off; p + 188 <= buf.length; p += stride) {
      if (buf[p] !== 0x47) continue;
      const pusi = (buf[p + 1] & 0x40) !== 0;
      const pid = ((buf[p + 1] & 0x1f) << 8) | buf[p + 2];
      const afc = (buf[p + 3] >> 4) & 3;
      let q = p + 4;
      if (afc & 2) q += 1 + buf[q];
      if (!(afc & 1) || q >= p + 188) continue;
      const payload = buf.subarray(q, p + 188);
      if (pid === 0 && pmtPid < 0) {
        const s = section(payload, pusi);
        const slen = ((s[1] & 15) << 8) | s[2];
        for (let i = 8; i + 4 <= 3 + slen - 4; i += 4) {
          const prog = (s[i] << 8) | s[i + 1];
          if (prog !== 0) { pmtPid = ((s[i + 2] & 0x1f) << 8) | s[i + 3]; break; }
        }
      } else if (pid === pmtPid && videoPid < 0) {
        const s = section(payload, pusi);
        const slen = ((s[1] & 15) << 8) | s[2];
        const pil = ((s[10] & 15) << 8) | s[11];
        for (let i = 12 + pil; i + 5 <= 3 + slen - 4;) {
          const type = s[i], epid = ((s[i + 1] & 0x1f) << 8) | s[i + 2], eil = ((s[i + 3] & 15) << 8) | s[i + 4];
          let name = STREAM[type];
          if (type === 0x06) { // private data: AC-3 / E-AC-3 descriptors in DVB streams
            for (let d = i + 5; d < i + 5 + eil; d += 2 + s[d + 1]) { if (s[d] === 0x6a) name = 'AC-3'; if (s[d] === 0x7a) name = 'E-AC-3'; }
          }
          if (name === 'h264' || name === 'hevc' || name === 'mpeg2' || name === 'mpeg1') { if (videoPid < 0) { videoPid = epid; videoType = name; } }
          else if (name === 'aac') { if (audioPid < 0) { audioPid = epid; audioType = name; } }
          else if (name) otherAudio.add(name);
          i += 5 + eil;
        }
        if (videoType && videoType !== 'h264') {
          const what = { hevc: 'HEVC (H.265)', mpeg2: 'MPEG-2', mpeg1: 'MPEG-1' }[videoType];
          throw new Error(`This clip's video is ${what}; only H.264 transport streams can be opened so far.`);
        }
      } else if (pid === videoPid || pid === audioPid) {
        if (pusi) { const prev = pes.get(pid); if (prev?.length) handlePes(pid, prev); pes.set(pid, [payload.slice()]); }
        else pes.get(pid)?.push(payload.slice());
      }
    }
    pos += buf.length;
    onProgress?.(Math.min(1, pos / total) * 0.9);
  }
  for (const [pid, parts] of pes) if (parts.length) handlePes(pid, parts);
  if (videoPid < 0 || !au.length) throw new Error('No H.264 video was found in this transport stream.');

  // access units -> MP4 samples (AVCC), starting at the first key frame
  let anyIdr = false;
  const samples = [];
  for (const a of au) {
    const list = nals(a.data);
    const keep = [];
    let idr = false, intra = false;
    for (const n of list) {
      const t = n[0] & 31;
      if (t === 7) { if (!sps) { sps = n.slice(); info = parseSps(sps); } continue; }
      if (t === 8) { if (!pps) pps = n.slice(); continue; }
      if (t === 9 || t === 12) continue;
      if (t === 5) idr = true;
      if (t === 1 && !intra && n.length > 2) { try { intra = sliceIsIntra(n); } catch { /* short slice */ } }
      keep.push(n);
    }
    if (!keep.length) continue;
    anyIdr ||= idr;
    samples.push({ pts: a.pts, dts: a.dts, keep, idr, intra });
  }
  if (!sps || !pps) throw new Error('The video stream has no H.264 parameter sets.');
  const isKey = (s) => s.idr || (!anyIdr && s.intra);
  const first = samples.findIndex(isKey);
  if (first < 0) throw new Error('No key frame was found in this clip.');

  // unwrap the 33-bit 90 kHz clock
  let lastPts = null, wrap = 0;
  const unwrap = (t) => {
    if (t === null) return null;
    if (lastPts !== null && t + wrap < lastPts - 2 ** 32) wrap += 2 ** 33;
    const v = t + wrap; lastPts = v; return v;
  };
  for (const s of samples) s.pts = unwrap(s.pts);

  const sarW = info.sar[0] / info.sar[1];
  const writer = new Mp4Writer({
    family: 'avc', width: info.width, height: info.height,
    displayWidth: Math.round(info.width * sarW), displayHeight: info.height,
  }, asc ? { entry: mp4aEntry(asc, aCh, aRate), timescale: aRate } : null);
  const description = avcC(sps, pps);
  let prevPts = 0, minPts = Infinity;
  for (let i = first; i < samples.length; i++) {
    const s = samples[i];
    const size = s.keep.reduce((a, n) => a + 4 + n.length, 0);
    const data = new Uint8Array(size);
    let p = 0;
    for (const n of s.keep) { new DataView(data.buffer).setUint32(p, n.length); data.set(n, p + 4); p += 4 + n.length; }
    const pts = s.pts ?? prevPts + 3600;
    prevPts = pts;
    minPts = Math.min(minPts, pts);
    writer.addVideo({ byteLength: size, copyTo: (dst) => dst.set(data), timestamp: (pts * 1e6) / 90000, duration: 0, type: isKey(s) ? 'key' : 'delta' },
      i === first ? { decoderConfig: { description } } : undefined);
  }
  if (asc) {
    for (const f of audioFrames) {
      const t = unwrapAudio(f.pts90, minPts);
      if (t < 0) continue;
      writer.addAudio(f.data, Math.round((t * aRate) / 90000), 1024);
    }
  }
  onProgress?.(1);
  const blob = writer.finalize();
  const frames = samples.length - first;
  const name = file.name.replace(/\.[^.]+$/, '') + '.mp4';
  return {
    file: new File([blob], name, { type: 'video/mp4', lastModified: file.lastModified }),
    width: info.width, height: info.height, interlaced: info.interlaced, frames,
    audio: asc ? 'AAC' : null,
    droppedAudio: [...otherAudio].join(', ') || null,
  };
}

// audio PTS relative to the first video frame, tolerating a clock wrap
function unwrapAudio(pts90, videoStart) {
  let t = pts90 - (videoStart % 2 ** 33);
  if (t < -(2 ** 32)) t += 2 ** 33;
  return t;
}
