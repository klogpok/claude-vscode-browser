# Installs or updates Claude Browser from the latest GitHub release.
#   irm https://raw.githubusercontent.com/klogpok/claude-vscode-browser/main/scripts/install-latest.ps1 | iex
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$repo = 'klogpok/claude-vscode-browser'

$rel = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'claude-browser-installer' }
$asset = $rel.assets | Where-Object { $_.name -like '*.vsix' } | Select-Object -First 1
if (-not $asset) { throw "Release $($rel.tag_name) has no .vsix file" }

$file = Join-Path $env:TEMP $asset.name
Write-Host "Downloading $($asset.name)..."
Invoke-WebRequest $asset.browser_download_url -OutFile $file -UseBasicParsing

if (-not (Get-Command code -ErrorAction SilentlyContinue)) { throw "'code' is not on PATH. In VS Code run: Shell Command: Install 'code' command in PATH" }
& code --install-extension $file --force
if ($LASTEXITCODE -ne 0) { throw "code --install-extension failed" }
Remove-Item $file -ErrorAction SilentlyContinue

# MCP registration is best-effort: the extension is already installed, so a missing or broken
# `claude` CLI (e.g. an npm shim whose claude.exe an update removed) must not fail the script.
$registered = $false
if (Get-Command claude -ErrorAction SilentlyContinue) {
  $ErrorActionPreference = 'Continue' # native stderr must not become a terminating error
  try {
    & claude mcp get claude-browser *> $null
    if ($LASTEXITCODE -eq 0) {
      Write-Host "MCP server 'claude-browser' already registered in Claude Code."
      $registered = $true
    } else {
      & claude mcp add --transport http --scope user claude-browser http://127.0.0.1:47823/mcp
      $registered = ($LASTEXITCODE -eq 0)
    }
  } catch {
    Write-Warning "Claude Code CLI is on PATH but failed to run: $($_.Exception.Message)"
  }
} else {
  Write-Host "Claude Code CLI not found."
}
if (-not $registered) {
  Write-Host "If the MCP server is not registered yet, register it with:"
  Write-Host "  claude mcp add --transport http --scope user claude-browser http://127.0.0.1:47823/mcp"
  Write-Host "or in VS Code: Ctrl+Shift+P -> Claude Browser: Register MCP server with Claude Code"
}

Write-Host ""
Write-Host "Claude Browser $($rel.tag_name) installed. In VS Code: Ctrl+Shift+P -> Developer: Reload Window" -ForegroundColor Green
