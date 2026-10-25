// Robust photo loading.
//
// Mobile browsers fail on photos in ways desktops don't: files picked through
// Android's file browser come from a content provider that may not like
// repeated or concurrent reads, and full-size decodes of 50–200 MP photos run
// out of memory. So photos are read into memory once, their header is parsed
// (format, size, EXIF orientation) without decoding, previews are decoded
// already downscaled, and decoding falls back to <img> when
// createImageBitmap refuses a file. Failures carry a readable diagnosis.

import { RAW_EXT, rawPreview, tiffToJpeg } from './formats.js';
import { heicToJpeg } from './heic.js';

const ORIENT_SWAPS = new Set([5, 6, 7, 8]);

/** Format, pixel size and EXIF orientation from the first bytes of a photo. */
export function sniffImage(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const ascii = (o, n) => String.fromCharCode(...u8.subarray(o, o + n));
  const out = { format: 'unknown', w: 0, h: 0, orientation: 1 };
  if (u8.length < 12) return out;
  if (u8[0] === 0xff && u8[1] === 0xd8) {
    out.format = 'JPEG';
    let o = 2;
    while (o + 4 <= u8.length) {
      if (u8[o] !== 0xff) { o++; continue; }
      const m = u8[o + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
      if (m === 0xd9 || m === 0xda) break;
      const len = dv.getUint16(o + 2);
      if (m === 0xe1 && ascii(o + 4, 4) === 'Exif') out.orientation = exifOrientation(u8, o + 10) || 1;
      if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) {
        if (o + 9 <= u8.length) { out.h = dv.getUint16(o + 5); out.w = dv.getUint16(o + 7); }
        break;
      }
      o += 2 + len;
    }
  } else if ((ascii(0, 4) === 'II*\0' || ascii(0, 4) === 'MM\0*')) {
    out.format = 'TIFF';
  } else if (ascii(0, 4) === 'IIRO' || ascii(0, 4) === 'IIRS' || ascii(0, 4) === 'MMOR') {
    out.format = 'ORF';
  } else if (ascii(0, 4) === 'IIU\0') {
    out.format = 'RW2';
  } else if (ascii(0, 15) === 'FUJIFILMCCD-RAW') {
    out.format = 'RAF';
  } else if (ascii(4, 4) === 'ftyp' && ascii(8, 4) === 'crx ') {
    out.format = 'CR3';
  } else if (ascii(1, 3) === 'PNG') {
    out.format = 'PNG'; out.w = dv.getUint32(16); out.h = dv.getUint32(20);
  } else if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    out.format = 'WebP';
    const chunk = ascii(12, 4);
    if (chunk === 'VP8X') { out.w = 1 + (u8[24] | (u8[25] << 8) | (u8[26] << 16)); out.h = 1 + (u8[27] | (u8[28] << 8) | (u8[29] << 16)); }
    else if (chunk === 'VP8 ') { out.w = dv.getUint16(26, true) & 0x3fff; out.h = dv.getUint16(28, true) & 0x3fff; }
    else if (chunk === 'VP8L') { const b = dv.getUint32(21, true); out.w = (b & 0x3fff) + 1; out.h = ((b >> 14) & 0x3fff) + 1; }
  } else if (ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    out.format = /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(brand) ? 'HEIC' : /^avi[fs]$/.test(brand) ? 'AVIF' : `ISO-BMFF (${brand})`;
  } else if (ascii(0, 3) === 'GIF') {
    out.format = 'GIF'; out.w = dv.getUint16(6, true); out.h = dv.getUint16(8, true);
  } else if (u8[0] === 0x42 && u8[1] === 0x4d) {
    out.format = 'BMP';
  }
  if (ORIENT_SWAPS.has(out.orientation)) [out.w, out.h] = [out.h, out.w];
  return out;
}

function exifOrientation(u8, tiff) {
  if (tiff + 8 > u8.length) return 0;
  const le = u8[tiff] === 0x49;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const u16 = (o) => dv.getUint16(tiff + o, le);
  const u32 = (o) => dv.getUint32(tiff + o, le);
  const ifd = u32(4);
  if (tiff + ifd + 2 > u8.length) return 0;
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (tiff + e + 12 > u8.length) break;
    if (u16(e) === 0x0112) return u16(e + 8);
  }
  return 0;
}

const fmtSize = (b) => `${(b / 1e6).toFixed(1)} MB`;
const errText = (e) => `${e?.name || 'Error'}: ${e?.message || e}`;

/**
 * Read a picked photo into memory once and describe it. Resolves
 * {file, info} where `file` is an in-memory File (safe to read many times)
 * and info = {format, w, h, orientation, size, type}.
 */
export async function loadPhotoFile(file) {
  // Android can rewrite a photo while handing it over (e.g. stripping location
  // data), so the browser sees it as changed since it was picked and refuses
  // to read it (NotReadableError). Retry a few times, through different
  // readers, in case it is momentary.
  const readers = [
    () => file.arrayBuffer(),
    () => new Response(file).arrayBuffer(),
    () => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsArrayBuffer(file); }),
  ];
  const waits = [0, 250, 700, 1500];
  let buf, last;
  const attempts = [];
  for (let i = 0; i < waits.length && !buf; i++) {
    if (waits[i]) await new Promise((r) => setTimeout(r, waits[i]));
    try { buf = await readers[i % readers.length](); } catch (e) { last = e; attempts.push(errText(e)); }
  }
  if (!buf) {
    const e = last;
    const repick = e?.name === 'NotReadableError';
    const err = new Error(repick
      ? 'Android didn’t hand this photo over properly. Pick the same photo again: the second time works.'
      : `The file could not be read (${errText(e)}). If it is in a cloud folder, save it to the phone first.`);
    err.repick = repick;
    err.details = `${file.name} · ${fmtSize(file.size)} · ${file.type || 'no type'} · modified ${new Date(file.lastModified).toISOString()} · ${attempts.length} read attempts: ${attempts.join(' | ')}`;
    throw err;
  }
  let u8 = new Uint8Array(buf);
  const size = u8.length;
  let note = '';
  // formats browsers can't decode become a JPEG here
  const conv = await convertPhoto(u8, file.name);
  if (conv) { u8 = conv.bytes; note = conv.note; }
  const info = { ...sniffImage(u8.subarray(0, Math.min(u8.length, 512 * 1024))), size, type: file.type, note };
  const type = { JPEG: 'image/jpeg', PNG: 'image/png', WebP: 'image/webp', GIF: 'image/gif', HEIC: 'image/heic', AVIF: 'image/avif' }[info.format] || file.type || 'application/octet-stream';
  return { file: new File([u8], file.name, { type, lastModified: file.lastModified }), info };
}

/** RAW, TIFF (and HEIC) to JPEG; null for formats the browser decodes itself. */
async function convertPhoto(u8, name) {
  const head = sniffImage(u8.subarray(0, Math.min(u8.length, 64 * 1024)));
  const raw = RAW_EXT.test(name) || /^(CR3|RAF|ORF|RW2)$/.test(head.format);
  if (raw) return rawPreview(u8, name);
  if (head.format === 'TIFF') {
    try { return await tiffToJpeg(u8, name); } catch (e) {
      // an unknown RAW flavour is TIFF-shaped too: fall back to its preview
      // (never for real .tif files, whose JPEG strips are not previews)
      if (/\.tiff?$/i.test(name)) throw e;
      try { return rawPreview(u8, name); } catch { throw e; }
    }
  }
  if (head.format === 'HEIC') return heicToJpeg(u8, name);
  return null;
}

export function describe(info, name) {
  const dims = info.w ? ` ${info.w}×${info.h}` : '';
  const rot = info.orientation > 1 ? ` · EXIF orientation ${info.orientation}` : '';
  return `${name} · ${info.format}${dims} · ${fmtSize(info.size)} · type "${info.type || 'none'}"${rot}`;
}

/** Target size for a decode capped at `maxEdge` px (and/or `maxPixels`). */
function target(info, maxEdge, maxPixels) {
  if (!info.w || !info.h) return null;
  let k = 1;
  if (maxEdge) k = Math.min(k, maxEdge / Math.max(info.w, info.h));
  if (maxPixels) k = Math.min(k, Math.sqrt(maxPixels / (info.w * info.h)));
  if (k >= 1) return null;
  return { w: Math.max(1, Math.round(info.w * k)), h: Math.max(1, Math.round(info.h * k)) };
}

/** Draw an <img> (decoded by the browser's regular image pipeline) into a canvas. */
async function decodeWithImg(file, t) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const w = t ? t.w : img.naturalWidth, h = t ? t.h : img.naturalHeight;
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return c.transferToImageBitmap ? c.transferToImageBitmap() : c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Decode a photo, optionally downscaled (`maxEdge` px or `maxPixels`), with
 * EXIF orientation applied. Tries several decoders; throws an Error whose
 * `details` lists every attempt.
 */
export async function decodePhoto(file, info, { maxEdge = 0, maxPixels = 0 } = {}) {
  const t = target(info, maxEdge, maxPixels);
  const attempts = [];
  const tries = [
    ['createImageBitmap', () => createImageBitmap(file, { imageOrientation: 'from-image', ...(t ? { resizeWidth: t.w, resizeHeight: t.h, resizeQuality: 'high' } : {}) })],
    ['createImageBitmap (plain)', async () => {
      const b = await createImageBitmap(file);
      if (!t) return b;
      const r = await createImageBitmap(b, { resizeWidth: t.w, resizeHeight: t.h, resizeQuality: 'high' });
      b.close?.();
      return r;
    }],
    ['<img>', () => decodeWithImg(file, t)],
  ];
  for (const [name, fn] of tries) {
    try {
      const bmp = await fn();
      if (bmp && bmp.width && bmp.height) return bmp;
      attempts.push(`${name}: empty result`);
    } catch (e) {
      attempts.push(`${name}: ${errText(e)}`);
    }
  }
  const unsupported = info.format === 'HEIC' ? 'HEIC photos cannot be decoded by this browser. Save or share the photo as JPEG.'
    : info.format === 'AVIF' ? 'This browser cannot decode AVIF photos.'
      : info.format === 'unknown' ? 'This file does not look like a photo.'
        : 'This browser could not decode the photo.';
  const err = new Error(unsupported);
  err.details = attempts.join(' | ');
  throw err;
}

/**
 * Full-resolution decode for export, stepping down when the device runs out
 * of memory. Resolves {bitmap, scaled} (scaled = true when not full size).
 */
export async function decodeForExport(file, info) {
  const ladder = [0, 50e6, 24e6, 12e6];
  let last;
  for (const maxPixels of ladder) {
    if (maxPixels && info.w && info.w * info.h <= maxPixels) continue;
    try {
      const bitmap = await decodePhoto(file, info, { maxPixels });
      return { bitmap, scaled: !!maxPixels };
    } catch (e) { last = e; }
  }
  throw last;
}
