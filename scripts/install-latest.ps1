# Installs or updates Claude Browser from the latest GitHub release.
#   irm https://raw.githubusercontent.com/klogpok/claude-browser-vscode/main/scripts/install-latest.ps1 | iex
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$repo = 'klogpok/claude-browser-vscode'

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

if (Get-Command claude -ErrorAction SilentlyContinue) {
  & claude mcp get claude-browser *> $null
  if ($LASTEXITCODE -ne 0) {
    & claude mcp add --transport http --scope user claude-browser http://127.0.0.1:47823/mcp
  } else {
    Write-Host "MCP server 'claude-browser' already registered in Claude Code."
  }
} else {
  Write-Host "Claude Code CLI not found; register the MCP server later with:"
  Write-Host "  claude mcp add --transport http --scope user claude-browser http://127.0.0.1:47823/mcp"
}

Write-Host ""
Write-Host "Claude Browser $($rel.tag_name) installed. In VS Code: Ctrl+Shift+P -> Developer: Reload Window" -ForegroundColor Green
