// Photo formats browsers can't open on their own, turned into a JPEG the
// rest of the app can use. No dependencies.
//
// - RAW (ARW, CR2, CR3, NEF, DNG, ORF, RW2, RAF, PEF, SRW…): every camera
//   stores a JPEG preview inside the RAW file. The largest one is used, with
//   the RAW's orientation. Developing the sensor data itself would need a full
//   RAW converter; for many cameras the preview is full size, for some (many
//   Sony models) it is smaller, and the app says so.
// - TIFF: uncompressed, LZW, Deflate or PackBits; 8/16-bit or float; RGB(A)
//   or grey; strips or tiles; chunky or planar.
// - HEIC/HEIF: see heic.js (HEVC tiles decoded with the browser's VideoDecoder).

export const RAW_EXT = /\.(arw|srf|sr2|cr2|cr3|crw|nef|nrw|dng|orf|rw2|raw|rwl|raf|pef|srw|3fr|erf|kdc|dcr|mrw|mef|mos|iiq|x3f)$/i;
const RAW_NAMES = {
  arw: 'Sony ARW', srf: 'Sony SRF', sr2: 'Sony SR2', cr2: 'Canon CR2', cr3: 'Canon CR3', crw: 'Canon CRW', nef: 'Nikon NEF', nrw: 'Nikon NRW',
  dng: 'DNG', orf: 'Olympus ORF', rw2: 'Panasonic RW2', raw: 'RAW', rwl: 'Leica RWL', raf: 'Fujifilm RAF', pef: 'Pentax PEF', srw: 'Samsung SRW',
  '3fr': 'Hasselblad 3FR', erf: 'Epson ERF', kdc: 'Kodak KDC', dcr: 'Kodak DCR', mrw: 'Minolta MRW', mef: 'Mamiya MEF', mos: 'Leaf MOS', iiq: 'Phase One IIQ', x3f: 'Sigma X3F',
};
export const rawName = (name) => RAW_NAMES[(name.match(/\.([^.]+)$/) || [])[1]?.toLowerCase()] || 'RAW';

// ------------------------------------------------------------- TIFF reading
function tiffReader(u8, base = 0) {
  const le = u8[base] === 0x49;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const u16 = (o) => dv.getUint16(base + o, le), u32 = (o) => dv.getUint32(base + o, le);
  const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8 };
  const ifd = (off) => {
    const tags = new Map();
    if (off <= 0 || base + off + 2 > u8.length) return { tags, next: 0 };
    const n = u16(off);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (base + e + 12 > u8.length) break;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      const sz = (SIZE[type] || 1) * count;
      const at = sz <= 4 ? e + 8 : u32(e + 8);
      const vals = [];
      if (base + at + sz <= u8.length && count < 1e7) {
        for (let k = 0; k < count; k++) {
          const p = at + k * (SIZE[type] || 1);
          vals.push(type === 3 ? u16(p) : type === 4 || type === 13 ? u32(p) : type === 11 ? dv.getFloat32(base + p, le) : type === 5 ? u32(p) / (u32(p + 4) || 1) : u8[base + p]);
        }
      }
      tags.set(tag, vals);
    }
    const nextAt = off + 2 + n * 12;
    return { tags, next: base + nextAt + 4 <= u8.length ? u32(nextAt) : 0 };
  };
  return { le, u16, u32, ifd, first: () => u32(4) };
}

export const isTiff = (u8) => u8.length > 8 && ((u8[0] === 0x49 && u8[1] === 0x49) || (u8[0] === 0x4d && u8[1] === 0x4d));

function tiffOrientation(u8) {
  try { return tiffReader(u8).ifd(tiffReader(u8).first()).tags.get(0x112)?.[0] || 1; } catch { return 1; }
}

// ------------------------------------------------------------- JPEG helpers
/** Size of a JPEG starting at `s` if it is a baseline/progressive one: {w, h, end} or null. */
function jpegAt(u8, s) {
  let p = s + 2, w = 0, h = 0;
  const n = u8.length;
  while (p + 4 <= n) {
    if (u8[p] !== 0xff) return null;
    const m = u8[p + 1];
    if (m === 0xff) { p++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
    const len = (u8[p + 2] << 8) | u8[p + 3];
    if (len < 2) return null;
    if (m === 0xc0 || m === 0xc1 || m === 0xc2) { h = (u8[p + 5] << 8) | u8[p + 6]; w = (u8[p + 7] << 8) | u8[p + 8]; }
    else if ((m >= 0xc3 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return null; // lossless/arithmetic: sensor data, not a preview
    if (m === 0xda) {
      if (!w || !h) return null;
      // entropy-coded data never contains FF D9; the first one ends the image
      let q = p + 2 + len;
      for (;;) {
        q = u8.indexOf(0xff, q);
        if (q < 0 || q + 1 >= n) return { w, h, end: n };
        if (u8[q + 1] === 0xd9) return { w, h, end: q + 2 };
        q++;
      }
    }
    p += 2 + len;
  }
  return null;
}

/** The largest embedded baseline JPEG in a file (RAW previews). */
export function largestJpeg(u8) {
  let best = null;
  for (let i = u8.indexOf(0xd8, 1); i > 0; i = u8.indexOf(0xd8, i + 1)) {
    if (u8[i - 1] !== 0xff || u8[i + 1] !== 0xff) continue;
    const j = jpegAt(u8, i - 1);
    if (!j) continue;
    const area = j.w * j.h;
    if (!best || area > best.area || (area === best.area && j.end - i > best.end - best.start)) best = { start: i - 1, end: j.end, w: j.w, h: j.h, area };
    // skip over this JPEG (its own thumbnails are smaller)
    if (j.end > i) i = j.end - 1;
  }
  return best;
}

/** JPEG bytes with an EXIF orientation tag added right after SOI. */
export function withOrientation(jpeg, orientation) {
  const app1 = Uint8Array.from([
    0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // APP1, len 34, "Exif\0\0"
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian TIFF, IFD at 8
    0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // 1 entry: Orientation
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ]);
  const out = new Uint8Array(jpeg.length + app1.length);
  out.set(jpeg.subarray(0, 2));
  out.set(app1, 2);
  out.set(jpeg.subarray(2), 2 + app1.length);
  return out;
}

function jpegOrientation(jpeg) {
  // EXIF APP1 orientation inside a JPEG, 0 when absent
  let p = 2;
  while (p + 4 < jpeg.length && jpeg[p] === 0xff) {
    const m = jpeg[p + 1], len = (jpeg[p + 2] << 8) | jpeg[p + 3];
    if (m === 0xda) break;
    if (m === 0xe1 && jpeg[p + 4] === 0x45 && jpeg[p + 5] === 0x78) {
      try { return tiffReader(jpeg, p + 10).ifd(tiffReader(jpeg, p + 10).first()).tags.get(0x112)?.[0] || 0; } catch { return 0; }
    }
    p += 2 + len;
  }
  return 0;
}

/**
 * RAW: the embedded preview as a JPEG with the right orientation.
 * Resolves {bytes, w, h, note}.
 */
export function rawPreview(u8, name) {
  const best = largestJpeg(u8);
  if (!best || best.w < 160) {
    const err = new Error(`This ${rawName(name)} file has no usable embedded preview. Export it as JPEG from your camera app or editor first.`);
    err.details = `${name} · no baseline JPEG preview found`;
    throw err;
  }
  let jpeg = u8.slice(best.start, best.end);
  const own = jpegOrientation(jpeg);
  const raw = isTiff(u8) ? tiffOrientation(u8) : 1;
  if (!own && raw > 1 && raw <= 8) jpeg = withOrientation(jpeg, raw);
  return { bytes: jpeg, w: best.w, h: best.h, note: `${rawName(name)} · camera preview ${best.w}×${best.h}` };
}

// ------------------------------------------------------------- TIFF decoding
function lzw(src, expected) {
  const out = new Uint8Array(expected);
  let op = 0, bitPos = 0, width = 9;
  const dict = []; // entries as [prefixCode, byte, length]
  const first = new Uint8Array(4096), last = new Uint8Array(4096), prefix = new Int32Array(4096), len = new Int32Array(4096);
  for (let i = 0; i < 256; i++) { first[i] = i; last[i] = i; prefix[i] = -1; len[i] = 1; }
  let next = 258, prev = -1;
  const read = () => {
    let v = 0;
    for (let i = 0; i < width; i++) {
      const byte = src[(bitPos + i) >> 3];
      if (byte === undefined) return 257;
      v = (v << 1) | ((byte >> (7 - ((bitPos + i) & 7))) & 1);
    }
    bitPos += width;
    return v;
  };
  const emit = (code) => {
    const l = len[code];
    let p = op + l - 1;
    for (let c = code; c >= 0 && p >= op; c = prefix[c]) { if (p < expected) out[p] = last[c]; p--; }
    op += l;
  };
  void dict;
  for (;;) {
    const code = read();
    if (code === 257) break;
    if (code === 256) { next = 258; width = 9; prev = -1; continue; }
    if (prev < 0) { emit(code); prev = code; if (op >= expected) break; continue; }
    if (code < next) {
      emit(code);
      if (next < 4096) { prefix[next] = prev; last[next] = first[code]; first[next] = first[prev]; len[next] = len[prev] + 1; next++; }
    } else {
      if (next < 4096) { prefix[next] = prev; last[next] = first[prev]; first[next] = first[prev]; len[next] = len[prev] + 1; next++; }
      emit(next - 1);
    }
    prev = code;
    if (op >= expected) break;
    if (next + 1 >= (1 << width) && width < 12) width++;
  }
  return out;
}

function packbits(src, expected) {
  const out = new Uint8Array(expected);
  let i = 0, o = 0;
  while (i < src.length && o < expected) {
    const n = (src[i++] << 24) >> 24;
    if (n >= 0) { out.set(src.subarray(i, i + n + 1), o); o += n + 1; i += n + 1; }
    else if (n !== -128) { out.fill(src[i++], o, o - n + 1); o += -n + 1; }
  }
  return out;
}

async function inflate(src) {
  const ds = new DecompressionStream('deflate');
  const buf = await new Response(new Blob([src]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(buf);
}

/** Decode a TIFF to a JPEG (bytes) the app can use. Resolves {bytes, w, h, note}. */
export async function tiffToJpeg(u8, name) {
  const t = tiffReader(u8);
  // the largest image in the IFD chain (some files lead with a thumbnail)
  let pick = null;
  for (let off = t.first(), guard = 0; off && guard < 16; guard++) {
    const { tags, next } = t.ifd(off);
    const w = tags.get(256)?.[0] || 0, h = tags.get(257)?.[0] || 0;
    if (w * h > (pick ? pick.w * pick.h : 0)) pick = { tags, w, h };
    off = next;
  }
  if (!pick) throw new Error('This TIFF has no image.');
  const g = (tag, d) => pick.tags.get(tag) ?? d;
  const { w, h } = pick;
  const comp = g(259, [1])[0], photo = g(262, [2])[0], spp = g(277, [1])[0];
  const bps = g(258, [8])[0], fmt = g(339, [1])[0], planar = g(284, [1])[0], pred = g(317, [1])[0];
  const orient = g(274, [1])[0];
  const unsupported = (why) => { const e = new Error(`This TIFF can't be opened here (${why}). Save it as JPEG or 8/16-bit RGB TIFF.`); e.details = `${name} · ${w}×${h} · compression ${comp} · photometric ${photo} · ${spp}×${bps} bit`; return e; };
  if (![1, 5, 8, 32946, 32773].includes(comp)) throw unsupported(comp === 7 ? 'JPEG-compressed' : `compression ${comp}`);
  if (![0, 1, 2].includes(photo)) throw unsupported(photo === 3 ? 'palette colours' : photo === 5 ? 'CMYK' : `colour type ${photo}`);
  if (![8, 16, 32].includes(bps) || (bps === 32 && fmt !== 3)) throw unsupported(`${bps}-bit`);
  const tiled = pick.tags.has(322);
  const tw = tiled ? g(322)[0] : w, th = tiled ? g(323)[0] : (g(278, [h])[0] || h);
  const offsets = tiled ? g(324) : g(273), counts = tiled ? g(325) : g(279);
  if (!offsets?.length) throw unsupported('no image data');
  const bpsB = bps / 8, planes = planar === 2 ? spp : 1, chunkSpp = planar === 2 ? 1 : spp;
  const across = Math.ceil(w / tw), down = Math.ceil(h / th);
  const rgba = new Uint8ClampedArray(w * h * 4);
  if (spp < 3 || photo !== 2) for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  else if (spp === 3) for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  const dvLE = t.le;
  for (let plane = 0; plane < planes; plane++) {
    for (let ty = 0; ty < down; ty++) {
      for (let tx = 0; tx < across; tx++) {
        const idx = plane * across * down + ty * across + tx;
        const off = offsets[idx], cnt = counts?.[idx] ?? (u8.length - off);
        const rows = tiled ? th : Math.min(th, h - ty * th);
        const expected = tw * rows * chunkSpp * bpsB;
        let raw = u8.subarray(off, off + cnt);
        if (comp === 5) raw = lzw(raw, expected);
        else if (comp === 8 || comp === 32946) raw = await inflate(raw);
        else if (comp === 32773) raw = packbits(raw, expected);
        const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        const sample = (i) => (bps === 8 ? raw[i] : bps === 16 ? dv.getUint16(i * 2, dvLE) / 257 : dv.getFloat32(i * 4, dvLE) * 255);
        if (pred === 2 && bps !== 32) {
          // horizontal differencing, undone in place on whole samples
          for (let y = 0; y < rows; y++) {
            for (let x = 1; x < tw; x++) {
              for (let c = 0; c < chunkSpp; c++) {
                const i = (y * tw + x) * chunkSpp + c, j = i - chunkSpp;
                if (bps === 8) raw[i] = (raw[i] + raw[j]) & 255;
                else if (i * 2 + 1 < raw.length) dv.setUint16(i * 2, (dv.getUint16(i * 2, dvLE) + dv.getUint16(j * 2, dvLE)) & 0xffff, dvLE);
              }
            }
          }
        }
        for (let y = 0; y < rows; y++) {
          const Y = ty * th + y;
          if (Y >= h) break;
          for (let x = 0; x < tw; x++) {
            const X = tx * tw + x;
            if (X >= w) break;
            const s = (y * tw + x) * chunkSpp, o = (Y * w + X) * 4;
            if (photo === 2) {
              if (planar === 2) { if (plane < 4) rgba[o + plane] = sample(s); }
              else { rgba[o] = sample(s); rgba[o + 1] = sample(s + 1); rgba[o + 2] = sample(s + 2); if (spp > 3) rgba[o + 3] = sample(s + 3); }
            } else {
              let v = sample(s); if (photo === 0) v = 255 - v;
              if (plane === 0) { rgba[o] = rgba[o + 1] = rgba[o + 2] = v; }
            }
          }
        }
      }
    }
  }
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
  let bytes = new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.97 })).arrayBuffer());
  if (orient > 1 && orient <= 8) bytes = withOrientation(bytes, orient);
  const depth = bps === 16 ? '16-bit' : bps === 32 ? 'float' : '8-bit';
  return { bytes, w, h, note: `TIFF ${depth}` };
}
