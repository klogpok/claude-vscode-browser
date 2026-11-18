# Claude Browser

A browser panel inside VS Code that Claude Code can drive. You see the page live and can click/type in it; Claude controls the same page over MCP.

- **Panel**: `Claude Browser: Open` (or the globe in the status bar). URL bar, back/forward/reload, mouse, wheel and keyboard are forwarded.
- **MCP server**: `http://127.0.0.1:47823/mcp`, started when VS Code starts. Register once with
  `claude mcp add --transport http --scope user claude-browser http://127.0.0.1:47823/mcp`
  (or run `Claude Browser: Register MCP server with Claude Code`).
- **Tools**: `browser_navigate`, `browser_snapshot`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_press_key`, `browser_drag`, `browser_scroll`, `browser_evaluate`, `browser_console`, `browser_navigate_history`, `browser_resize`.

Uses your installed Chrome or Edge (headless, separate temporary profile) via the Chrome DevTools Protocol. No npm dependencies.

Settings: `claudeBrowser.port`, `claudeBrowser.executablePath`, `claudeBrowser.startUrl`, `claudeBrowser.autoOpenPanel`.

Only one VS Code window can own the port; other windows log an error and skip the MCP server.
