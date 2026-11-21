// MCP server metadata that must stay in sync with package.json and README.md.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startMcpServer, handleRpc, TOOLS } = require('../src/mcp');
const pkg = require('../package.json');

test('initialize reports the package.json version', async () => {
  const { result } = await handleRpc({}, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(result.serverInfo.version, pkg.version);
});

test('the HTTP server answers each request of a batch and drops notifications', async () => {
  const server = startMcpServer({ port: 0, browser: {}, log: () => {} });
  await new Promise((r) => server.once('listening', r));
  try {
    const { port } = /** @type {import('net').AddressInfo} */ (server.address());
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }]),
    });
    assert.deepEqual(await res.json(), [{ jsonrpc: '2.0', id: 1, result: {} }]);
  } finally {
    server.close();
  }
});

test('a tool that throws returns isError, with the dialogs it handled appended', async () => {
  // A dialog record as Browser keeps it for an alert it accepted.
  const browser = {
    takeDialogs: () => [{ type: 'alert', message: 'hi', accept: true, promptText: undefined }],
    click() { throw new Error('boom'); },
  };
  const reply = await handleRpc(browser, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'browser_click', arguments: { selector: '#a' } } });
  assert.deepEqual(reply, {
    jsonrpc: '2.0', id: 7,
    result: { content: [{ type: 'text', text: 'boom\n\nDialogs handled:\n- alert "hi" → accepted' }], isError: true },
  });
});

test('README lists every MCP tool', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const missing = TOOLS.map((t) => t.name).filter((n) => !readme.includes(`\`${n}\``));
  assert.deepEqual(missing, [], `add these tools to README.md: ${missing.join(', ')}`);
});
