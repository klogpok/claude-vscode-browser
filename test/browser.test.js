// End-to-end: Browser's public interface against a real headless Chrome/Edge (set CHROME_PATH to override auto-detect).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('events');
const { Browser } = require('../src/browser');

let b;
before(() => {
  b = new Browser((k) => ({ executablePath: process.env.CHROME_PATH || '', startUrl: 'about:blank' })[k], () => {});
});
after(() => b.close());

// A full-viewport page that records every mouse/wheel event it receives.
const RECORDER = 'data:text/html,' + encodeURIComponent(`
  <body style="margin:0;height:3000px" onload="window.log=[]">
  <script>
    for (const t of ['mousedown', 'mousemove', 'mouseup', 'wheel'])
      addEventListener(t, (e) => log.push([t, e.clientX, e.clientY, e.buttons].concat(t === 'wheel' ? [e.deltaY] : [])), { passive: true });
  </script>`);
const events = () => b.evaluate('log');

test('drag presses at the start, moves in steps, releases at the end', { timeout: 10000 }, async () => {
  await b.navigate(RECORDER);
  await b.drag({ x1: 10, y1: 20, x2: 110, y2: 60, steps: 4 });
  assert.deepEqual(await events(), [
    ['mousemove', 10, 20, 0],
    ['mousedown', 10, 20, 1],
    ['mousemove', 35, 30, 1],
    ['mousemove', 60, 40, 1],
    ['mousemove', 85, 50, 1],
    ['mousemove', 110, 60, 1],
    ['mouseup', 110, 60, 0],
  ]);
});

test('scroll wheels at the viewport centre unless told where', { timeout: 10000 }, async () => {
  await b.setViewport(1000, 600);
  await b.navigate(RECORDER);
  await b.scroll({ deltaY: 120 });
  await b.scroll({ deltaY: -40, x: 30, y: 50 });
  // Chrome queues a wheel behind the scroll the previous one started, so wait for both to land.
  const wheels = await b.evaluate(`new Promise((resolve) => {
    const t = setInterval(() => { const w = log.filter(([t]) => t === 'wheel'); if (w.length >= 2) { clearInterval(t); resolve(w); } }, 20);
  })`);
  assert.deepEqual(wheels, [['wheel', 500, 300, 0, 120], ['wheel', 30, 50, 0, -40]]);
});

test('consoleLog filters errors and clears on request', { timeout: 10000 }, async () => {
  await b.navigate('about:blank');
  b.consoleLog({ clear: true });
  await b.navigate('data:text/html,' + encodeURIComponent(`<script>console.log('a'); console.error('b'); console.warn('c')</script>`));
  const brief = (list) => list.map(({ level, text }) => [level, text]);
  assert.deepEqual(brief(b.consoleLog({ errorsOnly: true })), [['error', 'b'], ['warning', 'c']]);
  assert.deepEqual(brief(b.consoleLog({ clear: true })), [['log', 'a'], ['error', 'b'], ['warning', 'c']]);
  assert.deepEqual(b.consoleLog(), []);
});

test('typing after the browser crashed restarts it instead of hanging', { timeout: 15000 }, async () => {
  await b.navigate('data:text/html,<input autofocus>');
  const closed = once(b, 'closed');
  b.proc.kill(); // simulate a crash
  await closed;
  await b.type({ text: 'hi' });
  assert.equal(await b.evaluate('location.href'), 'about:blank');
});
