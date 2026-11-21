// End-to-end: JS dialogs against a real headless Chrome/Edge (set CHROME_PATH to override auto-detect).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Browser } = require('../src/browser');
const { handleRpc } = require('../src/mcp');

// A tools/call as an MCP client sends it; resolves to the reply's text and fails the test on a tool error.
let nextId = 1;
const call = async (b, name, args = {}) => {
  const { result } = await handleRpc(b, { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } });
  const text = result.content.map((c) => c.text || '').join('');
  assert.ok(!result.isError, text);
  return text;
};
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

test('a dialog is reported in the result of the tool call that opened it, and logged to the console', { timeout: 10000 }, async () => {
  await call(b, 'browser_console', { clear: true }); // also drains dialogs left by earlier tests
  const text = await call(b, 'browser_click', { selector: '#a' });
  assert.match(text, /\n\nDialogs handled:\n- alert "hi" → accepted$/);
  assert.doesNotMatch(await call(b, 'browser_snapshot'), /Dialogs handled/); // reported once
  assert.match(await call(b, 'browser_console', {}), /\[dialog\] alert "hi" → accepted/);
});
