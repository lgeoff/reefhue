// Minimal ZIP writer (stored, no compression: photos and videos are already
// compressed). Streams CRC-32 over Blobs, switches to ZIP64 when needed, and
// returns one Blob built from slices, so nothing is copied into memory twice.

const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c >>> 0;
}

async function crc32(blob, onBytes) {
  let c = 0xffffffff;
  const reader = blob.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (let i = 0; i < value.length; i++) c = CRC[(c ^ value[i]) & 255] ^ (c >>> 8);
    onBytes?.(value.length);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const te = new TextEncoder();

function le(size) {
  const b = new Uint8Array(size);
  const dv = new DataView(b.buffer);
  let o = 0;
  const api = {
    u16(v) { dv.setUint16(o, v, true); o += 2; return api; },
    u32(v) { dv.setUint32(o, v >>> 0, true); o += 4; return api; },
    u64(v) { dv.setBigUint64(o, BigInt(v), true); o += 8; return api; },
    bytes(x) { b.set(x, o); o += x.length; return api; },
    done() { return b; },
  };
  return api;
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Unique, safe names inside the archive. */
function uniqueNames(names) {
  const seen = new Map();
  return names.map((n) => {
    const clean = n.replace(/[\\/:*?"<>|]+/g, '_');
    const k = clean.toLowerCase();
    const c = seen.get(k) || 0;
    seen.set(k, c + 1);
    if (!c) return clean;
    const dot = clean.lastIndexOf('.');
    return dot > 0 ? `${clean.slice(0, dot)} (${c + 1})${clean.slice(dot)}` : `${clean} (${c + 1})`;
  });
}

/**
 * @param {{name:string, blob:Blob}[]} files
 * @param {(fraction:number)=>void} [onProgress]
 * @returns {Promise<Blob>}
 */
export async function makeZip(files, onProgress) {
  const total = files.reduce((a, f) => a + f.blob.size, 0) || 1;
  let done = 0;
  const names = uniqueNames(files.map((f) => f.name));
  const { time, date } = dosTime(new Date());
  const parts = [];
  const central = [];
  let offset = 0;
  for (let i = 0; i < files.length; i++) {
    const { blob } = files[i];
    const name = te.encode(names[i]);
    const crc = await crc32(blob, (n) => { done += n; onProgress?.(done / total); });
    const size = blob.size;
    const big = size >= 0xffffffff || offset >= 0xffffffff;
    const extraLocal = big ? le(20).u16(1).u16(16).u64(size).u64(size).done() : new Uint8Array(0);
    const local = le(30 + name.length + extraLocal.length)
      .u32(0x04034b50).u16(big ? 45 : 20).u16(0x0800).u16(0).u16(time).u16(date).u32(crc)
      .u32(big ? 0xffffffff : size).u32(big ? 0xffffffff : size).u16(name.length).u16(extraLocal.length)
      .bytes(name).bytes(extraLocal).done();
    const extraCentral = big ? le(28).u16(1).u16(24).u64(size).u64(size).u64(offset).done() : new Uint8Array(0);
    central.push(le(46 + name.length + extraCentral.length)
      .u32(0x02014b50).u16(big ? 45 : 20).u16(big ? 45 : 20).u16(0x0800).u16(0).u16(time).u16(date).u32(crc)
      .u32(big ? 0xffffffff : size).u32(big ? 0xffffffff : size).u16(name.length).u16(extraCentral.length)
      .u16(0).u16(0).u16(0).u32(0).u32(big ? 0xffffffff : offset).bytes(name).bytes(extraCentral).done());
    parts.push(local, blob);
    offset += local.length + size;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const cdOffset = offset;
  const need64 = cdOffset >= 0xffffffff || files.length >= 0xffff;
  const tail = [];
  if (need64) {
    tail.push(le(56).u32(0x06064b50).u64(44).u16(45).u16(45).u32(0).u32(0)
      .u64(files.length).u64(files.length).u64(cdSize).u64(cdOffset).done());
    tail.push(le(20).u32(0x07064b50).u32(0).u64(cdOffset + cdSize).u32(1).done());
  }
  tail.push(le(22).u32(0x06054b50).u16(0).u16(0)
    .u16(need64 ? 0xffff : files.length).u16(need64 ? 0xffff : files.length)
    .u32(cdSize).u32(need64 ? 0xffffffff : cdOffset).u16(0).done());
  return new Blob([...parts, ...central, ...tail], { type: 'application/zip' });
}
