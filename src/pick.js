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
    // Relative, so the Markdown preview of the saved file shows the element.
    pngPath ? `![Screenshot](${encodeURIComponent(path.basename(pngPath))})` : null,
    pngPath ? `` : null,
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
 * A short, file-name-safe name for the picked element, as the chat shows it: tag plus id, else tag
 * plus first class (`button_go`, `div.acUsEb`). No `#`: Claude Code's Add to chat refuses any path
 * containing one, so `button#go.md` would never reach the chat.
 * @param {{ tag?: string, attributes?: Record<string, string> }} info
 */
function pickLabel(info) {
  const tag = info.tag || 'element';
  const id = info.attributes?.id;
  const cls = (info.attributes?.class || '').trim().split(/\s+/)[0];
  const label = id ? `${tag}_${id}` : cls ? `${tag}.${cls}` : tag;
  return label.replace(/[^\w.-]/g, '_').slice(0, 48);
}

const STAMP_DIR = /^\d{4}-\d\d-\d\dT[\d-]+Z$/;
const LEGACY_FILE = /^pick-.+\.(md|png)$/; // flat layout before Picks got a folder each

/**
 * Saves each Pick in its own folder `<stamp>/` as `<label>.md` (+ `<label>.png` when the Pick has a
 * screenshot), so the chat shows the element's name rather than a timestamp. Keeps the `keep` newest
 * Picks: an older Pick's folder is deleted whole.
 * @param {string} dir
 * @param {{ keep?: number, now?: () => Date }} [opts]
 */
function createPickStore(dir, { keep = 20, now = () => new Date() } = {}) {
  /** @param {string} current  the stamp just saved; kept even if the clock went backwards */
  function rotate(current) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) if (e.isFile() && LEGACY_FILE.test(e.name)) fs.rmSync(path.join(dir, e.name), { force: true });
    const stamps = entries.filter((e) => e.isDirectory() && STAMP_DIR.test(e.name)).map((e) => e.name);
    const older = stamps.filter((s) => s !== current).sort().reverse().slice(keep - 1);
    for (const s of older) fs.rmSync(path.join(dir, s), { recursive: true, force: true });
  }

  return {
    /** @param {Pick} pick */
    save(pick) {
      const stamp = now().toISOString().replace(/[:.]/g, '-');
      const pickDir = path.join(dir, stamp);
      fs.mkdirSync(pickDir, { recursive: true });
      const label = pickLabel(pick.info);
      const pngPath = pick.png ? path.join(pickDir, `${label}.png`) : null;
      if (pngPath) fs.writeFileSync(pngPath, Buffer.from(pick.png, 'base64'));
      const markdown = pickMarkdown(pick, pngPath);
      const mdPath = path.join(pickDir, `${label}.md`);
      fs.writeFileSync(mdPath, markdown);
      rotate(stamp);
      return { mdPath, pngPath, markdown };
    },
  };
}

module.exports = { pickMarkdown, pickLabel, createPickStore };
