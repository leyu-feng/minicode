<#
.SYNOPSIS
Build Clippy locally as a Linux image and publish it to an existing ACR.
.EXAMPLE
.\publish-clippy.ps1 -RegistryName myregistry -Subscription my-subscription
.EXAMPLE
.\publish-clippy.ps1 -BuildOnly
#>
[CmdletBinding()]
param(
  [ValidatePattern('^[a-zA-Z0-9]{5,50}$')]
  [string]$RegistryName,
  [string]$Subscription,
  [ValidatePattern('^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$')]
  [string]$ImageName = "clippy",
  [ValidatePattern('^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$')]
  [string]$Tag,
  [string]$NpmConfigPath,
  [switch]$BuildOnly
)

$ErrorActionPreference = "Stop"
if (-not $BuildOnly -and -not $RegistryName) {
  throw "Specify -RegistryName to publish, or -BuildOnly for a local image."
}

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$([IO.Path]::GetFileName($Command)) $($Arguments[0]) failed (exit $LASTEXITCODE)."
  }
}

function Resolve-Tool([string]$Name) {
  $tool = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($tool) { return $tool.Source }
  if ($Name -eq "podman") {
    $candidate = Join-Path $env:ProgramFiles "RedHat\Podman\podman.exe"
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  throw "Required tool '$Name' was not found. Install it and open a new PowerShell window."
}

$git = Resolve-Tool "git"
$podman = Resolve-Tool "podman"
$tar = Resolve-Tool "tar"
if (-not $NpmConfigPath) {
  $npm = Resolve-Tool "npm"
  $NpmConfigPath = (Invoke-Checked $npm @("config", "get", "userconfig") | Out-String).Trim()
}
if (-not (Test-Path -LiteralPath $NpmConfigPath -PathType Leaf)) {
  throw "npm configuration was not found. Set -NpmConfigPath to your npmrc file."
}
$NpmConfigPath = (Resolve-Path -LiteralPath $NpmConfigPath).Path
$engine = (Invoke-Checked $podman @("info", "--format", "{{.Host.OS}}") | Out-String).Trim()
if ($engine -ne "linux") { throw "Podman must be connected to a Linux engine. Start your Podman machine and retry." }

$sourceCommit = (Invoke-Checked $git @("-C", $PSScriptRoot, "rev-parse", "HEAD") | Out-String).Trim()
$changes = Invoke-Checked $git @(
  "-C", $PSScriptRoot, "status", "--porcelain", "--untracked-files=normal", "--",
  "clippy", ":(exclude)clippy/Dockerfile"
)
if ($changes) { throw "Commit or remove changes under clippy before building; the image uses committed source only." }
if (-not $Tag -or $Tag -eq "latest") { $Tag = "$(Get-Date -Format 'yyyyMMdd-HHmmss')-$($sourceCommit.Substring(0, 12))" }
$image = "${ImageName}:$Tag"
$azureArguments = @("--only-show-errors")
if ($Subscription) { $azureArguments += @("--subscription", $Subscription) }

$temporary = Join-Path ([IO.Path]::GetTempPath()) "clippy-image-$([guid]::NewGuid().ToString('N'))"
$context = Join-Path $temporary "context"
$archive = Join-Path $temporary "source.tar"
New-Item -ItemType Directory -Path $context | Out-Null
try {
  $authArguments = @()
  if (-not $BuildOnly) {
    $az = Resolve-Tool "az"
    $loginServer = (Invoke-Checked $az (@("acr", "show", "--name", $RegistryName, "--query", "loginServer", "--output", "tsv") + $azureArguments) | Out-String).Trim()
    if ($loginServer -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.-]+$') { throw "ACR did not return a valid login server." }
    $authArguments = @("--authfile", (Join-Path $temporary "auth.json"))
    $login = (Invoke-Checked $az (@("acr", "login", "--name", $RegistryName, "--expose-token", "--output", "json") + $azureArguments) | Out-String) | ConvertFrom-Json
    try {
      if (-not $login.accessToken -or $login.loginServer -ne $loginServer) { throw "ACR did not return a valid login token for this registry." }
      $login.accessToken | & $podman login @authArguments --username 00000000-0000-0000-0000-000000000000 --password-stdin $loginServer
      if ($LASTEXITCODE -ne 0) { throw "Podman registry login failed (exit $LASTEXITCODE)." }
    } finally {
      $login = $null
    }
    $image = "$loginServer/$image"
  }
  # Export only committed application files, never the devbox working directory.
  Invoke-Checked $git @("-C", $PSScriptRoot, "archive", "--format=tar", "--output=$archive", "${sourceCommit}:clippy")
  Invoke-Checked $tar @("-xf", $archive, "-C", $context)
  Write-Host "Building $image from $sourceCommit (linux/amd64, production)"
  $buildEnvironment = @{}
  try {
    # Avoid Podman's Windows mapped-context secret bug (upstream issue #29223).
    # Remote transport uploads the same committed context and keeps secrets ephemeral.
    if ($env:OS -eq "Windows_NT" -and (-not $env:CONTAINER_HOST -or $env:CONTAINER_CONNECTION)) {
      $connections = (Invoke-Checked $podman @("system", "connection", "list", "--format", "json") | Out-String) | ConvertFrom-Json
      $selected = @($connections | Where-Object {
        if ($env:CONTAINER_CONNECTION) { $_.Name -eq $env:CONTAINER_CONNECTION } else { $_.Default }
      })
      if ($selected.Count -ne 1) { throw "Could not resolve the selected Podman connection." }
      if ($selected[0].IsMachine) {
        foreach ($name in @("CONTAINER_HOST", "CONTAINER_CONNECTION", "CONTAINER_SSHKEY")) {
          $buildEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
        }
        $env:CONTAINER_HOST = $selected[0].URI
        $env:CONTAINER_SSHKEY = $selected[0].Identity
        $env:CONTAINER_CONNECTION = $null
      }
    }
    & (Join-Path $PSScriptRoot "Invoke-PodmanBuild.ps1") -PodmanPath $podman -Component clippy -BuildArguments (@(
      "--format", "docker", "--platform", "linux/amd64", "--target", "production",
      "--build-arg", "PAPERCLIP_BUILD_COMMIT=$sourceCommit",
      "--build-arg", "PROVIDER_PACK_EXCLUDE=pi,cursor",
      "--secret", "id=npmrc,src=$NpmConfigPath",
      "--tag", $image, "--file", (Join-Path $PSScriptRoot "clippy\Dockerfile")
    ) + $authArguments + @($context))
  } finally {
    foreach ($name in $buildEnvironment.Keys) {
      [Environment]::SetEnvironmentVariable($name, $buildEnvironment[$name], "Process")
    }
  }
  $platform = (Invoke-Checked $podman @("image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", $image) | Out-String).Trim()
  if ($platform -ne "linux/amd64") { throw "Built image has unexpected platform '$platform'." }
  if ($BuildOnly) {
    Write-Host "Built local image: $image"
  } else {
    Invoke-Checked $podman (@("push") + $authArguments + @($image))
    $digest = (Invoke-Checked $az (@(
      "acr", "repository", "show", "--name", $RegistryName, "--image", "${ImageName}:$Tag",
      "--query", "digest", "--output", "tsv"
    ) + $azureArguments) | Out-String).Trim()
    if ($digest -notmatch '^sha256:[a-f0-9]{64}$') { throw "ACR did not return a valid published image digest." }
    $latestImage = "$loginServer/${ImageName}:latest"
    Invoke-Checked $podman @("tag", $image, $latestImage)
    Invoke-Checked $podman (@("push") + $authArguments + @($latestImage))
    $latestDigest = (Invoke-Checked $az (@(
      "acr", "repository", "show", "--name", $RegistryName, "--image", "${ImageName}:latest",
      "--query", "digest", "--output", "tsv"
    ) + $azureArguments) | Out-String).Trim()
    if ($latestDigest -ne $digest) { throw "Published latest tag does not match the versioned image digest." }
    Write-Host "Published image: $image"
    Write-Host "Published image: $latestImage"
    Write-Host "Immutable image: $loginServer/$ImageName@$digest"
    Write-Host "Deployment reference: $latestImage"
  }
} finally {
  Remove-Item -LiteralPath $temporary -Recurse -Force
}
