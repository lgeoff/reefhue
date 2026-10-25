// Opens each file in the app, reports what it shows, and exports it (NOEXPORT=1 to skip, PHONE=1 for Pixel 7).
// node tests/formats.mjs <app-url> <out-dir> <file>...
// node formats.mjs <url> <out-dir> <file>... : open each file, report, export it
import { chromium, devices } from 'playwright';
const [url, out, ...files] = process.argv.slice(2);
const b = await chromium.launch();
const ctx = await b.newContext({ ...(process.env.PHONE ? devices['Pixel 7'] : { viewport: { width: 1440, height: 900 } }), acceptDownloads: true });
const p = await ctx.newPage();
const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
p.on('console', (m) => { if (/repackaged|could not|ERROR/i.test(m.text())) console.log('   [console]', m.text().slice(0, 200)); });
await p.goto(url); await p.waitForFunction(() => window.reefhue?.afterM, null, { timeout: 30000 });
for (const f of files) {
  const name = f.split('/').pop();
  await p.setInputFiles('#fileInput', f);
  await p.waitForFunction((n) => { const s = window.reefhue, c = s.cur; return c?.name === n && (c.status === 'error' || c.unplayable || (s.afterM && s.srcW > 0 && document.getElementById('fileName').textContent === n && document.getElementById('fileMeta').textContent && !/Preparing/.test(document.getElementById('busyText').textContent || '') )); }, name, { timeout: 90000 }).catch(() => console.log('   (timeout)'));
  await p.waitForTimeout(800);
  const r = await p.evaluate(() => { const s = window.reefhue, c = s.cur; return { kind: s.kind, status: c.status, meta: document.getElementById('fileMeta').textContent, preview: `${s.srcW}x${s.srcH}`, state: c.stateText }; });
  console.log(name, JSON.stringify(r));
  if (r.status !== 'error' && !process.env.NOEXPORT) {
    const t0 = Date.now();
    await p.click('#exportBtn');
    try {
      const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 180000 }), p.click('#sheetGo')]);
      const path = `${out}/${dl.suggestedFilename()}`; await dl.saveAs(path);
      console.log('   exported', path, `${((Date.now() - t0) / 1000).toFixed(1)} s`);
    } catch (e) { console.log('   export failed', e.message.slice(0, 120), await p.textContent('#exportErr')); await p.click('#sheetCancel').catch(() => {}); }
  }
}
console.log('page errors:', errs.length ? errs : 'none');
await b.close();
