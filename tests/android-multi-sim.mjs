// Multi-photo pick on Android, simulated (Pixel 7 emulation, Chromium).
// node tests/android-multi-sim.mjs <app-url> <photo.jpg> [count]
//
// Some Android galleries hand Chrome a copy that changes right after the
// pick; reads that open the file later are refused (NotReadableError).
// Here private-storage setup is slowed down (as on a phone), and every
// picked file is changed on disk 300 ms after the pick. Reads that started
// at pick time survive; reads that waited do not.
import { chromium, devices } from 'playwright';
import { copyFileSync, appendFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const [url, photo, count = '4'] = process.argv.slice(2);
const dir = mkdtempSync(join(tmpdir(), 'multi-sim-'));
const files = Array.from({ length: +count }, (_, i) => { const p = join(dir, `10000534${60 + i}.jpg`); copyFileSync(photo, p); return p; });
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['Pixel 7'] });
await ctx.addInitScript(() => {
  // a phone's storage is slower than this machine's
  const slow = (proto, name, ms) => { const o = proto[name]; proto[name] = async function (...a) { await new Promise((r) => setTimeout(r, ms)); return o.apply(this, a); }; };
  if (globalThis.FileSystemDirectoryHandle) slow(FileSystemDirectoryHandle.prototype, 'getFileHandle', 120);
  if (globalThis.FileSystemFileHandle) slow(FileSystemFileHandle.prototype, 'createWritable', 120);
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(url);
await page.waitForFunction(() => window.reefhue?.afterM, null, { timeout: 30000 });
const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#addBtn')]);
await chooser.setFiles(files);
await new Promise((r) => setTimeout(r, 300));
for (const f of files) appendFileSync(f, Buffer.alloc(32)); // the gallery's copy changes
await page.waitForFunction((n) => window.reefhue.items.filter((i) => !i.demo).length === n && window.reefhue.items.every((i) => i.status === 'error' || i.info), files.length, { timeout: 30000 }).catch(() => {});
const items = await page.evaluate(() => window.reefhue.items.map((i) => `${i.name}:${i.status}${i.info ? ' ' + i.info.w + 'x' + i.info.h : ''}`));
console.log(items.join('\n'));
const ok = items.length === files.length && items.every((s) => s.includes(':ready'));
console.log(ok ? 'PASS' : 'FAIL', '· page errors:', errors.length ? errors : 'none');
await browser.close();
process.exit(ok ? 0 : 1);
