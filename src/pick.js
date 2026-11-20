// A Pick as text and as files: rendering to markdown and the on-disk Pick store.
// No CDP and no VS Code here — Browser captures the Pick, the extension delivers it.
const fs = require('fs');
const path = require('path');

/** @typedef {{ info: any, png: string | null }} Pick  `png` is base64 or null. */

/**
 * @param {{ info: any }} pick
 * @param {string | null} pngPath  path of the saved screenshot, if any
 */
function pickMarkdown({ info }, pngPath) {
  const attrs = Object.entries(info.attributes).map(([k, v]) => `${k}="${v}"`).join(' ');
  const styles = Object.entries(info.styles).map(([k, v]) => `  ${k}: ${v};`).join('\n');
  return [
    `# Element picked in Claude Browser`,
    ``,
    `- **Page:** ${info.url}${info.title ? ` — "${info.title}"` : ''}`,
    `- **Selector:** \`${info.selector}\``,
    `- **DOM path:** \`${info.path}\``,
    `- **Box (viewport px):** x=${info.box.x} y=${info.box.y} ${info.box.width}×${info.box.height}`,
    attrs ? `- **Attributes:** \`${attrs}\`` : null,
    info.text ? `- **Text:** ${JSON.stringify(info.text)}` : null,
    pngPath ? `- **Screenshot:** ${pngPath}` : null,
    ``,
    `## Computed styles`,
    '```css',
    `${info.selector} {`,
    styles,
    `}`,
    '```',
    ``,
    `## HTML`,
    '```html',
    info.html,
    '```',
  ].filter((l) => l !== null).join('\n');
}

/**
 * Saves Picks as `pick-<stamp>.md` (+ `pick-<stamp>.png` when the Pick has a screenshot) in `dir`,
 * keeping the `keep` newest Picks: every file of an older stamp is deleted, so a Pick's files go together.
 * @param {string} dir
 * @param {{ keep?: number, now?: () => Date }} [opts]
 */
function createPickStore(dir, { keep = 20, now = () => new Date() } = {}) {
  /** @param {string} stamp @param {'md' | 'png'} ext */
  const fileName = (stamp, ext) => `pick-${stamp}.${ext}`;
  const FILE_NAME = /^pick-(.+)\.(md|png)$/;

  /** @param {string} current  the stamp just saved; kept even if the clock went backwards */
  function rotate(current) {
    const byStamp = new Map();
    for (const f of fs.readdirSync(dir)) {
      const m = FILE_NAME.exec(f);
      if (m) byStamp.set(m[1], [...(byStamp.get(m[1]) || []), f]);
    }
    const older = [...byStamp.keys()].filter((s) => s !== current).sort().reverse().slice(keep - 1);
    for (const s of older) for (const f of byStamp.get(s)) fs.rmSync(path.join(dir, f), { force: true });
  }

  return {
    /** @param {Pick} pick */
    save(pick) {
      fs.mkdirSync(dir, { recursive: true });
      const stamp = now().toISOString().replace(/[:.]/g, '-');
      const pngPath = pick.png ? path.join(dir, fileName(stamp, 'png')) : null;
      if (pngPath) fs.writeFileSync(pngPath, Buffer.from(pick.png, 'base64'));
      const markdown = pickMarkdown(pick, pngPath);
      const mdPath = path.join(dir, fileName(stamp, 'md'));
      fs.writeFileSync(mdPath, markdown);
      rotate(stamp);
      return { mdPath, pngPath, markdown };
    },
  };
}

module.exports = { pickMarkdown, createPickStore };
