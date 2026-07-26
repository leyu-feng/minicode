param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Arguments
)

$ErrorActionPreference = "Stop"

function Normalize-Domain([string]$Value) {
  if (-not $Value) { return $null }
  return ($Value -replace '^https?://', '').TrimEnd('/')
}

$installRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $installRoot "opencode\packages\opencode\bin\opencode"
$tuiPath = Join-Path $installRoot "minicode"
$webPath = Join-Path $installRoot "minicode-web"
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

if (-not (Test-Path -LiteralPath $launcher)) {
  throw "OpenCode launcher not found at: $launcher"
}

if ($effectiveArgs.Count -ge 1 -and $effectiveArgs[0] -eq "tui") {
  if (-not (Test-Path -LiteralPath $tuiPath)) {
    throw "TUI project not found at: $tuiPath"
  }
  $env:MINICODE_REPO_ROOT = $executionRoot
  Push-Location $tuiPath
  try {
    npm start
    exit $LASTEXITCODE
  } finally {
    Pop-Location
  }
}

$isProviderCommand = $effectiveArgs.Count -ge 2 -and (
  (($effectiveArgs[0] -eq "auth") -or ($effectiveArgs[0] -eq "providers")) -and
  (($effectiveArgs[1] -eq "login") -or ($effectiveArgs[1] -eq "list") -or ($effectiveArgs[1] -eq "logout"))
)

if (-not $isProviderCommand) {
  if ($env:XDG_DATA_HOME) {
    $authPath = Join-Path $env:XDG_DATA_HOME "opencode\auth.json"
  } elseif ($env:LOCALAPPDATA) {
    $authPath = Join-Path $env:LOCALAPPDATA "opencode\auth.json"
  } elseif ($env:APPDATA) {
    $authPath = Join-Path $env:APPDATA "opencode\auth.json"
  } else {
    $authPath = Join-Path $HOME ".local\share\opencode\auth.json"
  }

  if (-not (Test-Path -LiteralPath $authPath)) {
    throw "Auth file not found at $authPath. Run: .\minicode.ps1 auth login --provider github-copilot"
  }

  $auth = Get-Content -LiteralPath $authPath -Raw | ConvertFrom-Json
  $copilot = $auth.'github-copilot'
  if (-not $copilot -or -not $copilot.refresh) {
    throw "No github-copilot credential in $authPath. Run: .\minicode.ps1 auth login --provider github-copilot"
  }

  $domain = Normalize-Domain $copilot.enterpriseUrl
  $env:OPENCODE_API_KEY = $copilot.refresh
  $env:OPENCODE_BASE_URL = if ($domain) { "https://copilot-api.$domain" } else { "https://api.githubcopilot.com" }
  if (-not $env:OPENCODE_MODEL) {
    $env:OPENCODE_MODEL = "claude-opus-4.8"
  }
}

if ($effectiveArgs.Count -ge 1 -and $effectiveArgs[0] -eq "web") {
  if (-not (Test-Path -LiteralPath $webPath)) {
    throw "Web portal project not found at: $webPath"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $webPath "node_modules"))) {
    Push-Location $webPath
    try { npm install } finally { Pop-Location }
  }
  $env:MINICODE_REPO_ROOT = $executionRoot
  if ($effectiveArgs.Count -ge 2) {
    $env:MINICODE_WEB_PORT = $effectiveArgs[1]
  }
  Push-Location $executionRoot
  try {
    & node.exe (Join-Path $webPath "server\index.js")
    exit $LASTEXITCODE
  } finally {
    Pop-Location
  }
}

if ($effectiveArgs.Count -ge 1 -and $effectiveArgs[0] -eq "chat") {
  if (-not (Test-Path -LiteralPath $webPath)) {
    throw "Agent project not found at: $webPath"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $webPath "node_modules"))) {
    Push-Location $webPath
    try { npm install } finally { Pop-Location }
  }
  $env:MINICODE_REPO_ROOT = $executionRoot
  $chatArgs = @($effectiveArgs | Select-Object -Skip 1)
  Push-Location $executionRoot
  try {
    & node.exe (Join-Path $webPath "cli.js") @chatArgs
    exit $LASTEXITCODE
  } finally {
    Pop-Location
  }
}

function Invoke-OpenCode {
  param(
    [string[]]$InvokeArgs
  )
  $env:MINICODE_REPO_ROOT = $executionRoot
  Push-Location $executionRoot
  try {
    & node.exe $launcher @InvokeArgs
  } finally {
    Pop-Location
  }
}

if ($isProviderCommand) {
  Invoke-OpenCode -InvokeArgs $effectiveArgs
  exit $LASTEXITCODE
}

if ($effectiveArgs.Count -gt 0) {
  Invoke-OpenCode -InvokeArgs $effectiveArgs
  exit $LASTEXITCODE
}

Invoke-OpenCode -InvokeArgs @()
