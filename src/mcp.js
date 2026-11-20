// Minimal MCP server over Streamable HTTP (JSON responses, no SSE), no dependencies.
const http = require('http');
const { describeDialog } = require('./browser');
const { pickMarkdown } = require('./pick');
const { version: VERSION } = require('../package.json');

/** @type {Array<{ name: string, description: string, inputSchema: object, run: (b: import('./browser').Browser, a: any) => any }>} */
const TOOLS = [
  {
    name: 'browser_navigate',
    description: 'Open a URL in the VS Code browser panel (the user sees the same page). Bare hosts get https://, localhost gets http://.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    run: (b, a) => b.navigate(a.url),
  },
  {
    name: 'browser_snapshot',
    description: 'Current URL, title, visible text (truncated) and visible interactive elements with CSS selectors and boxes [x,y,w,h]. Use before clicking.',
    inputSchema: { type: 'object', properties: {} },
    run: (b) => b.snapshot(),
  },
  {
    name: 'browser_screenshot',
    description: 'PNG screenshot of the viewport (or full page).',
    inputSchema: { type: 'object', properties: { fullPage: { type: 'boolean' } } },
    run: async (b, a) => ({ image: await b.screenshot(!!a.fullPage) }),
  },
  {
    name: 'browser_click',
    description: 'Click an element by CSS selector, or at viewport coordinates x,y. Real mouse events.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, doubleClick: { type: 'boolean' } } },
    run: (b, a) => b.click(a),
  },
  {
    name: 'browser_type',
    description: 'Type text. If selector is given, click it first. submit=true presses Enter afterwards.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, selector: { type: 'string' }, submit: { type: 'boolean' } }, required: ['text'] },
    run: async (b, a) => { await b.type(a); return 'ok'; },
  },
  {
    name: 'browser_press_key',
    description: 'Press a key: Enter, Tab, Escape, Backspace, Delete, Space, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, or a single character.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    run: async (b, a) => { await b.pressKey(a.key); return 'ok'; },
  },
  {
    name: 'browser_drag',
    description: 'Drag the mouse from (x1,y1) to (x2,y2), e.g. to orbit a 3D canvas.',
    inputSchema: { type: 'object', properties: { x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' }, steps: { type: 'number' } }, required: ['x1', 'y1', 'x2', 'y2'] },
    run: async (b, a) => { await b.drag(a); return 'ok'; },
  },
  {
    name: 'browser_scroll',
    description: 'Mouse-wheel scroll at x,y (default: viewport centre). Positive deltaY scrolls down / zooms out.',
    inputSchema: { type: 'object', properties: { deltaY: { type: 'number' }, deltaX: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['deltaY'] },
    run: async (b, a) => { await b.scroll(a); return 'ok'; },
  },
  {
    name: 'browser_evaluate',
    description: 'Evaluate a JavaScript expression in the page and return its JSON value (promises are awaited).',
    inputSchema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
    run: (b, a) => b.evaluate(a.expression),
  },
  {
    name: 'browser_console',
    description: 'Console messages, page exceptions and network/log errors captured since the browser started (or since the last clear).',
    inputSchema: { type: 'object', properties: { errorsOnly: { type: 'boolean' }, clear: { type: 'boolean' } } },
    run: async (b, a) => b.consoleLog(a).map((m) => `[${m.level}] ${m.text}`).join('\n') || '(no messages)',
  },
  {
    name: 'browser_navigate_history',
    description: 'Go back (-1), forward (1), or reload (0).',
    inputSchema: { type: 'object', properties: { delta: { type: 'number' } }, required: ['delta'] },
    run: (b, a) => (a.delta === 0 ? b.reload() : b.history(a.delta < 0 ? -1 : 1)),
  },
  {
    name: 'browser_picked',
    description: 'The element the user last picked with the panel\'s Pick tool (⌖ / Ctrl+Shift+C): selector, DOM path, box, attributes, computed styles, outerHTML and a screenshot of it. Use when the user refers to "this element" / "the element I picked".',
    inputSchema: { type: 'object', properties: {} },
    run: async (b) => {
      const pick = b.picked;
      if (!pick) return 'Nothing picked yet. Ask the user to click ⌖ Pick in the Claude Browser panel and click an element.';
      return { text: pickMarkdown(pick, null), image: pick.png };
    },
  },
  {
    name: 'browser_pick',
    description: 'Turn on the element picker in the panel so the user can click an element to show you. Returns immediately; call browser_picked after the user has picked.',
    inputSchema: { type: 'object', properties: {} },
    run: async (b) => { await b.setPickMode(true); return 'Picker is on. Ask the user to click the element in the Claude Browser panel.'; },
  },
  {
    name: 'browser_resize',
    description: 'Set the viewport size in CSS pixels (the panel will letterbox it until the panel is resized).',
    inputSchema: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } }, required: ['width', 'height'] },
    run: (b, a) => b.setViewport(a.width, a.height),
  },
  {
    name: 'browser_handle_dialog',
    description: 'Decide how to answer the NEXT alert/confirm/prompt/beforeunload dialog, then trigger it (e.g. browser_click). Dialogs never block: without this they are accepted (prompt gets its default text). Handled dialogs are reported in the result of the tool call that caused them and in browser_console.',
    inputSchema: { type: 'object', properties: { accept: { type: 'boolean', description: 'true = OK, false = Cancel' }, promptText: { type: 'string', description: 'Text to enter into a prompt() dialog' } }, required: ['accept'] },
    run: async (b, a) => { b.setDialogPlan(a.accept, a.promptText); return `The next dialog will be ${a.accept ? 'accepted' : 'dismissed'}.`; },
  },
];

// Dialogs handled while a tool ran (or since the last call), so Claude learns a click opened one.
function dialogNote(browser) {
  const ds = browser.takeDialogs ? browser.takeDialogs() : [];
  return ds.length ? `\n\nDialogs handled:\n${ds.map((d) => `- ${describeDialog(d)}`).join('\n')}` : '';
}

/** @param {{ port: number, browser: any, log: (s: string) => void, onToolCall?: (name: string) => void }} opts */
function startMcpServer({ port, browser, onToolCall, log }) {
  const handle = async (msg) => {
    const { id, method, params } = msg;
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    switch (method) {
      case 'initialize':
        return ok({
          protocolVersion: (params && params.protocolVersion) || '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'claude-browser', version: VERSION },
          instructions: 'Controls a Chromium browser that is shown live in a VS Code panel next to the user. Use browser_snapshot to find selectors, browser_screenshot to see the page, browser_console to check errors.',
        });
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === params.name);
        if (!tool) return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${params.name}` } };
        try {
          if (onToolCall) onToolCall(tool.name);
          const r = await tool.run(browser, params.arguments || {});
          const note = dialogNote(browser);
          if (r && (r.image || r.text)) {
            const content = [];
            if (r.text || note) content.push({ type: 'text', text: (r.text || '') + note });
            if (r.image) content.push({ type: 'image', data: r.image, mimeType: 'image/png' });
            return ok({ content });
          }
          return ok({ content: [{ type: 'text', text: (typeof r === 'string' ? r : JSON.stringify(r, null, 2)) + note }] });
        } catch (e) {
          return ok({ content: [{ type: 'text', text: String(e && e.message ? e.message : e) + dialogNote(browser) }], isError: true });
        }
      }
      default:
        if (id === undefined) return null; // notification
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
    }
  };

  const server = http.createServer((req, res) => {
    // DNS-rebinding guard: only accept requests without a browser Origin, or from localhost.
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) { res.writeHead(403); return res.end(); }
    if (!req.url.startsWith('/mcp')) { res.writeHead(404); return res.end(); }
    if (req.method === 'DELETE') { res.writeHead(200); return res.end(); }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); return res.end(); }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
      }
      const batch = Array.isArray(parsed);
      const replies = (await Promise.all((batch ? parsed : [parsed]).map(handle))).filter(Boolean);
      if (!replies.length) { res.writeHead(202); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(batch ? replies : replies[0]));
    });
  });
  server.on('error', (e) => log(`MCP server error: ${e.message}`));
  server.listen(port, '127.0.0.1', () => log(`MCP server on http://127.0.0.1:${port}/mcp`));
  return server;
}

module.exports = { startMcpServer, TOOLS };
