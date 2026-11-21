// End-to-end: <select> popups against a real headless Chrome/Edge (set CHROME_PATH to override auto-detect).
// The Browser reports the popup as a 'select' event for the Panel to draw, and applies the Panel's choice.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('events');
const { Browser } = require('../src/browser');

const PAGE = 'data:text/html,' + encodeURIComponent(`
  <body style="margin:0">
  <select id=s style="position:absolute;left:20px;top:30px;width:150px;height:30px">
    <option value="">All</option>
    <optgroup label="Mine"><option value="a">Alpha</option><option value="b" disabled>Beta</option></optgroup>
    <option value="c" hidden>Hidden</option>
    <option value="d">Delta</option>
  </select>
  <button id=other style="position:absolute;left:20px;top:200px">other</button>
  <script>
    window.log = [];
    for (const t of ['input', 'change']) s.addEventListener(t, () => log.push(t + ':' + s.value));
  </script>`);

let b;
// A cold Chrome start can miss Browser's 20s deadline on a fresh CI runner; retry once (see browser.test.js).
before(async () => {
  b = new Browser((k) => ({ executablePath: process.env.CHROME_PATH || '', startUrl: 'about:blank' })[k], () => {});
  await b.ensure().catch(() => b.ensure());
}, { timeout: 60000 });
after(() => b.close());

const openSelect = async () => {
  const opened = once(b, 'select');
  await b.click({ selector: '#s' });
  return (await opened)[0];
};

test('clicking a select reports its options and box instead of a native popup', { timeout: 10000 }, async () => {
  await b.navigate(PAGE);
  const s = await openSelect();
  assert.deepEqual({ x: s.x, y: s.y, width: s.width, height: s.height, selectedIndex: s.selectedIndex },
    { x: 20, y: 30, width: 150, height: 30, selectedIndex: 0 });
  assert.deepEqual(s.options, [
    { index: 0, label: 'All', disabled: false },
    { index: 1, label: 'Alpha', disabled: false, group: 'Mine' },
    { index: 2, label: 'Beta', disabled: true, group: 'Mine' },
    { index: 4, label: 'Delta', disabled: false },
  ]);
  assert.equal(await b.evaluate('document.activeElement.id'), 's');
  assert.equal(await b.chooseOption(s.token, -1), false);
});

test('choosing an option sets the value and fires input and change', { timeout: 10000 }, async () => {
  await b.navigate(PAGE);
  const s = await openSelect();
  assert.equal(await b.chooseOption(s.token, 4), true);
  assert.equal(await b.evaluate('s.value'), 'd');
  assert.deepEqual(await b.evaluate('log'), ['input:d', 'change:d']);
  // The popup is closed now: its token applies nothing.
  assert.equal(await b.chooseOption(s.token, 1), false);
  assert.equal(await b.evaluate('s.value'), 'd');
});

test('choosing the current option fires nothing', { timeout: 10000 }, async () => {
  await b.navigate(PAGE);
  const s = await openSelect();
  assert.equal(await b.chooseOption(s.token, 0), true);
  assert.deepEqual(await b.evaluate('log'), []);
});

test('the popup closes when the select loses focus or is clicked again', { timeout: 10000 }, async () => {
  await b.navigate(PAGE);
  let s = await openSelect();
  let closed = once(b, 'select');
  await b.click({ selector: '#other' });
  assert.deepEqual((await closed)[0], { token: s.token, closed: true });

  s = await openSelect();
  closed = once(b, 'select');
  await b.click({ selector: '#s' });
  assert.deepEqual((await closed)[0], { token: s.token, closed: true });
});

test('Alt+ArrowDown on a focused select opens the popup', { timeout: 10000 }, async () => {
  await b.navigate(PAGE);
  await b.evaluate('s.focus()');
  const opened = once(b, 'select');
  await b.rawKey({ type2: 'keydown', key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, altKey: true });
  await b.rawKey({ type2: 'keyup', key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, altKey: true });
  assert.equal((await opened)[0].options.length, 4);
});
