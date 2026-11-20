// End-to-end: JS dialogs against a real headless Chrome/Edge (set CHROME_PATH to override auto-detect).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Browser } = require('../src/browser');
const { TOOLS } = require('../src/mcp');

const call = (b, name, args = {}) => TOOLS.find((t) => t.name === name).run(b, args);
const title = (b) => b.evaluate('document.title');

const PAGE = 'data:text/html,' + encodeURIComponent(`
  <button id=a onclick="document.title='alert-done:'+(alert('hi'),1)">a</button>
  <button id=c onclick="document.title='confirm:'+confirm('sure?')">c</button>
  <button id=p onclick="document.title='prompt:'+prompt('name?','def')">p</button>`);

let b;
// A cold Chrome start can miss Browser's 20s deadline on a fresh CI runner; retry once (see browser.test.js).
before(async () => {
  b = new Browser((k) => ({ executablePath: process.env.CHROME_PATH || '', startUrl: 'about:blank' })[k], () => {});
  await b.ensure().catch(() => b.ensure());
  await b.navigate(PAGE);
}, { timeout: 60000 });
after(() => b.close());

test('alert does not block the click that opened it', { timeout: 10000 }, async () => {
  await call(b, 'browser_click', { selector: '#a' });
  assert.equal(await title(b), 'alert-done:1');
});

test('confirm is accepted by default', { timeout: 10000 }, async () => {
  await call(b, 'browser_click', { selector: '#c' });
  assert.equal(await title(b), 'confirm:true');
});

test('browser_handle_dialog dismisses the next confirm only', { timeout: 10000 }, async () => {
  await call(b, 'browser_handle_dialog', { accept: false });
  await call(b, 'browser_click', { selector: '#c' });
  assert.equal(await title(b), 'confirm:false');
  await call(b, 'browser_click', { selector: '#c' });
  assert.equal(await title(b), 'confirm:true');
});

test('prompt gets its default text, or the planned text', { timeout: 10000 }, async () => {
  await call(b, 'browser_click', { selector: '#p' });
  assert.equal(await title(b), 'prompt:def');
  await call(b, 'browser_handle_dialog', { accept: true, promptText: 'Ann' });
  await call(b, 'browser_click', { selector: '#p' });
  assert.equal(await title(b), 'prompt:Ann');
});

test('handled dialogs are reported and logged to the console', { timeout: 10000 }, async () => {
  b.takeDialogs();
  await call(b, 'browser_click', { selector: '#a' });
  assert.deepEqual(b.takeDialogs().map((d) => d.type), ['alert']);
  assert.match(await call(b, 'browser_console', {}), /\[dialog\] alert "hi" → accepted/);
});
