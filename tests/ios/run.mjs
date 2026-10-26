// Drives Mobile Safari in the iOS Simulator through Appium: open Reefhue, tap
// "+", choose Photo Library, pick a video, add it, then record what the app
// does for the next seconds. Each scenario starts from a fresh page.
import { remote } from 'webdriverio';
import { writeFileSync } from 'node:fs';

const { UDID, VER, NAME, OUT } = process.env;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
let shot = 0;

const d = await remote({
  hostname: '127.0.0.1', port: 4723, logLevel: 'warn', connectionRetryTimeout: 900000,
  capabilities: {
    platformName: 'iOS', browserName: 'Safari',
    'appium:automationName': 'XCUITest', 'appium:udid': UDID, 'appium:deviceName': NAME, 'appium:platformVersion': VER,
    'appium:newCommandTimeout': 900, 'appium:wdaLaunchTimeout': 900000, 'appium:wdaConnectionTimeout': 900000,
    'appium:safariIgnoreFraudWarning': true, 'appium:webviewConnectTimeout': 60000, 'appium:nativeWebTap': true,
  },
});
log('session up');

async function snap(tag) {
  const n = String(++shot).padStart(2, '0');
  try { writeFileSync(`${OUT}/${n}-${tag}.png`, Buffer.from(await d.takeScreenshot(), 'base64')); } catch (e) { log('screenshot failed', e.message); }
}
async function source(tag) {
  try { const ctx = await d.getContext(); await d.switchContext('NATIVE_APP'); writeFileSync(`${OUT}/src-${tag}.xml`, await d.getPageSource()); await d.switchContext(ctx); } catch (e) { log('source failed', e.message); }
}
async function web() {
  const ctxs = await d.getContexts();
  const w = ctxs.map((c) => (typeof c === 'string' ? c : c.id)).filter((c) => c.startsWith('WEBVIEW')).pop();
  if (w) await d.switchContext(w);
  return w;
}
async function native() { await d.switchContext('NATIVE_APP'); }

async function findAny(selectors, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (const s of selectors) {
      // iOS reports many web elements as not displayed: take the first match
      try { const els = await d.$$(s); if (els.length) return els[0]; } catch { /* next */ }
    }
    await sleep(500);
  }
  return null;
}
async function tap(el) {
  const r = await el.getRect?.().catch(() => null) || { ...(await el.getLocation()), ...(await el.getSize()) };
  await d.execute('mobile: tap', { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
}

const STATE = `return (() => {
  const s = window.reefhue; if (!s) return { app: 'not ready' };
  const t = (id) => (document.getElementById(id)?.hidden ? '' : (document.getElementById(id)?.textContent || '').trim().slice(0, 160));
  return {
    kind: s.kind, cur: s.cur?.name, src: s.srcW + 'x' + s.srcH,
    items: (s.items || []).map((i) => ({ name: i.name, type: i.file?.type, size: i.file?.size, status: i.status, text: i.stateText, kind: i.kind, w: i.w, dur: i.duration, unplayable: !!i.unplayable })),
    file: t('fileName'), meta: t('fileMeta'), busy: t('busyText'), toast: t('toast'), msg: t('stageMsgText'),
    transport: !document.getElementById('transport')?.hidden,
  };
})()`;

async function scenario(url, file, { second = false } = {}) {
  log(`=== ${url} · ${file}${second ? ' · then again' : ''}`);
  await web();
  await d.url(url);
  await sleep(4000);
  await d.execute(`try { localStorage.setItem('reefhue-tour-seen', '1'); } catch {}`);
  log('loaded', JSON.stringify(await d.execute(STATE)));
  await snap('loaded');
  const rounds = second ? 2 : 1;
  for (let round = 1; round <= rounds; round++) {
    // open the picker with a real tap on "+"
    await native();
    let add = await findAny(['~Add photos or videos', '-ios predicate string:label CONTAINS "Add photos"'], 10000);
    if (!add) {
      // fall back to coordinates from the page
      await web();
      const r = await d.execute(`const r = document.getElementById('addBtn').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
      await native();
      const wv = await findAny(['//XCUIElementTypeWebView'], 5000);
      const wr = await wv.getRect();
      log('tap by coordinates', JSON.stringify(r), JSON.stringify(wr));
      await d.execute('mobile: tap', { x: Math.round(wr.x + r.x), y: Math.round(wr.y + r.y) });
    } else await tap(add);
    await sleep(1500);
    await snap(`r${round}-menu`); await source(`r${round}-menu`);
    const lib = await findAny(['~Photo Library', '-ios predicate string:label == "Photo Library"', '-ios predicate string:label CONTAINS "Photo"'], 10000);
    if (!lib) { log('no Photo Library item'); return; }
    await tap(lib);
    await sleep(3500);
    await snap(`r${round}-picker`); await source(`r${round}-picker`);
    // the picker can reopen on Collections: go to Photos
    const photosTab = await findAny(['-ios predicate string:type == "XCUIElementTypeButton" AND label == "Photos"'], 3000);
    if (photosTab) { await photosTab.click().catch(() => tap(photosTab)); await sleep(1500); }
    // the video thumbnail: IMG_0001.MOV was added with a 10:00 time stamp, dive_h264.mp4 with 11:00
    const when = file.startsWith('IMG') ? '10:00' : '11:00';
    const cellSel = `-ios predicate string:type == "XCUIElementTypeImage" AND label BEGINSWITH "Video," AND label CONTAINS "${when}"`;
    const doneSel = '-ios predicate string:type == "XCUIElementTypeButton" AND (label == "Done" OR label == "Add")';
    let selected = false;
    for (let attempt = 1; attempt <= 4 && !selected; attempt++) {
      const cell = await findAny([cellSel], 10000);
      if (!cell) { log('no video in picker'); await source(`r${round}-nocell`); return; }
      if (attempt === 1) log('cell', await cell.getAttribute('label'));
      if (attempt % 2) await cell.click().catch(async () => tap(cell)); else await tap(cell);
      await sleep(1500);
      const done = await findAny([doneSel], 3000);
      selected = !!done && (await done.getAttribute('enabled').catch(() => 'false')) === 'true';
      log(`select attempt ${attempt}: Done enabled = ${selected}`);
    }
    await snap(`r${round}-selected`);
    if (!selected) { await source(`r${round}-notselected`); return; }
    const done = await findAny([doneSel], 3000);
    await done.click().catch(async () => tap(done));
    log('tapped Done');
    const t0 = Date.now();
    let last = '';
    while (Date.now() - t0 < 40000) {
      await sleep(1000);
      let s;
      try { await web(); s = JSON.stringify(await d.execute(STATE)); } catch (e) { s = 'web ctx: ' + e.message.slice(0, 120); try { await native(); } catch {} }
      if (s !== last) { log(`+${((Date.now() - t0) / 1000).toFixed(0)}s`, s); last = s; }
      if ([5, 15, 39].some((k) => Math.abs((Date.now() - t0) / 1000 - k) < 0.6)) await snap(`r${round}-t${Math.round((Date.now() - t0) / 1000)}`);
    }
    await snap(`r${round}-end`);
  }
  try {
    await web();
    const dbg = await d.execute(`document.getElementById('debugLink').click(); return document.getElementById('debugLog').textContent;`);
    log('debug log:\n' + dbg);
  } catch (e) { log('no debug log', e.message); }
}

const cases = [
  ['https://reefhue.com/', 'IMG_0001.MOV', { second: true }],
  ['http://localhost:8765/', 'IMG_0001.MOV', { second: true }],
  ['https://reefhue.com/', 'dive_h264.mp4', {}],
];
for (const [u, f, o] of cases) {
  try { await scenario(u, f, o); } catch (e) { log('scenario failed', e.stack || e.message); await snap('failed'); await source('failed'); }
}
await d.deleteSession().catch(() => {});
log('done');
