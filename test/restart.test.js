// End-to-end: restarting and losing the Browser, against a real headless Chrome/Edge (set CHROME_PATH to override auto-detect).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('events');
const { Browser } = require('../src/browser');

let b;
let launches = 0;
let closedEvents = 0;
// A cold Chrome start can miss Browser's 20s deadline on a fresh CI runner; retry once (see browser.test.js).
before(async () => {
  const config = (k) => ({ executablePath: process.env.CHROME_PATH || '', startUrl: 'about:blank' })[k];
  b = new Browser(config, (line) => { if (line.startsWith('launching')) launches++; });
  b.on('closed', () => closedEvents++);
  await b.ensure().catch(() => b.ensure());
}, { timeout: 60000 });
after(() => b.close());

const exited = (proc) => (proc.exitCode !== null || proc.signalCode !== null ? Promise.resolve() : once(proc, 'exit'));

test('a restart does not report the old browser as closed', { timeout: 30000 }, async () => {
  const old = b.proc;
  launches = 0; closedEvents = 0;
  b.close();
  await b.ensure();
  await exited(old);
  assert.equal(closedEvents, 0);
  assert.equal(await b.evaluate('1'), 1);
  assert.equal(launches, 1);
});

test('a browser killed from outside is reported closed once, and the next ensure starts a new one', { timeout: 30000 }, async () => {
  const proc = b.proc;
  launches = 0; closedEvents = 0;
  proc.kill(); // not through the Browser API, like a crash
  await exited(proc);
  await new Promise((r) => setTimeout(r, 500)); // let the CDP socket's close land too
  assert.equal(closedEvents, 1);
  assert.equal(b.running, false);
  await b.ensure();
  assert.equal(launches, 1);
  assert.equal(await b.evaluate('1'), 1);
});
