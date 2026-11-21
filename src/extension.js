const vscode = require('vscode');
const crypto = require('crypto');
const path = require('path');
const { Browser, describeDialog } = require('./browser');
const { createPickStore } = require('./pick');
const { startMcpServer } = require('./mcp');

let browser, server, panel, output, status, picks;

function cfg(key) { return vscode.workspace.getConfiguration('claudeBrowser').get(key); }
function log(s) { output.appendLine(`[${new Date().toLocaleTimeString()}] ${s}`); }

async function deliverPick(pick) {
  const { mdPath, pngPath, markdown } = picks.save(pick);
  await vscode.env.clipboard.writeText(markdown);
  log(`picked ${pick.info.selector} -> ${mdPath}`);

  const uris = [vscode.Uri.file(mdPath), ...(pngPath ? [vscode.Uri.file(pngPath)] : [])];
  try {
    await vscode.commands.executeCommand('claude-vscode.addToChat', uris[0], uris);
    vscode.window.setStatusBarMessage(`$(check) ${pick.info.selector} added to Claude chat (also copied to clipboard)`, 5000);
  } catch (e) {
    log(`addToChat failed: ${e.message}`);
    vscode.window.showInformationMessage(`Element ${pick.info.selector} copied to clipboard — paste it into the Claude chat (Ctrl+V).`);
  }
}

function activate(context) {
  picks = createPickStore(path.join(context.globalStorageUri.fsPath, 'picks'));
  output = vscode.window.createOutputChannel('Claude Browser');
  browser = new Browser(cfg, log);
  const port = cfg('port');
  server = startMcpServer({
    port, browser, log,
    onToolCall: (name) => { log(`tool ${name}`); if (cfg('autoOpenPanel') && !panel) openPanel(true); },
  });

  browser.on('frame', (f) => panel && panel.webview.postMessage({ type: 'frame', data: f.data, w: f.metadata.deviceWidth, h: f.metadata.deviceHeight }));
  browser.on('navigated', (url) => panel && panel.webview.postMessage({ type: 'url', url }));
  browser.on('pickMode', (on) => panel && panel.webview.postMessage({ type: 'pickMode', on }));
  browser.on('picked', (p) => {
    if (panel) panel.webview.postMessage({ type: 'status', text: `Picked ${p.info.selector}` });
    deliverPick(p).catch((e) => { log(`deliver pick: ${e.message}`); vscode.window.showErrorMessage(`Claude Browser: ${e.message}`); });
  });
  browser.on('dialog', (d) => {
    log(`dialog ${describeDialog(d)}`);
    if (panel) panel.webview.postMessage({ type: 'status', text: `Dialog: ${describeDialog(d)}` });
  });
  browser.on('select', (s) => panel && panel.webview.postMessage({ type: 'select', select: s }));
  browser.on('pickError', (e) => panel && panel.webview.postMessage({ type: 'status', text: `Pick failed: ${e.message}` }));
  browser.on('closed',() => panel && panel.webview.postMessage({ type: 'status', text: 'browser closed — press reload to restart' }));

  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = '$(globe) Claude Browser';
  status.tooltip = `MCP: http://127.0.0.1:${port}/mcp`;
  status.command = 'claudeBrowser.open';
  status.show();

  context.subscriptions.push(
    output, status,
    vscode.commands.registerCommand('claudeBrowser.open', () => openPanel(false)),
    vscode.commands.registerCommand('claudeBrowser.restart', async () => { browser.close(); await browser.ensure(); }),
    vscode.commands.registerCommand('claudeBrowser.registerMcp', () => {
      const t = vscode.window.createTerminal('Claude Browser: register MCP');
      t.show();
      t.sendText(`claude mcp add --transport http --scope user claude-browser http://127.0.0.1:${cfg('port')}/mcp`);
    }),
    { dispose: () => { try { server.close(); } catch {} browser.close(); } },
  );
}

function openPanel(preserveFocus) {
  if (panel) { panel.reveal(undefined, preserveFocus); return; }
  panel = vscode.window.createWebviewPanel('claudeBrowser', 'Claude Browser',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus }, { enableScripts: true, retainContextWhenHidden: true });
  // @ts-expect-error WebviewPanel.iconPath is typed Uri | { light, dark } in every VS Code API version; ThemeIcon may not render.
  panel.iconPath = new vscode.ThemeIcon('globe');
  panel.webview.html = html(crypto.randomBytes(16).toString('hex'));

  panel.onDidChangeViewState(({ webviewPanel }) => browser.setScreencast(webviewPanel.visible).catch(() => {}));
  panel.onDidDispose(() => { panel = null; browser.setScreencast(false).catch(() => {}); });
  panel.webview.onDidReceiveMessage(async (m) => {
    try {
      switch (m.type) {
        case 'ready':
          await browser.ensure();
          await browser.setViewport(m.w, m.h);
          await browser.setScreencast(true);
          panel && panel.webview.postMessage({ type: 'url', url: (await browser.info()).url });
          break;
        case 'resize': await browser.setViewport(m.w, m.h); break;
        case 'navigate': await browser.navigate(m.url); break;
        case 'back': await browser.history(-1); break;
        case 'forward': await browser.history(1); break;
        case 'reload': await browser.reload(); break;
        case 'mouse': await browser.mouse(m.event, m.x, m.y, m); break;
        case 'key': await browser.rawKey(m); break;
        case 'pick': await browser.setPickMode(m.on); break;
        case 'selectChoose': await browser.chooseOption(m.token, m.index); break;
      }
    } catch (e) {
      log(`panel ${m.type}: ${e.message}`);
      panel && panel.webview.postMessage({ type: 'status', text: e.message });
    }
  });
}

function html(nonce) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  html,body{margin:0;padding:0;height:100%;overflow:hidden;background:var(--vscode-editor-background);color:var(--vscode-foreground);font:12px var(--vscode-font-family)}
  #bar{display:flex;gap:4px;padding:4px;align-items:center;border-bottom:1px solid var(--vscode-panel-border)}
  button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;border-radius:3px;padding:3px 8px;cursor:pointer}
  button:hover{background:var(--vscode-button-secondaryHoverBackground)}
  button.on{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
  #stage.picking{cursor:crosshair}
  #url{flex:1;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);padding:3px 6px;border-radius:3px}
  #stage{position:absolute;top:33px;left:0;right:0;bottom:0;overflow:hidden;outline:none;background:#fff}
  #stage:focus{box-shadow:inset 0 0 0 1px var(--vscode-focusBorder)}
  #view{position:absolute;left:0;top:0;user-select:none;-webkit-user-drag:none}
  #hint{position:absolute;inset:0;display:none;align-items:center;justify-content:center;text-align:center;color:var(--vscode-descriptionForeground);background:var(--vscode-editor-background);font-size:13px;line-height:1.6;pointer-events:none}
  #msg{position:absolute;left:8px;bottom:6px;padding:2px 6px;background:var(--vscode-editorWidget-background);border-radius:3px;display:none}
  #dropdown{position:absolute;display:none;overflow-y:auto;box-sizing:border-box;background:#fff;color:#000;border:1px solid #767676;box-shadow:0 2px 8px rgba(0,0,0,.25);z-index:5;cursor:default;user-select:none}
  #dropdown div{padding:2px 8px;white-space:pre;overflow:hidden;text-overflow:ellipsis}
  #dropdown .grp{font-weight:bold}
  #dropdown .in{padding-left:20px}
  #dropdown .dis{color:#8a8a8a}
  #dropdown .act{background:#0078d4;color:#fff}
</style></head><body>
<div id="bar"><button id="back" title="Back">&#8592;</button><button id="fwd" title="Forward">&#8594;</button><button id="reload" title="Reload">&#10227;</button><button id="pick" title="Pick an element and add it to the Claude chat (Ctrl+Shift+C, Esc to cancel)">&#8982; Pick</button>
<input id="url" spellcheck="false" placeholder="Enter a URL and press Enter, e.g. localhost:5173"></div>
<div id="stage" tabindex="0"><img id="view" alt=""><div id="hint"><div>No page open.<br>Type a URL in the bar above,<br>or ask Claude to open one (browser_navigate).</div></div><div id="msg"></div><div id="dropdown"></div></div>
<script nonce="${nonce}">
const vs = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const stage = $('stage'), view = $('view'), url = $('url'), msg = $('msg');
let dev = { w: 1, h: 1 };
const size = () => ({ w: stage.clientWidth, h: stage.clientHeight });
let rt; new ResizeObserver(() => { closeSelect(-1); clearTimeout(rt); rt = setTimeout(() => vs.postMessage({ type: 'resize', ...size() }), 120); }).observe(stage);
$('back').onclick = () => vs.postMessage({ type: 'back' });
$('fwd').onclick = () => vs.postMessage({ type: 'forward' });
$('reload').onclick = () => vs.postMessage({ type: 'reload' });
url.onkeydown = (e) => { if (e.key === 'Enter') { vs.postMessage({ type: 'navigate', url: url.value.trim() }); stage.focus(); } };
const pt = (e) => { const r = view.getBoundingClientRect(); return { x: (e.clientX - r.left) * dev.w / (r.width || 1), y: (e.clientY - r.top) * dev.h / (r.height || 1) }; };
const mods = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const btn = (b) => ['left', 'middle', 'right'][b] || 'none';
const send = (event, e, extra) => vs.postMessage({ type: 'mouse', event, ...pt(e), buttons: e.buttons, modifiers: mods(e), ...extra });

// The page's <select> popup, drawn here because the headless Browser leaves it out of the frames.
const dd = $('dropdown');
let sel = null, active = -1, swallowUp = false;
const inDd = (e) => dd.contains(e.target);
const rows = () => [...dd.querySelectorAll('[data-i]')].filter((d) => !d.classList.contains('dis'));
const hideSelect = () => { sel = null; active = -1; dd.style.display = 'none'; dd.textContent = ''; };
const closeSelect = (index) => { if (!sel) return; vs.postMessage({ type: 'selectChoose', token: sel.token, index }); hideSelect(); };
const setActive = (i, scroll) => {
  active = i;
  for (const d of dd.querySelectorAll('[data-i]')) {
    const on = +d.dataset.i === i;
    d.classList.toggle('act', on);
    if (on && scroll) d.scrollIntoView({ block: 'nearest' });
  }
};
const move = (delta) => {
  const list = rows(); if (!list.length) return;
  const at = list.findIndex((d) => +d.dataset.i === active);
  const next = at < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, at + delta));
  setActive(+list[next].dataset.i, true);
};
const typeAhead = (ch) => {
  const list = rows(), at = list.findIndex((d) => +d.dataset.i === active);
  for (let k = 1; k <= list.length; k++) {
    const d = list[(at + k) % list.length];
    if (d.textContent.trim().toLowerCase().startsWith(ch.toLowerCase())) return setActive(+d.dataset.i, true);
  }
};
const showSelect = (s) => {
  hideSelect();
  sel = s;
  let group;
  for (const o of s.options) {
    if (o.group !== undefined && o.group !== group) { const g = document.createElement('div'); g.className = 'grp'; g.textContent = o.group; dd.appendChild(g); }
    group = o.group;
    const d = document.createElement('div');
    d.textContent = o.label || ' ';
    d.dataset.i = o.index;
    d.className = (o.group !== undefined ? 'in' : '') + (o.disabled ? ' dis' : '');
    dd.appendChild(d);
  }
  const r = view.getBoundingClientRect(), st = stage.getBoundingClientRect();
  const sx = r.width ? r.width / dev.w : 1, sy = r.height ? r.height / dev.h : 1;
  const left = r.left - st.left + s.x * sx, top = r.top - st.top + s.y * sy, h = s.height * sy;
  Object.assign(dd.style, { display: 'block', left: '0px', top: '0px', maxHeight: 'none', minWidth: s.width * sx + 'px', maxWidth: stage.clientWidth + 'px', fontFamily: s.fontFamily, fontSize: s.fontSize });
  const below = stage.clientHeight - top - h, above = top;
  const down = below >= Math.min(dd.offsetHeight, 320) || below >= above;
  dd.style.maxHeight = Math.min(320, Math.max(40, (down ? below : above) - 2)) + 'px';
  dd.style.top = (down ? top + h : top - dd.offsetHeight) + 'px';
  dd.style.left = Math.max(0, Math.min(left, stage.clientWidth - dd.offsetWidth)) + 'px';
  setActive(s.selectedIndex, true);
};
dd.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); swallowUp = true; });
dd.addEventListener('mouseover', (e) => { const d = e.target.closest('[data-i]'); if (d && !d.classList.contains('dis')) setActive(+d.dataset.i, false); });
dd.addEventListener('click', (e) => { const d = e.target.closest('[data-i]'); if (d && !d.classList.contains('dis')) { closeSelect(+d.dataset.i); stage.focus(); } });

stage.addEventListener('mousedown', (e) => {
  stage.focus(); e.preventDefault();
  if (sel) { swallowUp = true; closeSelect(-1); return; } // a click outside the popup only closes it, as natively
  send('mousePressed', e, { button: btn(e.button), clickCount: e.detail || 1 });
});
window.addEventListener('mouseup', (e) => { if (swallowUp) { swallowUp = false; return; } send('mouseReleased', e, { button: btn(e.button), clickCount: e.detail || 1 }); });
let pending = null;
stage.addEventListener('mousemove', (e) => { if (inDd(e)) return; if (!pending) requestAnimationFrame(() => { send('mouseMoved', pending, { button: pending.buttons & 1 ? 'left' : pending.buttons & 2 ? 'right' : 'none' }); pending = null; }); pending = e; });
stage.addEventListener('wheel', (e) => {
  if (sel && inDd(e)) return; // scrolls the popup's own list
  e.preventDefault(); closeSelect(-1);
  send('mouseWheel', e, { deltaX: e.deltaX, deltaY: e.deltaY });
}, { passive: false });
stage.addEventListener('contextmenu', (e) => e.preventDefault());
let picking = false;
const setPick = (on) => vs.postMessage({ type: 'pick', on });
$('pick').onclick = () => { setPick(!picking); stage.focus(); };
window.addEventListener('keydown', (e) => {
  if (sel && document.activeElement !== url) {
    e.preventDefault(); e.stopImmediatePropagation();
    const k = e.key;
    if (k === 'Escape' || k === 'Tab' || k === 'F4' || (e.altKey && (k === 'ArrowDown' || k === 'ArrowUp'))) closeSelect(-1);
    else if (k === 'Enter' || k === ' ') closeSelect(active);
    else if (k === 'ArrowDown' || k === 'ArrowUp') move(k === 'ArrowDown' ? 1 : -1);
    else if (k === 'PageDown' || k === 'PageUp') move(k === 'PageDown' ? 10 : -10);
    else if (k === 'Home' || k === 'End') move(k === 'End' ? 1e6 : -1e6);
    else if (k.length === 1 && !e.ctrlKey && !e.metaKey) typeAhead(k);
    return;
  }
  if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) { e.preventDefault(); e.stopImmediatePropagation(); setPick(!picking); }
  else if (picking && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); setPick(false); }
}, true);
for (const t of ['keydown', 'keyup']) stage.addEventListener(t, (e) => {
  e.preventDefault();
  vs.postMessage({ type: 'key', type2: t, key: e.key, code: e.code, keyCode: e.keyCode, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey });
});
let mt;
window.addEventListener('message', ({ data: m }) => {
  if (m.type === 'frame') { dev = { w: m.w, h: m.h }; view.style.width = m.w + 'px'; view.style.height = m.h + 'px'; view.src = 'data:image/jpeg;base64,' + m.data; }
  else if (m.type === 'select') {
    if (!m.select.closed) showSelect(m.select);
    else if (sel && sel.token === m.select.token) hideSelect();
  }
  else if (m.type === 'url') {
    hideSelect();
    const blank = !m.url || m.url === 'about:blank';
    $('hint').style.display = blank ? 'flex' : 'none';
    if (document.activeElement !== url) url.value = blank ? '' : m.url;
    if (blank) url.focus();
  }
  else if (m.type === 'pickMode') { picking = m.on; $('pick').classList.toggle('on', m.on); stage.classList.toggle('picking', m.on); }
  else if (m.type === 'status') { msg.textContent = m.text; msg.style.display = 'block'; clearTimeout(mt); mt = setTimeout(() => msg.style.display = 'none', 5000); }
});
vs.postMessage({ type: 'ready', ...size() });
</script></body></html>`;
}

function deactivate() { if (browser) browser.close(); if (server) server.close(); }

module.exports = { activate, deactivate };
