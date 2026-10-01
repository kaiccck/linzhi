#!/usr/bin/env node
// Exact-size screenshots of the running web app (adapted from design/mockups/shot.sh).
//
//   node apps/web/scripts/shot.mjs <url> <out.png> <width> <height|auto> [scale=2] [script]
//
// The page is framed in an iframe of exactly width × height CSS px (headless Chrome's own window
// starts shorter than --window-size and resizes at capture time, which is what broke the mockup's
// captures). The Baidu basemap loads its tiles in workers, which --virtual-time-budget does not wait
// for, so this drives Chrome over the DevTools protocol and waits in real time until the app sets
// <html data-zdd-ready="baidu|offline"> (tiles, overlays and web fonts in place). `auto` height grows
// the frame to the page's full scroll height (stacked phone layout). An optional script runs inside
// the frame before the capture, e.g. "document.querySelector('.play').click()". SHOT_CLIP="x,y,w,h"
// (CSS px) keeps only that part of the frame, for close-ups.
// Needs Google Chrome and Node ≥ 22 (built-in WebSocket); no npm dependencies.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [, , url, out, wArg, hArg, sArg = '2', frameScript = ''] = process.argv;
if (!url || !out || !wArg || !hArg) {
  console.error('usage: shot.mjs <url> <out.png> <width> <height|auto> [scale=2] [script]');
  process.exit(2);
}
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = Number(wArg);
let H = hArg === 'auto' ? 900 : Number(hArg);
const S = Number(sArg);
const WAIT_MS = Number(process.env.SHOT_WAIT_MS ?? 40000);
const SETTLE_MS = Number(process.env.SHOT_SETTLE_MS ?? 800);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), 'zdd-shot-'));
const framePath = join(dir, 'frame.html');
writeFileSync(
  framePath,
  `<!doctype html><meta charset=utf-8><style>html,body{margin:0;background:#fff;overflow:hidden}` +
    `iframe{display:block;width:${W}px;height:${H}px;border:0}</style><iframe id=f src="${url}"></iframe>`,
);
const chrome = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=0',
  `--user-data-dir=${join(dir, 'profile')}`,
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  `--window-size=${W + 120},${H + 200}`,
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
let id = 0;
let frameSession = null;
const waiters = new Map();
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    waiters.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === 'Target.attachedToTarget' && msg.params.targetInfo.type === 'iframe') {
    // the app runs in an out-of-process iframe (file:// parent, http:// child)
    frameSession = msg.params.sessionId;
    send('Runtime.runIfWaitingForDebugger', {}, frameSession).catch(() => {});
    return;
  }
  const w = msg.id && waiters.get(msg.id);
  if (!w) return;
  waiters.delete(msg.id);
  if (msg.error) w.reject(new Error(JSON.stringify(msg.error)));
  else w.resolve(msg.result);
});

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const page = (m, p) => send(m, p, sessionId);
await page('Page.enable');
await page('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
const metrics = () =>
  page('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: S, mobile: false });
await metrics();
await page('Page.navigate', { url: 'file://' + framePath });

async function inFrame(expression) {
  if (!frameSession) return undefined;
  const r = await send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    frameSession,
  );
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result?.value;
}
async function waitReady(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ready = await inFrame('document.documentElement.dataset.zddReady || ""').catch(() => '');
    if (ready) return ready;
    await sleep(250);
  }
  return '';
}

const ready = await waitReady(WAIT_MS);
console.log(`ready=${ready || 'timeout'}`);
// the script runs first, so `auto` measures what it produced (e.g. an answer on the 问询 desk)
if (frameScript) console.log('script →', JSON.stringify(await inFrame(frameScript)));
if (hArg === 'auto') {
  H = Number(await inFrame('Math.ceil(document.documentElement.scrollHeight)')) || H;
  await page('Runtime.evaluate', { expression: `document.getElementById('f').style.height='${H}px'` });
  await metrics();
  await sleep(600);
  await waitReady(8000);
}
await sleep(SETTLE_MS);
// a full-page capture starts at the page's top, wherever the app scrolled itself to (scrollIntoView
// moves every scrolling ancestor, the frame's parent page too)
if (hArg === 'auto') {
  const top = 'window.scrollTo(0, 0); document.documentElement.scrollTop = 0; document.body.scrollTop = 0';
  await inFrame(top).catch(() => {});
  await page('Runtime.evaluate', { expression: top });
  await sleep(150);
}
// SHOT_CLIP="x,y,w,h" (CSS px) captures a close-up of the frame instead of all of it
const [cx, cy, cw, ch] = (process.env.SHOT_CLIP ?? `0,0,${W},${H}`).split(',').map(Number);
const shot = await page('Page.captureScreenshot', {
  format: 'png',
  clip: { x: cx, y: cy, width: cw, height: ch, scale: 1 },
});
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log(`wrote ${out} (${W}×${H} CSS px @${S}x)`);
ws.close();
chrome.kill();
await sleep(200);
// Chrome may still be flushing its profile as it exits: retry, and never fail a capture on cleanup
try {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {
  // a leftover temp directory is harmless
}
process.exit(ready ? 0 : 1);
