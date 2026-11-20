// Pick rendering and the Pick store (no Browser needed).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pickMarkdown, createPickStore } = require('../src/pick');

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

test('save writes the .md, and the .png only when the Pick has one', (t) => {
  const store = createPickStore(tempDir(t));

  const bare = store.save({ info: INFO, png: null });
  assert.equal(bare.pngPath, null);
  assert.equal(fs.readFileSync(bare.mdPath, 'utf8'), bare.markdown);
  assert.doesNotMatch(bare.markdown, /Screenshot/);
  assert.deepEqual(fs.readdirSync(path.dirname(bare.mdPath)), [path.basename(bare.mdPath)]);

  const shot = store.save({ info: INFO, png: Buffer.from('png bytes').toString('base64') });
  assert.equal(fs.readFileSync(shot.pngPath, 'utf8'), 'png bytes');
  assert.equal(fs.readFileSync(shot.mdPath, 'utf8'), shot.markdown);
  assert.match(shot.markdown, /- \*\*Screenshot:\*\* (.+)$/m);
  assert.equal(shot.markdown.match(/- \*\*Screenshot:\*\* (.+)$/m)[1], shot.pngPath);
});

test('rotation keeps the 20 newest Picks, counting Picks not files (#6)', (t) => {
  let ms = Date.UTC(2026, 0, 1);
  const store = createPickStore(tempDir(t), { now: () => new Date(ms += 1000) });
  const saved = [];
  for (let i = 0; i < 25; i++) {
    const png = i % 3 === 0 ? null : Buffer.from(`png ${i}`).toString('base64');
    saved.push(store.save({ info: INFO, png }));
  }

  const stampOf = (/** @type {string} */ p) => path.basename(p).replace(/\.(md|png)$/, '');
  const dir = path.dirname(saved[0].mdPath);
  const files = fs.readdirSync(dir);
  const left = [...new Set(files.map(stampOf))].sort();
  assert.deepEqual(left, saved.slice(5).map((s) => stampOf(s.mdPath)));
  for (const s of saved.slice(5)) {
    const expected = [path.basename(s.mdPath), ...(s.pngPath ? [path.basename(s.pngPath)] : [])];
    assert.deepEqual(files.filter((f) => stampOf(f) === stampOf(s.mdPath)).sort(), expected.sort());
  }
});

test('pickMarkdown renders a Pick', () => {
  assert.equal(pickMarkdown({ info: INFO }, '/tmp/pick-1.png'), `# Element picked in Claude Browser

- **Page:** https://example.com/ — "Example"
- **Selector:** \`#go\`
- **DOM path:** \`html > body > button#go\`
- **Box (viewport px):** x=10 y=20 30×40
- **Attributes:** \`id="go" class="btn"\`
- **Text:** "Go"
- **Screenshot:** /tmp/pick-1.png

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
