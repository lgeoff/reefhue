// Drives Chrome on an Android emulator through the real file pickers.
// node tests/android/drive.mjs <out-dir> <scenarios.json>
// Each scenario: {name, url, click (CSS selector of the label/button), strategy?, want (file name to pick), done (JS expression, truthy when finished)}
import { chromium } from 'playwright';
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
  // "isn't responding" dialogs from a busy emulator
  const anr = find((n) => /aerr_wait$/.test(id(n))) || find((n) => /aerr_close$/.test(id(n)));
  if (anr) { tap(anr, 'dismiss ANR'); return true; }
  // permission prompts
  const allow = find((n) => /^(allow|allow all|while using the app|allow access to all|allow all the time)$/i.test(t(n)) && n.clickable === 'true');
  if (allow) { tap(allow, 'permission'); return true; }
  // Chrome's photo picker → "Browse" (the system chooser / file manager)
  if (step.browse && !step.browsed) {
    const b = find((n) => t(n) === 'Browse' || d(n) === 'Browse');
    if (b) { tap(b, 'browse'); step.browsed = true; return true; }
  }
  // onboarding screens of gallery apps
  const later = find((n) => /^(not now|no thanks|skip|don.t back up|keep off|got it|continue without|use without an account)$/i.test(t(n)) && n.clickable === 'true');
  if (later && step.browsed) { tap(later, 'onboarding'); return true; }
  // the file we want, by name (DocumentsUI lists names)
  const byName = find((n) => t(n) === want || d(n).includes(want));
  if (byName) { tap(byName, 'wanted file'); return true; }
  // Chrome's own photo picker (Android < 13): pick the first photo tile, then Done
  const done = find((n) => /^(done|add|select|open|allow)( \(\d+\))?$/i.test(t(n)) && (n.clickable === 'true' || /button/i.test(n.class)));
  const tiles = nodes.filter((n) => n.x && (/bitmap_view|image_view|icon_thumb|photo_picker|thumbnail/i.test(id(n)) || (step.browsed && /photos/.test(n.package) && /ImageView|View/.test(n.class) && n.clickable === 'true')) && n.w > 100 && n.h > 100 && n.w < 700);
  if (tiles.length && step.tiles !== 'done' && !(step.browse && !step.browsed)) { tap(tiles[step.tileIndex ?? 0], `photo tile ${step.tileIndex ?? 0} of ${tiles.length}`); step.tiles = 'done'; return true; }
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
  if (step.docs === 'browsed') {
    const cam = find((n) => /^(camera|dcim)$/i.test(t(n)));
    if (cam) { tap(cam, 'folder'); step.docs = 'folder'; return true; }
  }
  return false;
}

// Start the browser with remote debugging and attach over DevTools.
const PKG = process.env.PKG || 'com.android.chrome';
note('device', adb('shell', 'getprop', 'ro.product.model').trim(), 'Android', adb('shell', 'getprop', 'ro.build.version.release').trim(), PKG);
adb('shell', `am force-stop ${PKG}`);
adb('shell', 'echo "chrome --enable-remote-debugging --disable-fre --no-default-browser-check --no-first-run --disable-features=SigninPromo" > /data/local/tmp/chrome-command-line');
adb('shell', 'chmod 644 /data/local/tmp/chrome-command-line');
adb('shell', `am set-debug-app --persistent ${PKG}`);
adb('shell', `am start -n ${PKG}/com.google.android.apps.chrome.Main -a android.intent.action.VIEW -d about:blank`);
await sleep(8000);
// first-run screens, if any
for (let i = 0; i < 4; i++) {
  const { nodes } = dump();
  const b = nodes.find((n) => n.x && /^(accept & continue|accept and continue|no thanks|no, thanks|continue|got it|use without an account|skip)$/i.test((n.text || '').trim()));
  if (!b) break;
  tap(b, 'first run'); await sleep(2500);
}
const sock = PKG === 'com.android.chrome' ? 'chrome_devtools_remote' : 'chrome_devtools_remote';
adb('forward', 'tcp:9222', `localabstract:${sock}`);
let browser;
for (let i = 0; i < 20 && !browser; i++) {
  try { browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 10000 }); } catch (e) { note('  waiting for devtools', e.message.slice(0, 80)); await sleep(3000); }
}
if (!browser) throw new Error('no devtools connection');
note('browser', browser.version());
const context = browser.contexts()[0];
const page = context.pages()[0] || await context.newPage();
page.on('console', (m) => note('  [page]', m.text().slice(0, 300)));
const results = {};
for (const sc of scenarios) {
  note(`\n== ${sc.name}`);
  try {
    // a fresh page every time: the same file picked twice on one input fires no change event
    await page.goto(sc.url + (sc.url.includes('?') ? '&' : '?') + 'r=' + Date.now(), { waitUntil: 'load', timeout: 60000 });
    await sleep(sc.settle ?? 1500);
    if (sc.setup) await page.evaluate(sc.setup);
    await page.click(sc.click, { timeout: 15000 });
    const step = { app: sc.app, tileIndex: sc.tileIndex, idle: 0, browse: !!sc.browse };
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
      if (!pickerStep(nodes, sc.want, step)) { note('  (nothing to tap)'); if (++step.idle > 2) break; }
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
await browser.close().catch(() => {});
