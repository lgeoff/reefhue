// Headless end-to-end test of the Reefhue web app (Playwright + Chromium).
// node tests/e2e.mjs <url> <shots-dir> <clips-dir>
// Covers: demo photo, batch import of several files, per-file custom settings,
// "Use for all", Process all, staleness, Download all (.zip), single export,
// demo clip, phone layout and console errors.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const [url, shots = 'shots', clips = 'clips'] = process.argv.slice(2);
mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' && !/ERR_TUNNEL|fonts\.g/.test(m.text())) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const log = (...a) => console.log('•', ...a);
const state = () => page.evaluate(() => window.reefhue.items.map((i) => ({ name: i.name, status: i.status, text: i.stateText, chip: i.preset })));

await page.goto(url);
await page.waitForFunction(() => window.reefhue?.afterM, null, { timeout: 30000 });
log('demo photo', await page.evaluate(() => ({ items: window.reefhue.items.length, queueHidden: document.getElementById('queue').hidden, gpu: !!window.reefhue.gpu })));

// ---- batch import
await page.setInputFiles('#fileInput', [`${clips}/dive1080.mp4`, `${clips}/dive4k_noaudio.mov`, `${clips}/tpr_Ocean_Lights_a.jpg`, `${clips}/dive1080_hevc.mp4`]);
await page.waitForFunction(() => window.reefhue.items.length === 4 && window.reefhue.items.every((i) => i.thumbUrl || i.status === 'error'), null, { timeout: 60000 });
await page.waitForTimeout(800);
log('after import', await state(), 'queue visible:', await page.isVisible('#queue'));
await page.screenshot({ path: `${shots}/1-batch-imported.png` });

// ---- per-file settings
await page.click('.q-item:nth-child(3) .q-main'); // photo
await page.waitForFunction(() => window.reefhue.cur?.kind === 'image' && window.reefhue.afterM);
await page.click('.preset[data-key="deep"]');
await page.click('.q-item:nth-child(1) .q-main'); // 1080p clip
await page.waitForFunction(() => window.reefhue.cur?.name === 'dive1080.mp4' && window.reefhue.kind === 'video');
await page.locator('#s-exposure').fill('0.3');
await page.waitForTimeout(300);
log('chips', await page.$$eval('.q-chip', (els) => els.map((e) => e.textContent)), 'this-file chip:', await page.textContent('#tfChip'));
await page.screenshot({ path: `${shots}/2-custom-settings.png` });

// ---- process all, output capped at 1080p
await page.selectOption('#qOutput', 'mp4:1080');
const t0 = Date.now();
await page.click('#qProcess');
await page.waitForTimeout(1500);
await page.screenshot({ path: `${shots}/3-processing.png` });
await page.waitForFunction(() => !window.reefhue.batch, null, { timeout: 900000 });
log(`batch finished in ${((Date.now() - t0) / 1000).toFixed(0)} s`, await state());
log('infos', await page.evaluate(() => window.reefhue.items.filter((i) => i.result).map((i) => ({ name: i.name, ...i.result.info, size: i.result.blob.size }))));
await page.screenshot({ path: `${shots}/4-batch-done.png` });

// ---- staleness after an edit
await page.click('.q-item:nth-child(2) .q-main'); // 4K clip
await page.waitForFunction(() => window.reefhue.cur?.name === 'dive4k_noaudio.mov' && window.reefhue.kind === 'video', null, { timeout: 20000 });
await page.locator('#s-waterHue').fill('40');
await page.waitForTimeout(300);
log('after edit', (await state())[1], 'process button:', await page.textContent('#qProcess'));
await page.locator('#s-waterHue').fill('0');
await page.waitForTimeout(300);
log('after revert', (await state())[1]);

// ---- download all
const [zipDl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#qZip')]);
const zipPath = `${shots}/${zipDl.suggestedFilename()}`;
await zipDl.saveAs(zipPath);
log('zip', zipPath);

// ---- single export through the sheet (already processed → direct download)
await page.click('.q-item:nth-child(1) .q-main');
await page.waitForFunction(() => window.reefhue.cur?.name === 'dive1080.mp4');
await page.click('#exportBtn');
log('sheet button:', await page.textContent('#sheetGo'), '|', await page.textContent('#vidNote'));
const [one] = await Promise.all([page.waitForEvent('download'), page.click('#sheetGo')]);
await one.saveAs(`${shots}/${one.suggestedFilename()}`);
log('single', one.suggestedFilename());

// ---- demo clip joins the batch
await page.evaluate(() => { window.reefhueDemoClip(); });
await page.waitForFunction(() => window.reefhue.items.length === 5 && window.reefhue.cur?.name.startsWith('demo-reef-clip') && window.reefhue.kind === 'video', null, { timeout: 120000 });
log('demo clip', await page.evaluate(() => window.reefhue.cur.name));

// ---- phone layout
await page.setViewportSize({ width: 400, height: 860 });
await page.waitForTimeout(500);
await page.screenshot({ path: `${shots}/5-phone.png`, fullPage: true });
log('phone horizontal overflow:', await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth));

writeFileSync(`${shots}/errors.json`, JSON.stringify(errors, null, 2));
log('console errors:', errors.length ? errors : 'none');
await browser.close();
