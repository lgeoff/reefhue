// Photo loading test (Playwright + Chromium), desktop and phone emulation.
// node tests/photos.mjs <app-url> <dir with DSC04808.JPG rot6.jpg big50mp.jpg fake.heic>
// Checks: preview loads, real dimensions are shown, EXIF orientation is
// applied, HEIC gets a clear message, full-size export works in strips.
import { chromium, devices } from 'playwright';

const [url, dir] = process.argv.slice(2);
const browser = await chromium.launch();
for (const [label, ctxOpts] of [['desktop', { viewport: { width: 1440, height: 900 } }], ['phone', devices['Pixel 7']]]) {
  const ctx = await browser.newContext({ ...ctxOpts, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await page.waitForFunction(() => window.reefhue?.afterM, null, { timeout: 30000 });
  for (const f of ['DSC04808.JPG', 'rot6.jpg', 'fake.heic', 'big50mp.jpg']) {
    await page.setInputFiles('#fileInput', `${dir}/${f}`);
    await page.waitForFunction((n) => {
      const s = window.reefhue;
      return s.cur?.name === n && (s.cur.unplayable || (s.kind === 'image' && s.afterM && document.getElementById('fileName').textContent === n));
    }, f, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => {
      const s = window.reefhue, i = s.cur;
      return {
        status: i.status, label: document.getElementById('fileMeta').textContent, preview: `${s.srcW}x${s.srcH}`,
        info: i.info && `${i.info.format} ${i.info.w}x${i.info.h} o${i.info.orientation}`, error: i.unplayable ? i.stateText : undefined,
        details: i.errorDetails || undefined, toast: document.getElementById('toast').hidden ? undefined : document.getElementById('toast').textContent,
      };
    });
    console.log(label, f, JSON.stringify(r));
    if (f === 'rot6.jpg') {
      // the stored image is landscape rotated to portrait; with EXIF applied the preview must be landscape again
      console.log('  orientation ok:', r.preview.split('x').map(Number).reduce((w, h) => w > h));
    }
    if (!r.error && f !== 'rot6.jpg') {
      const t0 = Date.now();
      await page.click('#exportBtn');
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#sheetGo')]);
      const path = `${dir}/out-${label}-${dl.suggestedFilename()}`;
      await dl.saveAs(path);
      console.log('  exported', path, `${((Date.now() - t0) / 1000).toFixed(1)} s`);
    }
  }
  console.log(label, 'page errors:', errors.length ? errors : 'none');
  await ctx.close();
}
await browser.close();
