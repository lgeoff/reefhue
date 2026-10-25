// Drives Chrome on an Android emulator through the real file pickers.
// node tests/android/drive.mjs <out-dir> <scenarios.json>
// Each scenario: {name, url, click (CSS selector of the label/button), strategy?, want (file name to pick), done (JS expression, truthy when finished)}
import { _android as android } from 'playwright';
import { execFileSync } from 'child_process';
import { writeFileSync, readFileSync, mkdirSync } from 'fs';

const [out, scenFile] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const scenarios = JSON.parse(readFileSync(scenFile, 'utf8'));
const adb = (...a) => execFileSync('adb', a, { encoding: 'utf8', maxBuffer: 64 << 20 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const note = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); console.log(s); log.push(s); };

function dump() {
  try { adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml'); } catch { return []; }
  const xml = adb('shell', 'cat', '/sdcard/ui.xml');
  const nodes = [];
  for (const m of xml.matchAll(/<node [^>]*>/g)) {
    const a = {};
    for (const k of ['text', 'resource-id', 'content-desc', 'class', 'package', 'bounds', 'clickable', 'checkable']) {
      const mm = m[0].match(new RegExp(`${k}="([^"]*)"`));
      a[k] = mm ? mm[1] : '';
    }
    const b = a.bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (b) { a.x = (+b[1] + +b[3]) >> 1; a.y = (+b[2] + +b[4]) >> 1; a.w = b[3] - b[1]; a.h = b[4] - b[2]; }
    nodes.push(a);
  }
  return { nodes, xml };
}
const tap = (n, why) => { note(`  tap "${n.text || n['content-desc'] || n['resource-id']}" (${why}) at ${n.x},${n.y}`); adb('shell', 'input', 'tap', String(n.x), String(n.y)); };
let shot = 0;
function screenshot(name) {
  const f = `${out}/${String(++shot).padStart(2, '0')}-${name}.png`;
  writeFileSync(f, execFileSync('adb', ['exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20 }));
  return f;
}

/** One step of the native picker: returns true when it tapped something. */
function pickerStep(nodes, want, step) {
  const t = (n) => (n.text || '').trim(), d = (n) => n['content-desc'] || '', id = (n) => n['resource-id'] || '';
  const find = (pred) => nodes.find((n) => n.x && pred(n));
  // permission prompts
  const allow = find((n) => /^(allow|allow all|while using the app|allow access to all|allow all the time)$/i.test(t(n)) && n.clickable === 'true');
  if (allow) { tap(allow, 'permission'); return true; }
  // the file we want, by name (DocumentsUI lists names)
  const byName = find((n) => t(n) === want || d(n).includes(want));
  if (byName) { tap(byName, 'wanted file'); return true; }
  // Chrome's own photo picker (Android < 13): pick the first photo tile, then Done
  const done = find((n) => /^(done|add|select|open)$/i.test(t(n)) && n.clickable === 'true' && id(n) !== '');
  const tiles = nodes.filter((n) => n.x && /bitmap_view|image_view|icon_thumb|photo_picker|thumbnail/i.test(id(n)) && n.w > 100 && n.h > 100);
  if (tiles.length && step.tiles !== 'done') { tap(tiles[step.tileIndex ?? 0], `photo tile ${step.tileIndex ?? 0} of ${tiles.length}`); step.tiles = 'done'; return true; }
  if (done && step.tiles === 'done') { tap(done, 'confirm'); return true; }
  // chooser of apps: prefer the one the scenario names
  if (step.app) {
    const app = find((n) => t(n).toLowerCase() === step.app.toLowerCase());
    if (app) { tap(app, 'chooser app'); step.app = null; return true; }
  }
  const justOnce = find((n) => /^just once$/i.test(t(n)));
  if (justOnce) { tap(justOnce, 'just once'); return true; }
  // DocumentsUI: open the drawer to Images / Downloads when the file isn't listed
  if (step.docs !== 'roots') {
    const roots = find((n) => /show roots|navigate up|open navigation/i.test(d(n)));
    if (roots && nodes.some((n) => /documentsui/.test(n.package))) { tap(roots, 'documents roots'); step.docs = 'roots'; return true; }
  }
  if (step.docs === 'roots') {
    const imgs = find((n) => /^(images|downloads|download)$/i.test(t(n)));
    if (imgs) { tap(imgs, 'documents root'); step.docs = 'browsed'; return true; }
  }
  return false;
}

const [device] = await android.devices();
const PKG = process.env.PKG || 'com.android.chrome';
note('device', device.model(), device.serial());
await device.shell(`am force-stop ${PKG}`);
const context = await device.launchBrowser({ pkg: PKG });
const page = await context.newPage();
page.on('console', (m) => note('  [page]', m.text().slice(0, 300)));
const results = {};
for (const sc of scenarios) {
  note(`\n== ${sc.name}`);
  try {
    if (page.url() !== sc.url) { await page.goto(sc.url, { waitUntil: 'load', timeout: 60000 }); await sleep(sc.settle ?? 1500); }
    if (sc.setup) await page.evaluate(sc.setup);
    await page.click(sc.click, { timeout: 15000 });
    const step = { app: sc.app, tileIndex: sc.tileIndex };
    let finished = false;
    for (let i = 0; i < 14 && !finished; i++) {
      await sleep(1800);
      finished = await page.evaluate(sc.done).catch(() => false);
      if (finished) break;
      const { nodes, xml } = dump();
      const visible = nodes.filter((n) => n.x && (n.text || n['content-desc'])).map((n) => `${n.text || n['content-desc']}${n['resource-id'] ? ` <${n['resource-id'].split('/').pop()}>` : ''}`).slice(0, 40);
      note(`  screen ${i}: ${nodes[0]?.package || '?'} | ${visible.join(' | ')}`);
      writeFileSync(`${out}/${sc.name}-ui-${i}.xml`, xml || '');
      screenshot(`${sc.name}-${i}`);
      if (!pickerStep(nodes, sc.want, step)) { note('  (nothing to tap)'); if (i > 2) break; }
    }
    await sleep(2500);
    results[sc.name] = await page.evaluate(sc.result).catch((e) => `result error ${e.message}`);
    note('  RESULT', results[sc.name]);
    screenshot(`${sc.name}-end`);
  } catch (e) {
    note('  ERROR', e.message.slice(0, 300));
    results[sc.name] = { error: e.message.slice(0, 300) };
    try { screenshot(`${sc.name}-error`); adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); } catch {}
  }
}
writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
writeFileSync(`${out}/driver.log`, log.join('\n'));
await context.close();
await device.close();
