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
  // the first read of each picked photo (Android-style numeric names) waits
  const held = new Set();
  const orig = Blob.prototype.arrayBuffer;
  Blob.prototype.arrayBuffer = async function () {
    if (this instanceof File && /^1000\d+\.jpg$/.test(this.name) && !held.has(this.name)) { held.add(this.name); await window.__gate; }
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

// 3. if it was refused, the user taps "Pick again" and chooses the same photo
// (since reads start at pick time, the app usually gets the bytes first time)
if (first.pickAgain) {
  [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#stageMsg label[for=fileInput]')]);
  await chooser.setFiles(picked);
}
await page.waitForFunction(() => { const c = window.reefhue.cur; return c?.info && window.reefhue.srcW === c.info.w && !window.reefhue.items.some((i) => i.status === 'error'); }, null, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(500);
const second = await state();
console.log('second pick:', JSON.stringify(second));
await page.screenshot({ path: join(dir, 'second-pick.png') });

// 4. a batch: two more photos picked at once, both refused, then both picked again
const batch = [join(dir, '1000053308.jpg'), join(dir, '1000053490.jpg')];
for (const p of batch) copyFileSync(photo, p);
await page.evaluate(() => { let r; window.__gate = new Promise((x) => { r = x; }); window.__release = () => r(); });
[chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#addBtn')]);
await chooser.setFiles(batch);
for (const p of batch) appendFileSync(p, Buffer.alloc(16));
await page.evaluate(() => window.__release());
await page.waitForFunction(() => window.reefhue.items.length === 3 && window.reefhue.items.every((i) => i.status === 'error' || i.info), null, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(500);
const third = await state();
third.text = await page.textContent('#stageMsgText');
console.log('batch pick:', JSON.stringify(third));
await page.screenshot({ path: join(dir, 'batch-pick.png') });
if (third.pickAgain) {
  [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#stageMsg label[for=fileInput]')]);
  await chooser.setFiles(batch);
}
await page.waitForFunction(() => window.reefhue.items.length === 3 && window.reefhue.items.every((i) => i.info) && window.reefhue.srcW === window.reefhue.cur.info.w, null, { timeout: 20000 }).catch(() => {});
const fourth = await state();
console.log('batch picked again:', JSON.stringify(fourth));

console.log(`first pick ${first.pickAgain ? 'refused, recovered by picking again' : 'worked directly'}; batch ${third.pickAgain ? 'refused, recovered by picking again' : 'worked directly'}`);
const ok = second.items.length === 1 && second.items[0].endsWith(':ready') && !second.pickAgain
  && (!third.pickAgain || /these 2 photos/.test(third.text)) && fourth.items.length === 3 && fourth.items.every((i) => i.endsWith(':ready')) && !fourth.pickAgain;
console.log(ok ? 'PASS' : 'FAIL', `· page errors: ${errors.length ? errors.join(' | ') : 'none'} · screenshots in ${dir}`);
await browser.close();
process.exit(ok ? 0 : 1);
