const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Browser, pickMarkdown, describeDialog } = require('./browser');
const { startMcpServer } = require('./mcp');

let browser, server, panel, output, status, ctx;

function cfg(key) { return vscode.workspace.getConfiguration('claudeBrowser').get(key); }
function log(s) { output.appendLine(`[${new Date().toLocaleTimeString()}] ${s}`); }

async function deliverPick(pick) {
  const dir = path.join(ctx.globalStorageUri.fsPath, 'picks');
  fs.mkdirSync(dir, { recursive: true });
  // keep the 20 most recent picks
  const old = fs.readdirSync(dir).filter((f) => f.startsWith('pick-')).sort();
  for (const f of old.slice(0, Math.max(0, old.length - 38))) fs.rmSync(path.join(dir, f), { force: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const pngPath = pick.png ? path.join(dir, `pick-${stamp}.png`) : null;
  if (pngPath) fs.writeFileSync(pngPath, Buffer.from(pick.png, 'base64'));
  const md = pickMarkdown(pick, pngPath);
  const mdPath = path.join(dir, `pick-${stamp}.md`);
  fs.writeFileSync(mdPath, md);
  await vscode.env.clipboard.writeText(md);
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
  ctx = context;
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
</style></head><body>
<div id="bar"><button id="back" title="Back">&#8592;</button><button id="fwd" title="Forward">&#8594;</button><button id="reload" title="Reload">&#10227;</button><button id="pick" title="Pick an element and add it to the Claude chat (Ctrl+Shift+C, Esc to cancel)">&#8982; Pick</button>
<input id="url" spellcheck="false" placeholder="Enter a URL and press Enter, e.g. localhost:5173"></div>
<div id="stage" tabindex="0"><img id="view" alt=""><div id="hint"><div>No page open.<br>Type a URL in the bar above,<br>or ask Claude to open one (browser_navigate).</div></div><div id="msg"></div></div>
<script nonce="${nonce}">
const vs = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const stage = $('stage'), view = $('view'), url = $('url'), msg = $('msg');
let dev = { w: 1, h: 1 };
const size = () => ({ w: stage.clientWidth, h: stage.clientHeight });
let rt; new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => vs.postMessage({ type: 'resize', ...size() }), 120); }).observe(stage);
$('back').onclick = () => vs.postMessage({ type: 'back' });
$('fwd').onclick = () => vs.postMessage({ type: 'forward' });
$('reload').onclick = () => vs.postMessage({ type: 'reload' });
url.onkeydown = (e) => { if (e.key === 'Enter') { vs.postMessage({ type: 'navigate', url: url.value.trim() }); stage.focus(); } };
const pt = (e) => { const r = view.getBoundingClientRect(); return { x: (e.clientX - r.left) * dev.w / (r.width || 1), y: (e.clientY - r.top) * dev.h / (r.height || 1) }; };
const mods = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const btn = (b) => ['left', 'middle', 'right'][b] || 'none';
const send = (event, e, extra) => vs.postMessage({ type: 'mouse', event, ...pt(e), buttons: e.buttons, modifiers: mods(e), ...extra });
stage.addEventListener('mousedown', (e) => { stage.focus(); e.preventDefault(); send('mousePressed', e, { button: btn(e.button), clickCount: e.detail || 1 }); });
window.addEventListener('mouseup', (e) => send('mouseReleased', e, { button: btn(e.button), clickCount: e.detail || 1 }));
let pending = null;
stage.addEventListener('mousemove', (e) => { if (!pending) requestAnimationFrame(() => { send('mouseMoved', pending, { button: pending.buttons & 1 ? 'left' : pending.buttons & 2 ? 'right' : 'none' }); pending = null; }); pending = e; });
stage.addEventListener('wheel', (e) => { e.preventDefault(); send('mouseWheel', e, { deltaX: e.deltaX, deltaY: e.deltaY }); }, { passive: false });
stage.addEventListener('contextmenu', (e) => e.preventDefault());
let picking = false;
const setPick = (on) => vs.postMessage({ type: 'pick', on });
$('pick').onclick = () => { setPick(!picking); stage.focus(); };
window.addEventListener('keydown', (e) => {
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
  else if (m.type === 'url') {
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
