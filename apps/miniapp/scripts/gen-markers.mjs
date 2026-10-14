#!/usr/bin/env node
// Map marker images for the mini program (<map> markers need image files, not SVG): the facility
// pictograms in their category hue on a white disc, 你在这里, the 规划 pins, and a transparent dot for
// label-only markers. Rendered at 3× by headless Chrome over the DevTools protocol (no npm deps).
//   node scripts/gen-markers.mjs   → src/assets/markers/*.png
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
// the generated module is one JSON literal (scripts/gen-icons.mjs)
const gen = readFileSync(here('../src/platform/icons.gen.ts'), 'utf8');
const SYMBOLS = JSON.parse(gen.slice(gen.indexOf('= {') + 2, gen.lastIndexOf('}') + 1));
const OUT = here('../src/assets/markers/');
mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SCALE = 3;

const sym = (id, color, size) => {
  const s = SYMBOLS[id];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${s.viewBox}" width="${size}" height="${size}" fill="${color}">${s.body.replace(/currentColor/g, color)}</svg>`;
};
const disc = (size, bg, ring, inner) =>
  `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${bg};box-sizing:border-box;` +
  `border:${ring};display:flex;align-items:center;justify-content:center;box-shadow:0 1px 2px rgba(31,42,55,.25)">${inner}</div>`;

const FAC = {
  school: ['pg-school', '#6d5bd0'],
  kinder: ['pg-kinder', '#6d5bd0'],
  market: ['pg-market', '#d4782f'],
  fresh: ['pg-fresh', '#d4782f'],
  pharmacy: ['pg-pharmacy', '#1b9aaa'],
  clinic: ['pg-clinic', '#1b9aaa'],
  metro: ['pg-metro', '#6b7585'],
  super: ['pg-super', '#6b7585'],
  elder: ['pg-elder', '#6b7585'],
  bus: ['pg-bus', '#6b7585'],
  park: ['pg-park', '#6b7585'],
  middle: ['pg-school', '#6d5bd0'],
  store: ['pg-store', '#6b7585'],
  food: ['pg-food', '#6b7585'],
  parcel: ['pg-parcel', '#6b7585'],
  bank: ['pg-bank', '#6b7585'],
  gym: ['pg-gym', '#6b7585'],
  library: ['pg-library', '#6b7585'],
};
const icons = {
  // 22 pt facility discs (drawn at 26 to leave room for the shadow)
  ...Object.fromEntries(
    Object.entries(FAC).map(([k, [id, c]]) => [
      `fac-${k}`,
      { w: 26, h: 26, html: disc(22, '#fff', `1.2px solid ${c}`, sym(id, c, 14)) },
    ]),
  ),
  // the same, dimmed: facilities of other categories than the one on screen
  ...Object.fromEntries(
    Object.entries(FAC).map(([k, [id]]) => [
      `fac-${k}-dim`,
      { w: 20, h: 20, html: disc(16, '#fff', '1px solid #a3acb8', sym(id, '#a3acb8', 10)) },
    ]),
  ),
  here: {
    w: 34,
    h: 34,
    html: disc(30, '#1446b0', '2.5px solid #fff', sym('pg-walk', '#fff', 17)),
  },
  pick: {
    w: 34,
    h: 34,
    html:
      `<div style="width:30px;height:30px;border-radius:50%;border:2px solid #1446b0;background:rgba(20,70,176,.12);` +
      `display:flex;align-items:center;justify-content:center"><div style="width:8px;height:8px;border-radius:50%;background:#1446b0"></div></div>`,
  },
  site: {
    w: 30,
    h: 30,
    html: disc(26, '#1446b0', '2px solid #fff', sym('pg-plus', '#fff', 14)),
  },
  'site-sug': {
    w: 24,
    h: 24,
    html: disc(
      20,
      '#fff',
      '1.6px solid #1446b0',
      `<div style="width:6px;height:6px;border-radius:50%;background:#1446b0"></div>`,
    ),
  },
  'route-end': {
    w: 14,
    h: 14,
    html: disc(10, '#fff', '2.5px solid #56616f', ''),
  },
  dot: { w: 2, h: 2, html: '' },
};
// review sheet (not shipped): every pictogram large, in a row
const sheet = {
  w: 40 * Object.keys(SYMBOLS).filter((k) => k.startsWith('pg-')).length,
  h: 40,
  html: `<div style="display:flex">${Object.keys(SYMBOLS)
    .filter((k) => k.startsWith('pg-'))
    .map(
      (k) =>
        `<div style="width:40px;height:40px;display:flex;align-items:center;justify-content:center">${sym(k, '#1f2a37', 28)}</div>`,
    )
    .join('')}</div>`,
};

const dir = mkdtempSync(join(tmpdir(), 'zdd-markers-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=0',
  `--user-data-dir=${join(dir, 'profile')}`,
  '--no-first-run',
  'about:blank',
]);
const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  chrome.stderr.on('data', (d) => {
    buf += d;
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
    if (m) resolve(m[1]);
  });
  setTimeout(() => reject(new Error('Chrome did not start')), 15000);
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let n = 0;
const waiters = new Map();
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++n;
    waiters.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  const w = msg.id && waiters.get(msg.id);
  if (!w) return;
  waiters.delete(msg.id);
  if (msg.error) w.reject(new Error(JSON.stringify(msg.error)));
  else w.resolve(msg.result);
});
try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = (m, p) => send(m, p, sessionId);
  await page('Page.enable');
  await page('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await page('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: 200,
    deviceScaleFactor: SCALE,
    mobile: false,
  });
  for (const [name, { w, h, html }] of Object.entries({ ...icons, _sheet: sheet })) {
    const doc =
      `<!doctype html><meta charset=utf-8><style>html,body{margin:0;background:transparent}</style>` +
      `<div style="width:${w}px;height:${h}px;display:flex;align-items:center;justify-content:center">${html}</div>`;
    await page('Runtime.evaluate', {
      expression: `document.open();document.write(${JSON.stringify(doc)});document.close();`,
    });
    await new Promise((r) => setTimeout(r, 60));
    const { data } = await page('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: w, height: h, scale: 1 },
      captureBeyondViewport: false,
    });
    const file = name === '_sheet' ? join(tmpdir(), 'zdd-pictograms.png') : join(OUT, `${name}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
  }
  console.log(`markers: ${Object.keys(icons).length} → src/assets/markers`);
} finally {
  ws.close();
  const exited = new Promise((r) => chrome.once('exit', r));
  chrome.kill();
  await exited;
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
