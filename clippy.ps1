param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Arguments
)

$ErrorActionPreference = "Stop"

$installRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$appPath = Join-Path $installRoot "clippy"

# -repo_root and -port are parsed by hand, matching minicode.ps1.
$repo_root = $null
$port = $null
for ($i = 0; $i -lt $Arguments.Count; $i++) {
  $arg = $Arguments[$i]
  if ($arg -eq "-repo_root" -or $arg -eq "-port") {
    if ($i + 1 -ge $Arguments.Count) { throw "Missing value for $arg" }
    if ($arg -eq "-repo_root") { $repo_root = $Arguments[$i + 1] } else { $port = $Arguments[$i + 1] }
    $i++
  }
}

$executionRoot = if ($repo_root) { $repo_root } else { (Get-Location).Path }
if (-not (Test-Path -LiteralPath $executionRoot)) {
  throw "repo_root does not exist: $executionRoot"
}
$env:CLIPPY_REPO_ROOT = $executionRoot

if (-not (Test-Path -LiteralPath (Join-Path $appPath "package.json"))) {
  throw "Clippy project not found at: $appPath"
}

# The paperclip codebase requires Node >= 24.11 (see clippy/package.json engines).
$nodeVersion = [version]((& node.exe --version).TrimStart("v"))
if ($nodeVersion -lt [version]"24.11.0") {
  throw "Clippy requires Node.js 24.11 or newer (found $nodeVersion)."
}

# pnpm is pinned by the packageManager field. It is fetched through npm rather
# than corepack, because corepack ignores .npmrc and so bypasses the configured
# registry and its auth.
$pnpmVersion = ((Get-Content -Raw (Join-Path $appPath "package.json") | ConvertFrom-Json).packageManager -split "@")[1]
function Invoke-Pnpm([string[]]$PnpmArgs) {
  & npm.cmd exec --yes "pnpm@$pnpmVersion" -- @PnpmArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

# Package scripts use POSIX shell syntax (mkdir -p, cp, &&), which cmd.exe cannot
# run, so point pnpm at Git for Windows' bash.
# git.exe may resolve from Git\cmd, Git\bin or Git\mingw64\bin, so walk up
# from it to the Git install root that holds bin\bash.exe.
$bash = $null
$git = Get-Command git.exe -ErrorAction SilentlyContinue
$dir = if ($git) { Split-Path -Parent $git.Source }
while ($dir -and -not $bash) {
  $candidate = Join-Path $dir "bin\bash.exe"
  if (Test-Path -LiteralPath $candidate) { $bash = $candidate }
  $dir = Split-Path -Parent $dir
}
if (-not $bash) {
  throw "Clippy needs Git for Windows' bash.exe to run its build scripts."
}
$env:npm_config_script_shell = $bash

Push-Location $appPath
try {
  if (-not (Test-Path -LiteralPath (Join-Path $appPath "node_modules"))) {
    Invoke-Pnpm @("install")
  }

  # Keep clippy's database and config apart from any real Paperclip install,
  # which defaults to ~/.paperclip.
  if (-not $env:PAPERCLIP_HOME) { $env:PAPERCLIP_HOME = Join-Path $HOME ".clippy" }

  # Clippy stays Node-only: skip the Rust-built native runner (paperclip-runnerd).
  $env:PAPERCLIP_DISABLE_NATIVE_RUNNER = "true"

  # The server opens the browser itself once it is listening.
  $env:PAPERCLIP_OPEN_ON_LISTEN = "true"
  if ($port) { $env:PORT = $port }

  Invoke-Pnpm @("dev:once")
} finally {
  Pop-Location
}
