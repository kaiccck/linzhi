#!/usr/bin/env node
// Screenshot of the mini program in WeChat devtools' simulator (devtools must run with automation on:
//   cli auto --project <repo> --auto-port 9420 --port <ide port>).
//   node scripts/shot.mjs <out.png> [page-path] [wait-ms] [steps] [after-ms]
// steps: calls on the page's dev hooks (getApp().__zdd, pages/index) run in order before the shot,
// separated by |, e.g. "snap('full')|cat('菜市场')" — each waits 900 ms for the screen to settle.
// Prints the page's console errors and exceptions seen while waiting.
import { execSync } from 'node:child_process';
import automator from 'miniprogram-automator';

// the simulator is only captured while devtools is the frontmost app
try {
  execSync(`osascript -e 'tell application "wechatwebdevtools" to activate'`);
} catch {
  /* not macOS or no devtools: the capture says so itself */
}

const [, , out = '/tmp/zdd-mini.png', path, wait = '4000', steps = '', after = '900'] = process.argv;
const fmt = (a) => (a && typeof a === 'object' ? JSON.stringify(a).slice(0, 1500) : String(a));
const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
const logs = [];
mp.on('console', (m) => {
  if (process.env.SHOT_ALL || m.type === 'error' || m.type === 'warn')
    logs.push(`[${m.type}] ${m.args?.map(fmt).join(' ')}`);
});
mp.on('exception', (e) => logs.push(`[exception] ${e.message}\n${e.stack ?? ''}`));
try {
  // errors reach the protocol as {}: have the page print their message and stack as text
  await mp.evaluate(function () {
    const wrap = (k) => {
      const o = console[k];
      if (o.__zdd) return;
      const f = (...a) =>
        o.apply(
          console,
          a.map((x) => (x && typeof x === 'object' && 'message' in x ? `${x.message}\n${x.stack}` : x)),
        );
      f.__zdd = true;
      console[k] = f;
    };
    wrap('error');
    wrap('warn');
  });
  if (path) await mp.reLaunch(path.startsWith('/') ? path : `/${path}`);
  await new Promise((r) => setTimeout(r, Number(wait)));
  for (const step of steps.split('|').filter(Boolean)) {
    // "@scroll:600" scrolls the page itself (pages that scroll natively, like the report)
    if (step.startsWith('@scroll:')) {
      await mp.pageScrollTo(Number(step.slice(8)));
      await new Promise((r) => setTimeout(r, Number(after)));
      continue;
    }
    const r = await mp.evaluate(
      new Function(`const z = getApp().__zdd; if (!z) return 'no dev hooks'; z.${step}; return 'ok';`),
    );
    if (r !== 'ok') console.log(`${step}: ${r}`);
    await new Promise((r) => setTimeout(r, Number(after)));
  }
  await mp.screenshot({ path: out });
  const page = await mp.currentPage();
  console.log(`page=${page?.path} shot=${out}`);
} finally {
  for (const l of logs.slice(-20)) console.log(l);
  mp.disconnect();
}
