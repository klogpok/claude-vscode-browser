// Headless Chrome/Edge driven over the Chrome DevTools Protocol, no dependencies.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const CANDIDATES = {
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
};

function findBrowser(configured) {
  if (configured) return configured;
  const found = (CANDIDATES[process.platform] || []).find((p) => p && fs.existsSync(p));
  if (!found) throw new Error('Chrome/Edge not found. Set "claudeBrowser.executablePath".');
  return found;
}

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Space: { code: 'Space', keyCode: 32, text: ' ', key: ' ' },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
};

const SELECTOR_FN = `(el) => {
  if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
  const parts = [];
  for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
    if (n.id && document.querySelectorAll('#' + CSS.escape(n.id)).length === 1) { parts.unshift('#' + CSS.escape(n.id)); break; }
    let i = 1; for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++;
    parts.unshift(n.tagName.toLowerCase() + ':nth-of-type(' + i + ')');
  }
  return parts.join(' > ');
}`;

// Runs with `this` = the picked node.
const DESCRIBE_FN = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  const sel = ${SELECTOR_FN};
  const b = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const props = ['display','position','width','height','margin','padding','color','background-color','background-image',
    'font-family','font-size','font-weight','line-height','border','border-radius','box-shadow','opacity','z-index',
    'flex-direction','justify-content','align-items','gap','grid-template-columns','transform','cursor'];
  const styles = {};
  const defaults = { position: 'static', opacity: '1', 'flex-direction': 'row', cursor: 'auto' };
  const flexy = /flex|grid/.test(cs.display);
  for (const p of props) {
    const v = cs.getPropertyValue(p);
    if (!v || ['none', 'normal', 'auto', '0px', 'rgba(0, 0, 0, 0)'].includes(v) || defaults[p] === v) continue;
    if (!flexy && ['flex-direction', 'justify-content', 'align-items', 'gap', 'grid-template-columns'].includes(p)) continue;
    styles[p] = v;
  }
  const html = el.outerHTML;
  const path = [];
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) path.unshift(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.classList.length ? '.' + [...n.classList].join('.') : ''));
  return {
    url: location.href, title: document.title, selector: sel(el), tag: el.tagName.toLowerCase(), path: path.join(' > '),
    text: (el.innerText || '').trim().slice(0, 500),
    attributes: Object.fromEntries([...el.attributes].map((a) => [a.name, a.value.slice(0, 200)])),
    box: { x: Math.round(b.left), y: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) },
    pageBox: { x: b.left + scrollX, y: b.top + scrollY, width: b.width, height: b.height },
    styles, html: html.length > 4000 ? html.slice(0, 4000) + '\\n<!-- …truncated, ' + html.length + ' chars total -->' : html,
  };
}`;

const HIGHLIGHT = {
  showInfo: true, showStyles: true, showAccessibilityInfo: false,
  contentColor: { r: 111, g: 168, b: 220, a: 0.55 }, paddingColor: { r: 147, g: 196, b: 125, a: 0.45 },
  borderColor: { r: 255, g: 229, b: 153, a: 0.6 }, marginColor: { r: 246, g: 178, b: 107, a: 0.45 },
};

function describeDialog(d) {
  const answer = d.accept ? (d.promptText !== undefined ? `accepted with ${JSON.stringify(d.promptText)}` : 'accepted') : 'dismissed';
  return `${d.type} ${JSON.stringify(d.message)} → ${answer}`;
}

class Browser extends EventEmitter {
  constructor(getConfig, log) {
    super();
    this.getConfig = getConfig;
    this.log = log;
    this.proc = null;
    this.ws = null;
    this.sessionId = null;
    this.nextId = 1;
    this.pending = new Map();
    this._console = [];
    this._viewport = { width: 1280, height: 800 };
    this.screencasting = false;
    this.starting = null;
    this.loadWaiters = [];
    this.dialogPlan = null; // one-shot answer for the next JS dialog: { accept, promptText }
    this.dialogs = []; // dialogs handled since the last takeDialogs()
  }

  get running() { return !!this.sessionId && this.ws && this.ws.readyState === 1; }

  ensure() {
    if (this.running) return Promise.resolve();
    if (!this.starting) this.starting = this._start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async _start() {
    const exe = findBrowser(this.getConfig('executablePath'));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-'));
    this.dataDir = dataDir;
    const args = [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dataDir}`,
      '--no-first-run', '--no-default-browser-check', '--enable-unsafe-swiftshader',
      '--hide-scrollbars', `--window-size=${this._viewport.width},${this._viewport.height}`, 'about:blank',
    ];
    this.log(`launching ${exe}`);
    const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.proc = proc;
    const wsUrl = await new Promise((resolve, reject) => {
      let buf = '';
      // Kill a browser that missed the deadline: left running, it leaks and keeps this process alive.
      const timer = setTimeout(() => { proc.kill(); reject(new Error('browser did not start in 20s')); }, 20000);
      proc.stderr.on('data', (d) => {
        buf += d.toString();
        const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      });
      proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`browser exited (${code})`)); });
    });
    // Events from a process or socket that close() or a later start already replaced must not touch this session.
    proc.on('exit', () => {
      if (this.proc !== proc) return;
      this.log('browser exited');
      this._reset();
      this.emit('closed');
    });

    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP websocket failed')); });
    ws.onmessage = (ev) => this._onMessage(JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()));
    ws.onclose = () => { if (this.ws === ws) this._reset(); };

    const { targetInfos } = await this._rawSend('Target.getTargets', {}, null);
    let page = targetInfos.find((t) => t.type === 'page');
    const targetId = page ? page.targetId : (await this._rawSend('Target.createTarget', { url: 'about:blank' }, null)).targetId;
    this.sessionId = (await this._rawSend('Target.attachToTarget', { targetId, flatten: true }, null)).sessionId;

    await Promise.all([this._rawSend('Page.enable'), this._rawSend('Runtime.enable'), this._rawSend('Log.enable')]);
    await this.setViewport(this._viewport.width, this._viewport.height);
    if (this.screencasting) await this._startScreencast();
    const start = this.getConfig('startUrl');
    if (start && start !== 'about:blank') await this.navigate(start).catch((e) => this.log(String(e)));
    this.emit('started');
  }

  _reset() {
    this.sessionId = null;
    if (this.picking) { this.picking = false; this.emit('pickMode', false); }
    for (const { reject } of this.pending.values()) reject(new Error('browser closed'));
    this.pending.clear();
  }

  close() {
    try { if (this.ws) this.ws.close(); } catch {}
    try { if (this.proc) this.proc.kill(); } catch {}
    this._reset();
    this.ws = null; this.proc = null;
    if (this.dataDir) { const d = this.dataDir; setTimeout(() => fs.rm(d, { recursive: true, force: true }, () => {}), 1500); }
  }

  // Every CDP call goes through here, so no action can reach a dead browser: it is (re)started first.
  async _send(method, params = {}) {
    await this.ensure();
    return this._rawSend(method, params);
  }

  _rawSend(method, params = {}, sessionId = this.sessionId) {
    const id = this.nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify(msg));
    });
  }

  _onMessage(msg) {
    if (msg.id) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    const { method, params } = msg;
    switch (method) {
      case 'Page.screencastFrame':
        this._rawSend('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
        this.emit('frame', params);
        break;
      case 'Page.loadEventFired':
        this.loadWaiters.splice(0).forEach((f) => f());
        break;
      case 'Page.frameNavigated':
        if (!params.frame.parentId) this.emit('navigated', params.frame.url);
        break;
      case 'Runtime.consoleAPICalled':
        this._pushConsole(params.type, params.args.map(fmtRemote).join(' '));
        break;
      case 'Runtime.exceptionThrown': {
        const d = params.exceptionDetails;
        this._pushConsole('exception', (d.exception && d.exception.description) || d.text);
        break;
      }
      case 'Log.entryAdded':
        this._pushConsole(params.entry.level, `${params.entry.text}${params.entry.url ? ' @ ' + params.entry.url : ''}`);
        break;
      case 'Page.javascriptDialogOpening':
        this._onDialog(params);
        break;
      case 'Overlay.inspectNodeRequested':
        this._onPick(params.backendNodeId).catch((e) => { this.log(`pick failed: ${e.message}`); this.emit('pickError', e); });
        break;
    }
  }

  // ---------- element picker (Chrome's own inspect overlay) ----------
  async setPickMode(on) {
    if (on) { await this._send('DOM.enable'); await this._send('Overlay.enable'); }
    else if (!this.picking) return;
    await this._send('Overlay.setInspectMode', { mode: on ? 'searchForNode' : 'none', highlightConfig: HIGHLIGHT });
    this.picking = on;
    this.emit('pickMode', on);
  }

  // The element the user last picked: { info, png } or null.
  get picked() { return this._lastPick || null; }

  async _onPick(backendNodeId) {
    await this.setPickMode(false);
    const { object } = await this._send('DOM.resolveNode', { backendNodeId });
    const r = await this._send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: DESCRIBE_FN, returnByValue: true });
    const info = r.result.value;
    let png = null;
    const b = info.pageBox;
    if (b.width > 0 && b.height > 0) {
      const pad = 8;
      const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
      const clip = { x, y, width: Math.min(b.width + 2 * pad, 4000), height: Math.min(b.height + 2 * pad, 4000), scale: 1 };
      png = (await this._send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true }).catch(() => ({}))).data || null;
    }
    this._lastPick = { info, png };
    this.emit('picked', this._lastPick);
  }

  // ---------- JS dialogs (alert/confirm/prompt/beforeunload) ----------
  // A headless page has nobody to answer a native dialog, and an open one stalls every later CDP call.
  // So answer each dialog immediately: with the plan set via setDialogPlan(), else accept with the default text.
  _onDialog({ type, message, defaultPrompt }) {
    const plan = this.dialogPlan || { accept: true, promptText: undefined };
    this.dialogPlan = null;
    const accept = plan.accept !== false;
    const promptText = type === 'prompt' && accept ? (plan.promptText ?? defaultPrompt ?? '') : undefined;
    const d = { type, message, accept, promptText };
    this._send('Page.handleJavaScriptDialog', promptText === undefined ? { accept } : { accept, promptText })
      .catch((e) => this.log(`handle dialog: ${e.message}`));
    this.dialogs.push(d);
    if (this.dialogs.length > 50) this.dialogs.shift();
    this._pushConsole('dialog', describeDialog(d));
    this.emit('dialog', d);
  }

  setDialogPlan(accept, promptText) { this.dialogPlan = { accept, promptText }; }

  takeDialogs() { return this.dialogs.splice(0); }

  // Console messages, page exceptions, log entries and handled dialogs, oldest first (last 500).
  consoleLog({ errorsOnly = false, clear = false } = {}) {
    const list = errorsOnly ? this._console.filter((m) => /error|exception|warn/.test(m.level)) : this._console.slice();
    if (clear) this._console = [];
    return list;
  }

  _pushConsole(level, text) {
    this._console.push({ level, text, time: new Date().toISOString() });
    if (this._console.length > 500) this._console.shift();
  }

  // Applied now if the browser runs, else when it next starts. Returns the clamped size.
  async setViewport(width, height) {
    this._viewport = { width: Math.max(200, Math.round(width)), height: Math.max(150, Math.round(height)) };
    if (this.running) await this._send('Emulation.setDeviceMetricsOverride', { ...this._viewport, deviceScaleFactor: 1, mobile: false });
    return { ...this._viewport };
  }

  async setScreencast(on) {
    this.screencasting = on;
    if (!this.running) return;
    if (on) await this._startScreencast();
    else await this._send('Page.stopScreencast').catch(() => {});
  }

  _startScreencast() {
    return this._send('Page.startScreencast', { format: 'jpeg', quality: 75, everyNthFrame: 1 });
  }

  // ---------- high-level actions ----------
  // navigate/history/reload start the browser before arming _waitLoad, so the start-up page load can't satisfy it.
  async navigate(url) {
    await this.ensure();
    url = url.trim();
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !/^(about|data|javascript|blob|chrome):/i.test(url)) url = (/^(localhost|127\.|\[::1\])/.test(url) ? 'http://' : 'https://') + url;
    const loaded = this._waitLoad(15000);
    const r = await this._send('Page.navigate', { url });
    if (r.errorText) throw new Error(`navigation failed: ${r.errorText}`);
    await loaded;
    return this.info();
  }

  _waitLoad(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.loadWaiters.push(() => { clearTimeout(t); resolve(); });
    });
  }

  async history(delta) {
    await this.ensure();
    const { currentIndex, entries } = await this._send('Page.getNavigationHistory');
    const e = entries[currentIndex + delta];
    if (!e) return this.info();
    const loaded = this._waitLoad(15000);
    await this._send('Page.navigateToHistoryEntry', { entryId: e.id });
    await loaded;
    return this.info();
  }

  async reload() {
    await this.ensure();
    const loaded = this._waitLoad(15000);
    await this._send('Page.reload', { ignoreCache: true });
    await loaded;
    return this.info();
  }

  async evaluate(expression) {
    const r = await this._send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value === undefined ? r.result.description : r.result.value;
  }

  async info() {
    const v = await this.evaluate('({ url: location.href, title: document.title })');
    return v;
  }

  async screenshot(fullPage) {
    const params = { format: 'png' };
    if (fullPage) {
      const m = await this._send('Page.getLayoutMetrics');
      const s = m.cssContentSize || m.contentSize;
      params.clip = { x: 0, y: 0, width: s.width, height: s.height, scale: 1 };
      params.captureBeyondViewport = true;
    }
    return (await this._send('Page.captureScreenshot', params)).data;
  }

  async mouse(type, x, y, opts = {}) {
    await this._send('Input.dispatchMouseEvent', {
      type, x, y, button: opts.button || 'none', buttons: opts.buttons || 0,
      clickCount: opts.clickCount || 0, deltaX: opts.deltaX || 0, deltaY: opts.deltaY || 0, modifiers: opts.modifiers || 0,
    });
  }

  async clickAt(x, y, clickCount = 1) {
    await this.mouse('mouseMoved', x, y);
    for (let i = 1; i <= clickCount; i++) {
      await this.mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: i });
      await this.mouse('mouseReleased', x, y, { button: 'left', buttons: 0, clickCount: i });
    }
  }

  async elementCenter(selector) {
    const r = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height };
    })()`);
    if (!r) throw new Error(`no element matches ${selector}`);
    if (!r.w || !r.h) throw new Error(`element ${selector} is not visible`);
    return r;
  }

  /** @param {{ x1: number, y1: number, x2: number, y2: number, steps?: number }} opts */
  async drag({ x1, y1, x2, y2, steps }) {
    steps = Math.max(1, steps || 12);
    await this.mouse('mouseMoved', x1, y1);
    await this.mouse('mousePressed', x1, y1, { button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      await this.mouse('mouseMoved', x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps, { button: 'left', buttons: 1 });
    }
    await this.mouse('mouseReleased', x2, y2, { button: 'left', buttons: 0, clickCount: 1 });
  }

  /** @param {{ deltaY: number, deltaX?: number, x?: number, y?: number }} opts */
  async scroll({ deltaY, deltaX, x, y }) {
    await this.mouse('mouseWheel', x ?? this._viewport.width / 2, y ?? this._viewport.height / 2, { deltaX, deltaY });
  }

  /** @param {{ selector?: string, x?: number, y?: number, doubleClick?: boolean }} opts */
  async click({ selector, x, y, doubleClick }) {
    if (selector) ({ x, y } = await this.elementCenter(selector));
    if (typeof x !== 'number' || typeof y !== 'number') throw new Error('pass selector or x and y');
    await this.clickAt(x, y, doubleClick ? 2 : 1);
    return { x: Math.round(x), y: Math.round(y) };
  }

  /** @param {{ text: string, selector?: string, submit?: boolean }} opts */
  async type({ selector, text, submit }) {
    if (selector) await this.click({ selector });
    await this._send('Input.insertText', { text });
    if (submit) await this.pressKey('Enter');
  }

  async pressKey(key) {
    const k = KEYS[key] || { code: key.length === 1 ? 'Key' + key.toUpperCase() : key, keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0, text: key.length === 1 ? key : undefined };
    const base = { key: k.key || key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
    await this._send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, text: k.text, unmodifiedText: k.text });
    await this._send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  // forward a key event coming from the webview
  async rawKey(e) {
    const mods = (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
    const text = printable ? e.key : e.key === 'Enter' ? '\r' : undefined;
    const up = e.type2 === 'keyup';
    await this._send('Input.dispatchKeyEvent', {
      type: up ? 'keyUp' : text ? 'keyDown' : 'rawKeyDown',
      key: e.key, code: e.code, windowsVirtualKeyCode: e.keyCode, nativeVirtualKeyCode: e.keyCode,
      modifiers: mods, text: up ? undefined : text, unmodifiedText: up ? undefined : text,
    });
  }

  async snapshot() {
    return this.evaluate(`(() => {
      const sel = ${SELECTOR_FN};
      const visible = (el) => { const b = el.getBoundingClientRect(); const s = getComputedStyle(el); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const q = 'a[href],button,input,select,textarea,[role=button],[role=link],[onclick],[contenteditable=true],summary,canvas';
      const elements = [...document.querySelectorAll(q)].filter(visible).slice(0, 150).map((el) => {
        const b = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(), selector: sel(el),
          text: (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.title || '').trim().slice(0, 80),
          type: el.type || undefined, href: el.getAttribute('href') || undefined,
          box: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],
        };
      });
      return { url: location.href, title: document.title, viewport: [innerWidth, innerHeight], text: document.body ? document.body.innerText.slice(0, 4000) : '', elements };
    })()`);
  }
}

function fmtRemote(a) {
  if (a.type === 'string') return a.value;
  if (a.value !== undefined) return JSON.stringify(a.value);
  return a.description || a.type;
}

module.exports = { Browser, describeDialog };
