// End-to-end: restarting and losing the Browser, against a real headless Chrome/Edge (set CHROME_PATH to override auto-detect).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('events');
const { Browser } = require('../src/browser');

let b;
let launches = 0;
let closedEvents = 0;
let startedEvents = 0;
// A cold Chrome start can miss Browser's 20s deadline on a fresh CI runner; retry once (see browser.test.js).
before(async () => {
  const config = (k) => ({ executablePath: process.env.CHROME_PATH || '', startUrl: 'about:blank' })[k];
  b = new Browser(config, (line) => { if (line.startsWith('launching')) launches++; });
  b.on('closed', () => closedEvents++);
  b.on('started', () => startedEvents++);
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

test('a restart while the browser is still starting launches a new browser', { timeout: 60000 }, async () => {
  b.close();
  launches = 0; startedEvents = 0;
  const abandoned = b.ensure();
  const old = b.proc;
  b.close();
  const restarted = b.ensure();
  await assert.rejects(abandoned);
  const joined = b.ensure(); // issued after the abandoned start settled, while the new one is still starting
  await Promise.all([restarted, joined]);
  assert.equal(await b.evaluate('1'), 1);
  assert.equal(launches, 2);
  assert.equal(startedEvents, 1);
  await exited(old);
});

test('a restart after the CDP socket opened, before started, launches a new browser', { timeout: 60000 }, async () => {
  b.close();
  launches = 0; startedEvents = 0;
  // Close as the attach reply lands: the abandoned start holds a live session id it must not install.
  const rawSend = b._rawSend;
  let restarted, joined, runningBeforeAttach;
  b._rawSend = function (method, ...rest) {
    const reply = rawSend.call(this, method, ...rest);
    if (method === 'Target.getTargets' && restarted) { b._rawSend = rawSend; runningBeforeAttach = b.running; }
    if (method !== 'Target.attachToTarget' || restarted) return reply;
    return reply.then((r) => { b.close(); restarted = b.ensure(); joined = b.ensure(); return r; });
  };
  const abandoned = b.ensure();
  const old = b.proc;
  await assert.rejects(abandoned);
  assert.equal(restarted, joined);
  await restarted;
  assert.equal(runningBeforeAttach, false); // the new socket is open, but no session is attached yet
  assert.equal(await b.evaluate('1'), 1);
  assert.equal(launches, 2);
  assert.equal(startedEvents, 1);
  await exited(old);
});
