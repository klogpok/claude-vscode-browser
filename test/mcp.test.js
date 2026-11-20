// MCP server metadata that must stay in sync with package.json and README.md.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startMcpServer, TOOLS } = require('../src/mcp');
const pkg = require('../package.json');

test('initialize reports the package.json version', async () => {
  const server = startMcpServer({ port: 0, browser: {}, log: () => {} });
  await new Promise((r) => server.once('listening', r));
  try {
    const { port } = /** @type {import('net').AddressInfo} */ (server.address());
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    const { result } = /** @type {any} */ (await res.json());
    assert.equal(result.serverInfo.version, pkg.version);
  } finally {
    server.close();
  }
});

test('README lists every MCP tool', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const missing = TOOLS.map((t) => t.name).filter((n) => !readme.includes(`\`${n}\``));
  assert.deepEqual(missing, [], `add these tools to README.md: ${missing.join(', ')}`);
});
