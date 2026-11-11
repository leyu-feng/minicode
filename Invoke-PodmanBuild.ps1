[CmdletBinding(DefaultParameterSetName = "Build")]
param(
  [Parameter(Mandatory)]
  [ValidatePattern('^[a-z0-9][a-z0-9._-]*$')]
  [string]$Component,
  [string]$PodmanPath = "podman",
  [string]$LedgerPath = $env:PODMAN_CACHE_LEDGER,
  [Parameter(Mandatory, ParameterSetName = "Build")]
  [string[]]$BuildArguments,
  [Parameter(Mandatory, ParameterSetName = "Import")]
  [string]$LogPath,
  [Parameter(ParameterSetName = "Import")]
  [DateTimeOffset]$ObservedAt,
  [Parameter(ParameterSetName = "Import")]
  [bool]$BuildSucceeded = $true,
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
$PodmanPath = (Get-Command $PodmanPath -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
if (-not $LedgerPath) {
  $LedgerPath = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "Clippy\container-cache-usage.json"
}
$LedgerPath = [IO.Path]::GetFullPath($LedgerPath)
$checkpoints = @{}
$pendingCacheHit = $false

function Read-Checkpoint([string]$Line) {
  $line = $Line -replace '\x1b\[[0-?]*[ -/]*[@-~]', ''
  if ($line -match '^-->\s+Using cache(?:\s+([a-f0-9]{12,64}))?\s*$') {
    $script:pendingCacheHit = $true
    if ($Matches[1]) { $script:checkpoints[$Matches[1]] = $true }
  } elseif ($line -match '^-->\s+([a-f0-9]{12,64})\s*$') {
    $id = $Matches[1]
    $script:checkpoints[$id] = ($script:pendingCacheHit -or $script:checkpoints[$id] -eq $true)
    $script:pendingCacheHit = $false
  } elseif ($line -match '^(?:\[\d+/\d+\]\s+)?STEP \d+/\d+:') {
    $script:pendingCacheHit = $false
  }
}

$buildCode = 0
if ($PSCmdlet.ParameterSetName -eq "Build") {
  $output = [Collections.Generic.List[string]]::new()
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $PodmanPath build @BuildArguments 2>&1 | ForEach-Object {
      $line = "$_"
      Read-Checkpoint $line
      if ($Quiet) { $output.Add($line) } else { Write-Host $line }
    }
    $buildCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  $BuildSucceeded = $buildCode -eq 0
  if (-not $BuildSucceeded -and $Quiet) { $output | ForEach-Object { Write-Host $_ } }
  $ObservedAt = [DateTimeOffset]::UtcNow
  $timeSource = "build-finished"
} else {
  Get-Content -LiteralPath $LogPath | ForEach-Object { Read-Checkpoint "$_" }
  if (-not $PSBoundParameters.ContainsKey("ObservedAt")) {
    $ObservedAt = [DateTimeOffset](Get-Item -LiteralPath $LogPath).LastWriteTimeUtc
    $timeSource = "log-last-write"
  } else {
    $timeSource = "supplied-build-time"
  }
}

if ($checkpoints.Count -gt 0) {
  $inventory = & $PodmanPath images --all --no-trunc --format json
  if ($LASTEXITCODE -ne 0) { throw "Cannot inventory images for cache usage tracking (build exit $buildCode)." }
  $images = @((($inventory | Out-String) | ConvertFrom-Json))
  $engine = & $PodmanPath info --format '{{.Host.Hostname}}/{{.Store.GraphRoot}}'
  if ($LASTEXITCODE -ne 0 -or -not $engine) { throw "Cannot identify the cache engine (build exit $buildCode)." }
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $engineId = ([BitConverter]::ToString($sha.ComputeHash(
      [Text.Encoding]::UTF8.GetBytes("$([Environment]::MachineName)|$(($engine | Out-String).Trim())")
    ))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
  $observations = @{}
  foreach ($prefix in $checkpoints.Keys) {
    $matching = @($images | Where-Object { ($_.Id -replace '^sha256:', '').StartsWith($prefix) })
    if ($matching.Count -gt 1) { throw "Ambiguous cache checkpoint '$prefix'; ledger not updated." }
    if ($matching.Count -eq 0) {
      Write-Warning "Cache checkpoint $prefix is no longer present on this engine; not recorded."
      continue
    }
    $id = $matching[0].Id -replace '^sha256:', ''
    if ($observations.ContainsKey($id)) {
      $observations[$id].cacheHit = $observations[$id].cacheHit -or $checkpoints[$prefix]
    } else {
      $observations[$id] = @{ image = $matching[0]; cacheHit = $checkpoints[$prefix] }
    }
  }

  $directory = Split-Path -Parent $LedgerPath
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $lock = $null
  $temporary = "$LedgerPath.$([guid]::NewGuid().ToString('N')).tmp"
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds(30)
  try {
    while (-not $lock) {
      try {
        $lock = [IO.File]::Open("$LedgerPath.lock", [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
      } catch [IO.IOException] {
        if ([DateTimeOffset]::UtcNow -ge $deadline) { throw }
        Start-Sleep -Milliseconds 100
      }
    }
    $records = [Collections.Generic.List[object]]::new()
    if (Test-Path -LiteralPath $LedgerPath) {
      $saved = [IO.File]::ReadAllText($LedgerPath) | ConvertFrom-Json
      if ($saved.schemaVersion -ne 1 -or $null -eq $saved.images) { throw "Unrecognized cache ledger; existing file preserved." }
      foreach ($record in $saved.images) { $records.Add($record) }
    }
    $timestamp = $ObservedAt.UtcDateTime.ToString("o")
    foreach ($observation in $observations.Values) {
      $image = $observation.image
      $id = $image.Id -replace '^sha256:', ''
      $record = $records | Where-Object { $_.imageId -eq $id -and $_.engineId -eq $engineId } | Select-Object -First 1
      if (-not $record) {
        $record = [pscustomobject][ordered]@{
          imageId = $id
          engineId = $engineId
          names = @()
          components = @()
          firstUsedAt = $timestamp
          lastUsedAt = $timestamp
          lastReusedAt = $null
          lastUse = $null
        }
        $records.Add($record)
      }
      $record.names = @($image.Names | Where-Object { $_ })
      $record.components = @(@($record.components) + @($Component) | Sort-Object -Unique)
      if ($ObservedAt -lt [DateTimeOffset]$record.firstUsedAt) { $record.firstUsedAt = $timestamp }
      if ($observation.cacheHit -and (-not $record.lastReusedAt -or $ObservedAt -gt [DateTimeOffset]$record.lastReusedAt)) {
        $record.lastReusedAt = $timestamp
      }
      if ($ObservedAt -ge [DateTimeOffset]$record.lastUsedAt) {
        $record.lastUsedAt = $timestamp
        $record.lastUse = [ordered]@{
          component = $Component
          buildSucceeded = $BuildSucceeded
          evidence = $(if ($observation.cacheHit) { "cache-hit" } else { "build-output" })
          timeSource = $timeSource
        }
      }
    }
    $ledger = [ordered]@{
      schemaVersion = 1
      updatedAt = [DateTimeOffset]::UtcNow.ToString("o")
      images = @($records | Sort-Object engineId, imageId)
    }
    [IO.File]::WriteAllText($temporary, ($ledger | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $LedgerPath) {
      [IO.File]::Replace($temporary, $LedgerPath, [NullString]::Value)
    } else {
      [IO.File]::Move($temporary, $LedgerPath)
    }
    Write-Host "Cache usage recorded: $($observations.Count) checkpoints ($Component), $LedgerPath"
  } finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    if ($lock) { $lock.Dispose() }
  }
} else {
  Write-Warning "No Podman checkpoint IDs found; cache ledger unchanged."
}
if ($buildCode -ne 0) { throw "podman build failed (exit $buildCode)." }
