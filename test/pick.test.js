// Pick rendering and the Pick store (no Browser needed).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pickMarkdown, pickLabel, createPickStore } = require('../src/pick');

const INFO = {
  url: 'https://example.com/', title: 'Example', selector: '#go', tag: 'button', path: 'html > body > button#go',
  text: 'Go', attributes: { id: 'go', class: 'btn' },
  box: { x: 10, y: 20, width: 30, height: 40 }, pageBox: { x: 10, y: 20, width: 30, height: 40 },
  styles: { display: 'block', color: 'rgb(0, 0, 0)' }, html: '<button id="go" class="btn">Go</button>',
};

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-picks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'picks'); // not created yet: save must create it
}

test('pickLabel names the element by tag and id, else tag and first class', () => {
  assert.equal(pickLabel(INFO), 'button#go');
  assert.equal(pickLabel({ tag: 'div', attributes: { class: ' acUsEb Q6KTif KEY6ib' } }), 'div.acUsEb');
  assert.equal(pickLabel({ tag: 'p', attributes: {} }), 'p');
  assert.equal(pickLabel({ tag: 'a', attributes: { id: 'x:y/z' } }), 'a#x_y_z');
  assert.equal(pickLabel({ tag: 'div', attributes: { class: 'a'.repeat(100) } }).length, 48);
});

test('save writes <stamp>/<label>.md, and the .png only when the Pick has one', (t) => {
  const store = createPickStore(tempDir(t));

  const bare = store.save({ info: INFO, png: null });
  assert.equal(bare.pngPath, null);
  assert.equal(path.basename(bare.mdPath), 'button#go.md');
  assert.equal(fs.readFileSync(bare.mdPath, 'utf8'), bare.markdown);
  assert.doesNotMatch(bare.markdown, /Screenshot/);
  assert.deepEqual(fs.readdirSync(path.dirname(bare.mdPath)), ['button#go.md']);

  const shot = store.save({ info: INFO, png: Buffer.from('png bytes').toString('base64') });
  assert.equal(path.basename(shot.pngPath), 'button#go.png');
  assert.equal(path.dirname(shot.pngPath), path.dirname(shot.mdPath));
  assert.notEqual(path.dirname(shot.mdPath), path.dirname(bare.mdPath));
  assert.equal(fs.readFileSync(shot.pngPath, 'utf8'), 'png bytes');
  assert.equal(fs.readFileSync(shot.mdPath, 'utf8'), shot.markdown);
  assert.equal(shot.markdown.match(/- \*\*Screenshot:\*\* (.+)$/m)[1], shot.pngPath);
  assert.match(shot.markdown, /^!\[Screenshot\]\(button%23go\.png\)$/m);
});

test('rotation keeps the 20 newest Picks, deleting older Pick folders whole (#6)', (t) => {
  let ms = Date.UTC(2026, 0, 1);
  const store = createPickStore(tempDir(t), { now: () => new Date(ms += 1000) });
  const saved = [];
  for (let i = 0; i < 25; i++) {
    const png = i % 3 === 0 ? null : Buffer.from(`png ${i}`).toString('base64');
    saved.push(store.save({ info: INFO, png }));
  }

  const root = path.dirname(path.dirname(saved[0].mdPath));
  const stampOf = (/** @type {string} */ p) => path.basename(path.dirname(p));
  assert.deepEqual(fs.readdirSync(root).sort(), saved.slice(5).map((s) => stampOf(s.mdPath)));
  for (const s of saved.slice(5)) {
    const expected = [path.basename(s.mdPath), ...(s.pngPath ? [path.basename(s.pngPath)] : [])];
    assert.deepEqual(fs.readdirSync(path.dirname(s.mdPath)).sort(), expected.sort());
  }
});

test('save removes Picks left in the old flat layout', (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['pick-2026-01-01T00-00-00-000Z.md', 'pick-2026-01-01T00-00-00-000Z.png', 'notes.txt']) {
    fs.writeFileSync(path.join(dir, f), '');
  }
  const s = createPickStore(dir).save({ info: INFO, png: null });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['notes.txt', path.basename(path.dirname(s.mdPath))].sort());
});

test('pickMarkdown renders a Pick', () => {
  assert.equal(pickMarkdown({ info: INFO }, '/tmp/1/button#go.png'), `# Element picked in Claude Browser

![Screenshot](button%23go.png)

- **Page:** https://example.com/ — "Example"
- **Selector:** \`#go\`
- **DOM path:** \`html > body > button#go\`
- **Box (viewport px):** x=10 y=20 30×40
- **Attributes:** \`id="go" class="btn"\`
- **Text:** "Go"
- **Screenshot:** /tmp/1/button#go.png

## Computed styles
\`\`\`css
#go {
  display: block;
  color: rgb(0, 0, 0);
}
\`\`\`

## HTML
\`\`\`html
<button id="go" class="btn">Go</button>
\`\`\``);
});
