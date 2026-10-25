// Reproduces Android photo-picker failures in Chromium (Pixel 7 emulation).
// node tests/android-sim.mjs <app-url> <photo.jpg>
//
// Android's picker can rewrite a photo while handing it to the browser (for
// example to strip location data). Chrome took a snapshot of the file when it
// was picked, sees it has changed and refuses to read it: NotReadableError.
// Here the file is picked from disk, the app's first read is held back, the
// file is changed on disk, and the read is released, so Chrome throws the
// real error. Then the user picks the same photo again.
import { chromium, devices } from 'playwright';
import { copyFileSync, appendFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, basename } from 'path';

const [url, photo] = process.argv.slice(2);
const dir = mkdtempSync(join(tmpdir(), 'android-sim-'));
const picked = join(dir, '1000053458.jpg'); // the kind of name Android's picker uses
copyFileSync(photo, picked);

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['Pixel 7'] });
// hold back the first file read until the test releases it
await ctx.addInitScript(() => {
  let release;
  window.__gate = new Promise((r) => { release = r; });
  window.__release = () => release();
  let first = true;
  const orig = Blob.prototype.arrayBuffer;
  Blob.prototype.arrayBuffer = async function () {
    if (first && this instanceof File && this.name === '1000053458.jpg') { first = false; await window.__gate; }
    return orig.call(this);
  };
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(url);
await page.waitForFunction(() => window.reefhue?.afterM, null, { timeout: 30000 });

const state = () => page.evaluate(() => ({
  items: window.reefhue.items.map((i) => `${i.name}:${i.status}`),
  meta: document.getElementById('fileMeta').textContent,
  pickAgain: !document.getElementById('stageMsg').hidden,
  preview: `${window.reefhue.srcW}x${window.reefhue.srcH}`,
}));

// 1. pick through the chooser, like tapping "Add photos or videos"
let [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#addBtn')]);
await chooser.setFiles(picked);
// 2. Android rewrites the photo during the handover
appendFileSync(picked, Buffer.alloc(16));
await page.evaluate(() => window.__release());
await page.waitForFunction(() => { const c = window.reefhue.cur; return c?.name === '1000053458.jpg' && (c.status === 'error' || (c.info && window.reefhue.srcW === c.info.w)); }, null, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(500);
const first = await state();
console.log('first pick:', JSON.stringify(first));
await page.screenshot({ path: join(dir, 'first-pick.png') });

// 3. the user taps "Pick it again" and chooses the same photo
[chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#stageMsg label')]);
await chooser.setFiles(picked);
await page.waitForFunction(() => { const c = window.reefhue.cur; return c?.info && window.reefhue.srcW === c.info.w && !window.reefhue.items.some((i) => i.status === 'error'); }, null, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(500);
const second = await state();
console.log('second pick:', JSON.stringify(second));
await page.screenshot({ path: join(dir, 'second-pick.png') });

const ok = first.pickAgain && second.items.length === 1 && second.items[0].endsWith(':ready') && !second.pickAgain;
console.log(ok ? 'PASS' : 'FAIL', `· page errors: ${errors.length ? errors.join(' | ') : 'none'} · screenshots in ${dir}`);
await browser.close();
process.exit(ok ? 0 : 1);
