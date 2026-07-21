param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Arguments
)

$ErrorActionPreference = "Stop"

function Normalize-Domain([string]$Value) {
  if (-not $Value) { return $null }
  return ($Value -replace '^https?://', '').TrimEnd('/')
}

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $repoRoot "opencode\packages\opencode\bin\opencode"
$tuiPath = Join-Path $repoRoot "minicode"

if (-not (Test-Path -LiteralPath $launcher)) {
  throw "OpenCode launcher not found at: $launcher"
}

if ($Arguments.Count -ge 1 -and $Arguments[0] -eq "tui") {
  if (-not (Test-Path -LiteralPath $tuiPath)) {
    throw "TUI project not found at: $tuiPath"
  }
  Push-Location $tuiPath
  try {
    npm start
    exit $LASTEXITCODE
  } finally {
    Pop-Location
  }
}

$isProviderCommand = $Arguments.Count -ge 2 -and (
  (($Arguments[0] -eq "auth") -or ($Arguments[0] -eq "providers")) -and
  (($Arguments[1] -eq "login") -or ($Arguments[1] -eq "list") -or ($Arguments[1] -eq "logout"))
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
    $env:OPENCODE_MODEL = "gpt-4o-mini"
  }
}

function Invoke-OpenCode {
  param(
    [string[]]$InvokeArgs
  )
  & node.exe $launcher @InvokeArgs
}

if ($isProviderCommand) {
  Invoke-OpenCode -InvokeArgs $Arguments
  exit $LASTEXITCODE
}

if ($Arguments.Count -gt 0) {
  Invoke-OpenCode -InvokeArgs $Arguments
  exit $LASTEXITCODE
}

while ($true) {
  $prompt = Read-Host "minicode>"
  if ($null -eq $prompt) { continue }
  $text = $prompt.Trim()
  if (-not $text) { continue }
  if ($text -eq "exit" -or $text -eq "/exit") { break }

  Invoke-OpenCode -InvokeArgs @($text)
}
