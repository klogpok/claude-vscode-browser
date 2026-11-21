// End-to-end: the Claude Pick Chrome extension's picker (chrome-extension/picker.js) in a real headless Chrome/Edge.
// The extension's service worker and the clipboard are stubbed in the page: capture returns a blank
// viewport-sized PNG, the clipboard records what was written, showShot records the screenshot it was given.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Browser } = require('../src/browser');

const PICKER = fs.readFileSync(path.join(__dirname, '..', 'chrome-extension', 'picker.js'), 'utf8');

const PAGE = 'data:text/html,' + encodeURIComponent(`<title>Shop</title>
  <body style="margin:0">
  <button id=go class="btn primary" style="position:absolute;left:50px;top:60px;width:100px;height:40px;color:rgb(255, 0, 0)"
    onclick="window.clicked = (window.clicked || 0) + 1">Go</button>`);

// A data: page is no secure context, so it has neither navigator.clipboard nor ClipboardItem of its own.
const STUBS = `(() => {
  window.copied = undefined; window.images = []; window.shown = [];
  const capture = () => { const c = document.createElement('canvas'); c.width = innerWidth; c.height = innerHeight; return c.toDataURL('image/png'); };
  Object.defineProperty(window, 'chrome', { configurable: true, writable: true, value: { runtime: { sendMessage: async (m) => {
    if (m.type === 'capture') return { dataUrl: capture() };
    if (m.type === 'showShot') { shown.push(m); return { ok: true }; }
    return { error: 'unknown ' + m.type };
  } } } });
  window.ClipboardItem = class { constructor(items) { this.items = items; } };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async (t) => { window.copied = t; },
    write: async ([item]) => { const [type] = Object.keys(item.items); images.push({ type, blob: item.items[type] }); },
  } });
})()`;

let b;
// A cold Chrome start can miss Browser's 20s deadline on a fresh CI runner; retry once (see browser.test.js).
before(async () => {
  b = new Browser((k) => ({ executablePath: process.env.CHROME_PATH || '', startUrl: 'about:blank' })[k], () => {});
  await b.ensure().catch(() => b.ensure());
  await b.setViewport(800, 600);
}, { timeout: 60000 });
after(() => b.close());

const start = async (extra = '') => {
  await b.navigate(PAGE);
  await b.evaluate(STUBS);
  if (extra) await b.evaluate(extra);
  await b.evaluate(PICKER);
};
const until = (expr) => b.evaluate(`new Promise((resolve) => { const t = setInterval(() => { const v = ${expr}; if (v) { clearInterval(t); resolve(v); } }, 20); })`);
const waitCopied = () => until('window.copied');
const toast = () => 'document.querySelector("[data-claude-pick]").shadowRoot.querySelector(".toast")';
// Clicks a toast button with a real (trusted) click, as the user would.
const clickToastButton = async (index) => {
  const r = await until(`(() => { const btn = ${toast()}.querySelectorAll('button')[${index}]; if (!btn) return null; const b = btn.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  await b.clickAt(r.x, r.y);
};
const imageSize = (expr) => b.evaluate(`new Promise((r) => { const i = new Image(); i.onload = () => r([i.naturalWidth, i.naturalHeight]); i.src = ${expr}; })`);

test('a click picks the element: Markdown to the clipboard, page never sees the click', { timeout: 10000 }, async () => {
  await start();
  await b.mouse('mouseMoved', 100, 80);
  await b.clickAt(100, 80);
  const md = await waitCopied();
  assert.equal(await b.evaluate('window.clicked'), undefined);

  assert.match(md, /^# Element picked in Chrome\n/);
  assert.match(md, /- \*\*Page:\*\* data:text\/html,.* — "Shop"/);
  assert.match(md, /- \*\*Selector:\*\* `#go`/);
  assert.match(md, /- \*\*DOM path:\*\* `html > body > button#go\.btn\.primary`/);
  assert.match(md, /- \*\*Box \(viewport px\):\*\* x=50 y=60 100×40/);
  assert.match(md, /- \*\*Text:\*\* "Go"/);
  assert.ok(!md.includes('Screenshot'));
  assert.match(md, /#go \{\n[^}]*color: rgb\(255, 0, 0\);/);
  assert.match(md, /```html\n<button id="go"/);
  assert.match(await b.evaluate(`${toast()}.textContent`), /Copied #go — paste it into Claude/);

  // Picking is over: the next click reaches the page again.
  await b.clickAt(100, 80);
  assert.equal(await b.evaluate('window.clicked'), 1);
});

test('the toast button copies the screenshot: the button box plus 8px, as a PNG', { timeout: 10000 }, async () => {
  await start();
  await b.clickAt(100, 80);
  await waitCopied();
  await clickToastButton(0);
  await until('images.length');
  assert.equal(await b.evaluate('images[0].type'), 'image/png');
  assert.deepEqual(await imageSize('URL.createObjectURL(images[0].blob)'), [116, 56]);
  assert.match(await b.evaluate(`${toast()}.textContent`), /Screenshot copied/);
  assert.equal(await b.evaluate('window.clicked'), undefined);
});

test('without the async clipboard the screenshot opens in an extension tab', { timeout: 10000 }, async () => {
  await start(`navigator.clipboard.write = undefined;`);
  await b.clickAt(100, 80);
  await waitCopied();
  await clickToastButton(0);
  await until('shown.length');
  assert.equal(await b.evaluate('shown[0].name'), 'button_go.png');
  assert.deepEqual(await imageSize('shown[0].dataUrl'), [116, 56]);
});

test('the toast close button removes the overlay', { timeout: 10000 }, async () => {
  await start();
  await b.clickAt(100, 80);
  await waitCopied();
  await clickToastButton(1);
  assert.equal(await b.evaluate('!!document.querySelector("[data-claude-pick]")'), false);
});

test('Esc cancels picking and copies nothing', { timeout: 10000 }, async () => {
  await start();
  await b.pressKey('Escape');
  await b.clickAt(100, 80);
  assert.equal(await b.evaluate('window.clicked'), 1);
  assert.equal(await b.evaluate('window.copied'), undefined);
});

test('a second start cancels picking, like a second click on the button', { timeout: 10000 }, async () => {
  await start();
  await b.evaluate(PICKER);
  await b.clickAt(100, 80);
  assert.equal(await b.evaluate('window.clicked'), 1);
  assert.equal(await b.evaluate('window.copied'), undefined);
});

test('without writeText the Markdown is copied with execCommand', { timeout: 10000 }, async () => {
  await start(`
    navigator.clipboard.writeText = async () => { throw new Error('Document is not focused'); };
    document.addEventListener('copy', (e) => { window.copied = e.target.value; });`);
  await b.clickAt(100, 80);
  assert.match(await waitCopied(), /- \*\*Selector:\*\* `#go`/);
});

test('a failed screenshot still copies the Markdown, and offers no screenshot', { timeout: 10000 }, async () => {
  await start(`chrome.runtime.sendMessage = async () => ({ error: 'capture refused' })`);
  await b.clickAt(100, 80);
  assert.match(await waitCopied(), /- \*\*Selector:\*\* `#go`/);
  const t = await b.evaluate(`${toast()}.textContent`);
  assert.match(t, /no screenshot: capture refused/);
  assert.equal(await b.evaluate(`${toast()}.querySelectorAll('button').length`), 0);
});
