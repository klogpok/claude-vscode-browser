// Claude Pick content script, injected on each click of the extension's button (a second click cancels).
// Hover highlights an element, a click picks it: its details go to the clipboard as Markdown, in the same
// format as a Pick in Claude Browser. Its screenshot is copied by a second click, on the toast's button:
// the clipboard holds one thing to paste at a time, and saving a file would make Chrome ask where.
(() => {
  const KEY = '__claudePick';
  if (window[KEY]) { window[KEY].stop(); return; }

  // ---------- overlay (in a shadow root, so page CSS cannot touch it) ----------
  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none';
  host.dataset.claudePick = '';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    .box{position:fixed;background:rgba(111,168,220,.45);outline:1px solid #1a73e8;display:none}
    .tag{position:fixed;padding:2px 6px;background:#1f2328;color:#fff;font:12px/1.4 system-ui,sans-serif;border-radius:3px;white-space:nowrap;display:none}
    .toast{position:fixed;right:16px;bottom:16px;max-width:420px;padding:8px 12px;background:#1f2328;color:#fff;font:13px/1.4 system-ui,sans-serif;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.3);pointer-events:auto}
    .row{display:flex;gap:8px;margin-top:8px}
    button{font:inherit;padding:4px 10px;border:0;border-radius:4px;cursor:pointer;background:#3d444d;color:#fff}
    button.main{background:#1a73e8}
  </style><div class="box"></div><div class="tag"></div><div class="toast">Claude Pick: click an element · Esc cancels</div>`;
  const box = root.querySelector('.box'), tag = root.querySelector('.tag'), toast = root.querySelector('.toast');
  document.documentElement.appendChild(host);

  let current = null;
  const elementOf = (e) => { const t = e.composedPath()[0]; return t instanceof Element ? t : null; };

  const onMove = (e) => {
    const el = elementOf(e);
    if (!el || el === current) return;
    current = el;
    const b = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: b.left + 'px', top: b.top + 'px', width: b.width + 'px', height: b.height + 'px' });
    tag.textContent = `${label(el)}  ${Math.round(b.width)}×${Math.round(b.height)}`;
    Object.assign(tag.style, { display: 'block', left: Math.max(0, b.left) + 'px', top: (b.top > 24 ? b.top - 22 : b.bottom + 2) + 'px' });
  };
  // The page must not see the click that picks: swallow every button event while picking.
  const swallow = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
  const onClick = (e) => {
    swallow(e);
    const el = elementOf(e);
    if (el) pick(el).catch((err) => finish(`Claude Pick failed: ${err.message}`));
  };
  const onKey = (e) => { if (e.key === 'Escape') { swallow(e); stop(); } };
  const SWALLOWED = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick', 'contextmenu'];

  addEventListener('mousemove', onMove, true);
  addEventListener('click', onClick, true);
  addEventListener('keydown', onKey, true);
  for (const t of SWALLOWED) addEventListener(t, swallow, true);

  function unlisten() {
    removeEventListener('mousemove', onMove, true);
    removeEventListener('click', onClick, true);
    removeEventListener('keydown', onKey, true);
    for (const t of SWALLOWED) removeEventListener(t, swallow, true);
    delete window[KEY];
  }
  function stop() { unlisten(); host.remove(); }
  let removeTimer;
  // Shows a last message, then removes the overlay after `ms`.
  function finish(text, ms = 3500) {
    unlisten();
    box.style.display = tag.style.display = 'none';
    toast.textContent = text;
    toast.style.display = 'block';
    clearTimeout(removeTimer);
    removeTimer = setTimeout(() => host.remove(), ms);
  }
  window[KEY] = { stop };

  // ---------- the Pick ----------
  async function pick(el) {
    unlisten(); // later events reach the page again, as after Claude Browser's pick
    const info = describe(el);
    // Hide the overlay so it is not in the screenshot, and let the page repaint first.
    host.style.display = 'none';
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    let canvas = null, note = '';
    try {
      canvas = await crop((await send({ type: 'capture' })).dataUrl, el.getBoundingClientRect());
    } catch (err) {
      note = ` (no screenshot: ${err.message})`;
    }
    host.style.display = '';
    await copy(pickMarkdown(info));
    const copied = `Copied ${info.selector}${note} — paste it into Claude (Ctrl+V).`;
    if (canvas) offerShot(copied, canvas, pickLabel(info));
    else finish(copied);
  }

  // The toast after a Pick with a screenshot: the text is in the clipboard, the button copies the picture.
  async function offerShot(text, canvas, name) {
    finish('', 30000);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    toast.innerHTML = '<div></div><div class="row"><button class="main" type="button">Copy screenshot</button><button type="button">✕</button></div>';
    toast.firstChild.textContent = text;
    const [copyBtn, closeBtn] = toast.querySelectorAll('button');
    closeBtn.onclick = () => host.remove();
    copyBtn.onclick = async () => {
      try {
        if (!navigator.clipboard || !navigator.clipboard.write || typeof ClipboardItem !== 'function') throw new Error('no async clipboard');
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        finish('Screenshot copied — paste it into Claude (Ctrl+V).');
      } catch {
        // Plain http:// pages have no async clipboard: copy from an extension tab instead.
        try {
          await send({ type: 'showShot', dataUrl: canvas.toDataURL('image/png'), name: `${name}.png` });
          finish('Screenshot opened in a new tab and copied there.');
        } catch (err) {
          finish(`Could not copy the screenshot: ${err.message}`);
        }
      }
    };
  }

  async function send(msg) {
    const r = await chrome.runtime.sendMessage(msg);
    if (!r || r.error) throw new Error(r ? r.error : 'no answer from the extension');
    return r;
  }

  // The element's box (plus 8px) out of a visible-tab screenshot, as a canvas; null if off-screen.
  async function crop(dataUrl, b) {
    const pad = 8;
    const x1 = Math.max(0, b.left - pad), y1 = Math.max(0, b.top - pad);
    const x2 = Math.min(innerWidth, b.right + pad), y2 = Math.min(innerHeight, b.bottom + pad);
    if (x2 <= x1 || y2 <= y1) return null;
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('bad screenshot')); img.src = dataUrl; });
    const k = img.naturalWidth / innerWidth; // device pixels per CSS pixel, zoom included
    const c = document.createElement('canvas');
    c.width = Math.round((x2 - x1) * k); c.height = Math.round((y2 - y1) * k);
    c.getContext('2d').drawImage(img, x1 * k, y1 * k, c.width, c.height, 0, 0, c.width, c.height);
    return c;
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return; } catch {}
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('clipboard refused');
  }

  // ---------- same data and format as Claude Browser's Pick (src/browser.js DESCRIBE_FN, src/pick.js) ----------
  function selectorOf(el) {
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n.id && document.querySelectorAll('#' + CSS.escape(n.id)).length === 1) { parts.unshift('#' + CSS.escape(n.id)); break; }
      let i = 1; for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++;
      parts.unshift(n.tagName.toLowerCase() + ':nth-of-type(' + i + ')');
    }
    return parts.join(' > ');
  }

  function label(el) {
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.classList.length ? '.' + [...el.classList].join('.') : '');
  }

  function describe(el) {
    const b = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const props = ['display', 'position', 'width', 'height', 'margin', 'padding', 'color', 'background-color', 'background-image',
      'font-family', 'font-size', 'font-weight', 'line-height', 'border', 'border-radius', 'box-shadow', 'opacity', 'z-index',
      'flex-direction', 'justify-content', 'align-items', 'gap', 'grid-template-columns', 'transform', 'cursor'];
    const defaults = { position: 'static', opacity: '1', 'flex-direction': 'row', cursor: 'auto' };
    const flexy = /flex|grid/.test(cs.display);
    const styles = {};
    for (const p of props) {
      const v = cs.getPropertyValue(p);
      if (!v || ['none', 'normal', 'auto', '0px', 'rgba(0, 0, 0, 0)'].includes(v) || defaults[p] === v) continue;
      if (!flexy && ['flex-direction', 'justify-content', 'align-items', 'gap', 'grid-template-columns'].includes(p)) continue;
      styles[p] = v;
    }
    const html = el.outerHTML;
    const path = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) path.unshift(label(n));
    return {
      url: location.href, title: document.title, selector: selectorOf(el), tag: el.tagName.toLowerCase(), path: path.join(' > '),
      text: (el.innerText || '').trim().slice(0, 500),
      attributes: Object.fromEntries([...el.attributes].map((a) => [a.name, a.value.slice(0, 200)])),
      box: { x: Math.round(b.left), y: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) },
      styles, html: html.length > 4000 ? html.slice(0, 4000) + '\n<!-- …truncated, ' + html.length + ' chars total -->' : html,
    };
  }

  function pickLabel(info) {
    const id = info.attributes.id;
    const cls = (info.attributes.class || '').trim().split(/\s+/)[0];
    return (id ? `${info.tag}_${id}` : cls ? `${info.tag}.${cls}` : info.tag).replace(/[^\w.-]/g, '_').slice(0, 48);
  }

  function pickMarkdown(info) {
    const attrs = Object.entries(info.attributes).map(([k, v]) => `${k}="${v}"`).join(' ');
    const styles = Object.entries(info.styles).map(([k, v]) => `  ${k}: ${v};`).join('\n');
    return [
      '# Element picked in Chrome',
      '',
      `- **Page:** ${info.url}${info.title ? ` — "${info.title}"` : ''}`,
      `- **Selector:** \`${info.selector}\``,
      `- **DOM path:** \`${info.path}\``,
      `- **Box (viewport px):** x=${info.box.x} y=${info.box.y} ${info.box.width}×${info.box.height}`,
      attrs ? `- **Attributes:** \`${attrs}\`` : null,
      info.text ? `- **Text:** ${JSON.stringify(info.text)}` : null,
      '',
      '## Computed styles',
      '```css',
      `${info.selector} {`,
      styles,
      '}',
      '```',
      '',
      '## HTML',
      '```html',
      info.html,
      '```',
    ].filter((l) => l !== null).join('\n');
  }
})();
