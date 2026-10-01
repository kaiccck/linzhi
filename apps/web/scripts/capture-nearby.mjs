#!/usr/bin/env node
// 浏览器端周边检索 of the live samples, for their refresh (apps/server/scripts/refresh-live-samples.ts
// --browser-pois <file>): drives the running dev app (http://localhost:5175) in headless Chrome and
// calls its dev hook window.__zddNearby for each sample's centre.
//
//   node apps/web/scripts/capture-nearby.mjs [out.json] [sample…]
//
// Spends the JS API 地点检索 quota: about 13–15 searches per sample (12 keywords, a second page where
// there is one). Needs Google Chrome and Node ≥ 22; no npm dependencies.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const APP = process.env.APP_URL ?? 'http://localhost:5175/';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [, , outArg, ...ids] = process.argv;
const out = outArg ?? join(ROOT, 'research/zhangjiang/raw/jsapi_nearby.json');
const samples = ids.length ? ids : ['zj-b', 'zj-c', 'zj-v'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const centres = Object.fromEntries(
  samples.map((id) => {
    const d = JSON.parse(readFileSync(join(ROOT, `data/samples/${id}.json`), 'utf8'));
    return [id, d.meta.center_bd09];
  }),
);

const dir = mkdtempSync(join(tmpdir(), 'zdd-nearby-'));
const proc = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=0',
  `--user-data-dir=${dir}`,
  '--host-resolver-rules=MAP localhost [::1]',
  'about:blank',
]);
try {
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) resolve(m[1]);
    });
    setTimeout(() => reject(new Error('Chrome did not start')), 20000);
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const waiters = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    const w = m.id && waiters.get(m.id);
    if (!w) return;
    waiters.delete(m.id);
    if (m.error) w.reject(new Error(JSON.stringify(m.error)));
    else w.resolve(m.result);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      waiters.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const ev = async (expression) =>
    (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId))
      .result.value;
  await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url: APP }, sessionId);
  for (let i = 0; i < 100 && !(await ev('typeof window.__zddNearby === "function" && !!window.BMap')); i++)
    await sleep(200);
  const result = {};
  for (const [sample, [lng, lat]] of Object.entries(centres)) {
    // a fresh day cache would hand back yesterday's search: clear this centre's entry first
    await ev(
      `Object.keys(localStorage).filter((k) => k.startsWith('zdd:nearby:')).forEach((k) => localStorage.removeItem(k))`,
    );
    result[sample] = await ev(`window.__zddNearby(${lng}, ${lat})`);
    console.log(`${sample}: ${result[sample].length} POIs`);
  }
  writeFileSync(out, JSON.stringify(result, null, 1) + '\n');
  console.log(`→ ${out}`);
  ws.close();
} finally {
  proc.kill();
  await sleep(300);
  rmSync(dir, { recursive: true, force: true });
}
