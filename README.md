# Claude Browser

A browser panel inside VS Code that Claude Code can drive. You see the page live and can click/type in it; Claude controls the same page over MCP.

- **Panel**: `Claude Browser: Open` (or the globe in the status bar). URL bar, back/forward/reload, mouse, wheel and keyboard are forwarded.
- **MCP server**: `http://127.0.0.1:47823/mcp`, started when VS Code starts. Register once with
  `claude mcp add --transport http --scope user claude-browser http://127.0.0.1:47823/mcp`
  (or run `Claude Browser: Register MCP server with Claude Code`).
- **Pick an element** (⌖ Pick or Ctrl+Shift+C, Esc cancels): hover highlights like DevTools, click adds the element (selector, DOM path, box, styles, HTML, screenshot) to the Claude Code chat as an @-mention via `claude-vscode.addToChat`, and copies it to the clipboard.
- **Tools**: `browser_navigate`, `browser_snapshot`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_press_key`, `browser_drag`, `browser_scroll`, `browser_evaluate`, `browser_console`, `browser_navigate_history`, `browser_resize`, `browser_pick`, `browser_picked`.

Uses your installed Chrome or Edge (headless, separate temporary profile) via the Chrome DevTools Protocol. No npm dependencies.

Settings: `claudeBrowser.port`, `claudeBrowser.executablePath`, `claudeBrowser.startUrl`, `claudeBrowser.autoOpenPanel`.

Only one VS Code window can own the port; other windows log an error and skip the MCP server.

## Install / update (Windows)

Needs VS Code (with `code` on PATH), Chrome or Edge, and Claude Code. In PowerShell:

```powershell
irm https://raw.githubusercontent.com/klogpok/claude-vscode-browser/main/scripts/install-latest.ps1 | iex
```

It downloads the `.vsix` from the latest GitHub release, installs it, and registers the MCP server with Claude Code if it isn't registered yet. Run the same command again to update, then **Developer: Reload Window** in VS Code and start a new Claude Code session.

Manual alternative: download the `.vsix` from [Releases](https://github.com/klogpok/claude-vscode-browser/releases) and run `code --install-extension claude-browser-X.Y.Z.vsix --force`.

## Releasing a new version

```sh
npm version patch        # or minor / major: bumps package.json, commits, tags vX.Y.Z
git push --follow-tags   # the Release workflow builds the .vsix and publishes it
```

The workflow fails if the tag doesn't match `package.json`'s version.
