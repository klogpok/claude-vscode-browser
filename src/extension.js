const vscode = require('vscode');
const crypto = require('crypto');
const { Browser } = require('./browser');
const { startMcpServer } = require('./mcp');

let browser, server, panel, output, status;

function cfg(key) { return vscode.workspace.getConfiguration('claudeBrowser').get(key); }
function log(s) { output.appendLine(`[${new Date().toLocaleTimeString()}] ${s}`); }

function activate(context) {
  output = vscode.window.createOutputChannel('Claude Browser');
  browser = new Browser(cfg, log);
  const port = cfg('port');
  server = startMcpServer({
    port, browser, log,
    onToolCall: (name) => { log(`tool ${name}`); if (cfg('autoOpenPanel') && !panel) openPanel(true); },
  });

  browser.on('frame', (f) => panel && panel.webview.postMessage({ type: 'frame', data: f.data, w: f.metadata.deviceWidth, h: f.metadata.deviceHeight }));
  browser.on('navigated', (url) => panel && panel.webview.postMessage({ type: 'url', url }));
  browser.on('closed', () => panel && panel.webview.postMessage({ type: 'status', text: 'browser closed — press reload to restart' }));

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
  html,body{margin:0;height:100%;overflow:hidden;background:var(--vscode-editor-background);color:var(--vscode-foreground);font:12px var(--vscode-font-family)}
  #bar{display:flex;gap:4px;padding:4px;align-items:center;border-bottom:1px solid var(--vscode-panel-border)}
  button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;border-radius:3px;padding:3px 8px;cursor:pointer}
  button:hover{background:var(--vscode-button-secondaryHoverBackground)}
  #url{flex:1;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);padding:3px 6px;border-radius:3px}
  #stage{position:absolute;top:33px;left:0;right:0;bottom:0;overflow:hidden;outline:none;background:#fff}
  #stage:focus{box-shadow:inset 0 0 0 1px var(--vscode-focusBorder)}
  #view{position:absolute;left:0;top:0;user-select:none;-webkit-user-drag:none}
  #msg{position:absolute;left:8px;bottom:6px;padding:2px 6px;background:var(--vscode-editorWidget-background);border-radius:3px;display:none}
</style></head><body>
<div id="bar"><button id="back" title="Back">&#8592;</button><button id="fwd" title="Forward">&#8594;</button><button id="reload" title="Reload">&#10227;</button>
<input id="url" spellcheck="false" placeholder="http://localhost:5173"></div>
<div id="stage" tabindex="0"><img id="view" alt=""><div id="msg"></div></div>
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
for (const t of ['keydown', 'keyup']) stage.addEventListener(t, (e) => {
  e.preventDefault();
  vs.postMessage({ type: 'key', type2: t, key: e.key, code: e.code, keyCode: e.keyCode, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey });
});
let mt;
window.addEventListener('message', ({ data: m }) => {
  if (m.type === 'frame') { dev = { w: m.w, h: m.h }; view.style.width = m.w + 'px'; view.style.height = m.h + 'px'; view.src = 'data:image/jpeg;base64,' + m.data; }
  else if (m.type === 'url') { if (document.activeElement !== url) url.value = m.url === 'about:blank' ? '' : m.url; }
  else if (m.type === 'status') { msg.textContent = m.text; msg.style.display = 'block'; clearTimeout(mt); mt = setTimeout(() => msg.style.display = 'none', 5000); }
});
vs.postMessage({ type: 'ready', ...size() });
</script></body></html>`;
}

function deactivate() { if (browser) browser.close(); if (server) server.close(); }

module.exports = { activate, deactivate };
