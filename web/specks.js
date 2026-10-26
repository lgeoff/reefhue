// Backscatter removal driver. Detection runs once on the half-resolution
// brightness of the colour-corrected photo; filling runs in bands of the
// full-size image, each read with a margin so specks that cross a band edge
// are filled the same way on both sides. Bands only ever write their own
// rows, and filling only reads pixels outside specks, so the result does not
// depend on the order bands finish in or on the number of cores.

/** Backscatter removal is on for these settings. */
export const specksOn = (user) => (user?.backscatter || 0) > 0;
const sensitivity = (user) => Math.min(1, Math.max(0, (user.backscatter || 0) / 100));

/** Find specks in brightness `l2` (w2×h2) of a photo whose long side is `maxdim`. */
export async function detectSpecks({ eng, pool, l2, w2, h2, maxdim, user }) {
  const sens = sensitivity(user);
  if (pool) {
    try {
      const copy = l2.slice();
      const d = await pool.submit({ type: 'detect', l: copy.buffer, w2, h2, maxdim, sens }, [copy.buffer]);
      return { mask: new Uint8Array(d.mask), blobs: new Float32Array(d.blobs), count: d.count, w2, h2 };
    } catch (e) { console.warn('[reefhue] speck detection in a worker failed, using this thread', e); }
  }
  return { ...eng.detectSpecks(l2, w2, h2, maxdim, sens), w2, h2 };
}

/** Fill the detected specks in the 2D context `g` holding the w×h corrected image. */
export async function fillSpecks({ eng, pool, g, w, h, det, maxdim }) {
  const { mask, w2 } = det;
  const margin = eng.specksMargin(maxdim);
  let core = Math.max(64, Math.floor((4 << 20) / (w * 4)));
  core += core & 1;
  const bands = [];
  for (let y = 0; y < h; y += core) {
    const rows = Math.min(core, h - y);
    const a = Math.max(0, y - margin) & ~1;
    const b = Math.min(h, y + rows + margin);
    const ya2 = a >> 1, yb2 = (b + 1) >> 1;
    if (mask.subarray(ya2 * w2, yb2 * w2).indexOf(2) < 0) continue; // nothing to fill near these rows
    bands.push({ y, rows, a, b, ya2, yb2 });
  }
  const one = async (bd, usePool) => {
    const n = bd.b - bd.a;
    const img = g.getImageData(0, bd.a, w, n);
    const m2 = mask.slice(bd.ya2 * w2, bd.yb2 * w2);
    const args = { w, rows: n, w2, h2: bd.yb2 - bd.ya2, y2: bd.ya2, oy: bd.a, sp: 2, yLo: bd.y - bd.a, yHi: bd.y - bd.a + bd.rows };
    let out = img;
    if (usePool) {
      const d = await pool.submit({ type: 'fill', buf: img.data.buffer, mask2: m2.buffer, ...args }, [img.data.buffer, m2.buffer]);
      out = new ImageData(new Uint8ClampedArray(d.buf), w, n);
    } else {
      eng.fillSpecks(img.data, w, n, m2, w2, args.h2, args.y2, args.oy, 2, args.yLo, args.yHi);
    }
    g.putImageData(out, 0, bd.a, 0, bd.y - bd.a, w, bd.rows);
  };
  if (pool) {
    try {
      let next = 0;
      const lane = async () => { while (next < bands.length) await one(bands[next++], true); };
      await Promise.all(Array.from({ length: pool.size * 2 }, lane));
      return;
    } catch (e) {
      console.warn('[reefhue] filling specks in workers failed, using this thread', e);
    }
  }
  // this thread (bands a worker already did are filled again, which at most darkens their speck edges a touch)
  for (const bd of bands) await one(bd, false);
}
