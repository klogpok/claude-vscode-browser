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
    this.console = [];
    this.viewport = { width: 1280, height: 800 };
    this.screencasting = false;
    this.starting = null;
    this.loadWaiters = [];
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
      '--hide-scrollbars', `--window-size=${this.viewport.width},${this.viewport.height}`, 'about:blank',
    ];
    this.log(`launching ${exe}`);
    const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.proc = proc;
    const wsUrl = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('browser did not start in 20s')), 20000);
      proc.stderr.on('data', (d) => {
        buf += d.toString();
        const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      });
      proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`browser exited (${code})`)); });
    });
    proc.on('exit', () => { this.log('browser exited'); this._reset(); this.emit('closed'); });

    this.ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('CDP websocket failed')); });
    this.ws.onmessage = (ev) => this._onMessage(JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()));
    this.ws.onclose = () => this._reset();

    const { targetInfos } = await this.send('Target.getTargets', {}, null);
    let page = targetInfos.find((t) => t.type === 'page');
    const targetId = page ? page.targetId : (await this.send('Target.createTarget', { url: 'about:blank' }, null)).targetId;
    this.sessionId = (await this.send('Target.attachToTarget', { targetId, flatten: true }, null)).sessionId;

    await Promise.all([this.send('Page.enable'), this.send('Runtime.enable'), this.send('Log.enable')]);
    await this.setViewport(this.viewport.width, this.viewport.height);
    if (this.screencasting) await this._startScreencast();
    const start = this.getConfig('startUrl');
    if (start && start !== 'about:blank') await this.navigate(start).catch((e) => this.log(String(e)));
    this.emit('started');
  }

  _reset() {
    this.sessionId = null;
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

  send(method, params = {}, sessionId = this.sessionId) {
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
        this.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
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
    }
  }

  _pushConsole(level, text) {
    this.console.push({ level, text, time: new Date().toISOString() });
    if (this.console.length > 500) this.console.shift();
  }

  async setViewport(width, height) {
    this.viewport = { width: Math.max(200, Math.round(width)), height: Math.max(150, Math.round(height)) };
    if (!this.running) return;
    await this.send('Emulation.setDeviceMetricsOverride', { ...this.viewport, deviceScaleFactor: 1, mobile: false });
  }

  async setScreencast(on) {
    this.screencasting = on;
    if (!this.running) return;
    if (on) await this._startScreencast();
    else await this.send('Page.stopScreencast').catch(() => {});
  }

  _startScreencast() {
    return this.send('Page.startScreencast', { format: 'jpeg', quality: 75, everyNthFrame: 1 });
  }

  // ---------- high-level actions ----------
  async navigate(url) {
    await this.ensure();
    url = url.trim();
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !/^(about|data|javascript|blob|chrome):/i.test(url)) url = (/^(localhost|127\.|\[::1\])/.test(url) ? 'http://' : 'https://') + url;
    const loaded = this._waitLoad(15000);
    const r = await this.send('Page.navigate', { url });
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
    const { currentIndex, entries } = await this.send('Page.getNavigationHistory');
    const e = entries[currentIndex + delta];
    if (!e) return this.info();
    const loaded = this._waitLoad(15000);
    await this.send('Page.navigateToHistoryEntry', { entryId: e.id });
    await loaded;
    return this.info();
  }

  async reload() {
    await this.ensure();
    const loaded = this._waitLoad(15000);
    await this.send('Page.reload', { ignoreCache: true });
    await loaded;
    return this.info();
  }

  async evaluate(expression) {
    await this.ensure();
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value === undefined ? r.result.description : r.result.value;
  }

  async info() {
    const v = await this.evaluate('({ url: location.href, title: document.title })');
    return v;
  }

  async screenshot(fullPage) {
    await this.ensure();
    const params = { format: 'png' };
    if (fullPage) {
      const m = await this.send('Page.getLayoutMetrics');
      const s = m.cssContentSize || m.contentSize;
      params.clip = { x: 0, y: 0, width: s.width, height: s.height, scale: 1 };
      params.captureBeyondViewport = true;
    }
    return (await this.send('Page.captureScreenshot', params)).data;
  }

  async mouse(type, x, y, opts = {}) {
    await this.ensure();
    await this.send('Input.dispatchMouseEvent', {
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

  async click({ selector, x, y, doubleClick }) {
    if (selector) ({ x, y } = await this.elementCenter(selector));
    if (typeof x !== 'number' || typeof y !== 'number') throw new Error('pass selector or x and y');
    await this.clickAt(x, y, doubleClick ? 2 : 1);
    return { x: Math.round(x), y: Math.round(y) };
  }

  async type({ selector, text, submit }) {
    if (selector) await this.click({ selector });
    await this.send('Input.insertText', { text });
    if (submit) await this.pressKey('Enter');
  }

  async pressKey(key) {
    await this.ensure();
    const k = KEYS[key] || { code: key.length === 1 ? 'Key' + key.toUpperCase() : key, keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0, text: key.length === 1 ? key : undefined };
    const base = { key: k.key || key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
    await this.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, text: k.text, unmodifiedText: k.text });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  // forward a key event coming from the webview
  async rawKey(e) {
    await this.ensure();
    const mods = (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
    const text = printable ? e.key : e.key === 'Enter' ? '\r' : undefined;
    const up = e.type2 === 'keyup';
    await this.send('Input.dispatchKeyEvent', {
      type: up ? 'keyUp' : text ? 'keyDown' : 'rawKeyDown',
      key: e.key, code: e.code, windowsVirtualKeyCode: e.keyCode, nativeVirtualKeyCode: e.keyCode,
      modifiers: mods, text: up ? undefined : text, unmodifiedText: up ? undefined : text,
    });
  }

  async snapshot() {
    await this.ensure();
    return this.evaluate(`(() => {
      const sel = (el) => {
        if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
        const parts = [];
        for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
          if (n.id && document.querySelectorAll('#' + CSS.escape(n.id)).length === 1) { parts.unshift('#' + CSS.escape(n.id)); break; }
          let i = 1; for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++;
          parts.unshift(n.tagName.toLowerCase() + ':nth-of-type(' + i + ')');
        }
        return parts.join(' > ');
      };
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

module.exports = { Browser };
