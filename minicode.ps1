param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Arguments
)

$ErrorActionPreference = "Stop"

$installRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $installRoot "opencode\packages\opencode\bin\opencode"
$agentPath = Join-Path $installRoot "minicode-web"

# -repo_root is parsed by hand: declaring it as a typed parameter alongside
# ValueFromRemainingArguments makes PowerShell bind the prompt text to it.
$repo_root = $null
$effectiveArgs = @()
for ($i = 0; $i -lt $Arguments.Count; $i++) {
  $arg = $Arguments[$i]
  if ($arg -eq "-repo_root") {
    if ($i + 1 -lt $Arguments.Count) {
      $repo_root = $Arguments[$i + 1]
      $i++
      continue
    }
    throw "Missing value for -repo_root"
  }
  $effectiveArgs += $arg
}

$executionRoot = if ($repo_root) { $repo_root } else { (Get-Location).Path }
if (-not (Test-Path -LiteralPath $executionRoot)) {
  throw "repo_root does not exist: $executionRoot"
}

$env:MINICODE_REPO_ROOT = $executionRoot

function Ensure-Dependencies([string]$ProjectPath, [string]$Label) {
  if (-not (Test-Path -LiteralPath $ProjectPath)) {
    throw "$Label not found at: $ProjectPath"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $ProjectPath "node_modules"))) {
    Push-Location $ProjectPath
    try { npm install } finally { Pop-Location }
  }
}

function Invoke-Node([string]$Script, [string[]]$NodeArgs) {
  Push-Location $executionRoot
  try {
    & node.exe $Script @NodeArgs
    exit $LASTEXITCODE
  } finally {
    Pop-Location
  }
}

$command = if ($effectiveArgs.Count -ge 1) { $effectiveArgs[0] } else { $null }

# Browser portal: multi-pane terminal at http://127.0.0.1
if ($command -eq "web") {
  Ensure-Dependencies $agentPath "Web portal project"
  if ($effectiveArgs.Count -ge 2) {
    $env:MINICODE_WEB_PORT = $effectiveArgs[1]
  }
  Invoke-Node (Join-Path $agentPath "server\index.js") @()
}

# Legacy opencode node fallback, kept as an escape hatch.
if ($command -eq "raw") {
  if (-not (Test-Path -LiteralPath $launcher)) {
    throw "OpenCode launcher not found at: $launcher"
  }
  Invoke-Node $launcher @($effectiveArgs | Select-Object -Skip 1)
}

# Everything else - prompts, the REPL, auth, --no-tools - goes to the unified
# agent CLI, which resolves credentials and the model itself.
Ensure-Dependencies $agentPath "Agent project"
$cliArgs = if ($command -eq "chat") { @($effectiveArgs | Select-Object -Skip 1) } else { $effectiveArgs }
Invoke-Node (Join-Path $agentPath "cli.js") $cliArgs
