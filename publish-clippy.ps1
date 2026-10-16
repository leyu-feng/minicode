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
  if ($Name -eq "docker") {
    $candidate = Join-Path $env:ProgramFiles "Docker\Docker\resources\bin\docker.exe"
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  throw "Required tool '$Name' was not found. Install it and open a new PowerShell window."
}

$git = Resolve-Tool "git"
$docker = Resolve-Tool "docker"
$tar = Resolve-Tool "tar"
if (-not $NpmConfigPath) {
  $npm = Resolve-Tool "npm"
  $NpmConfigPath = (Invoke-Checked $npm @("config", "get", "userconfig") | Out-String).Trim()
}
if (-not (Test-Path -LiteralPath $NpmConfigPath -PathType Leaf)) {
  throw "npm configuration was not found. Set -NpmConfigPath to your npmrc file."
}
$NpmConfigPath = (Resolve-Path -LiteralPath $NpmConfigPath).Path
$engine = (Invoke-Checked $docker @("info", "--format", "{{.OSType}}") | Out-String).Trim()
if ($engine -ne "linux") { throw "Docker must be running with Linux containers." }

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

if (-not $BuildOnly) {
  $az = Resolve-Tool "az"
  $loginServer = (Invoke-Checked $az (@("acr", "show", "--name", $RegistryName, "--query", "loginServer", "--output", "tsv") + $azureArguments) | Out-String).Trim()
  if ($loginServer -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.-]+$') { throw "ACR did not return a valid login server." }
  Invoke-Checked $az (@("acr", "login", "--name", $RegistryName) + $azureArguments)
  $image = "$loginServer/$image"
}

$temporary = Join-Path ([IO.Path]::GetTempPath()) "clippy-image-$([guid]::NewGuid().ToString('N'))"
$context = Join-Path $temporary "context"
$archive = Join-Path $temporary "source.tar"
New-Item -ItemType Directory -Path $context | Out-Null
try {
  # Export only committed application files, never the devbox working directory.
  Invoke-Checked $git @("-C", $PSScriptRoot, "archive", "--format=tar", "--output=$archive", "${sourceCommit}:clippy")
  Invoke-Checked $tar @("-xf", $archive, "-C", $context)
  Write-Host "Building $image from $sourceCommit (linux/amd64, production)"
  Invoke-Checked $docker @(
    "buildx", "build", "--load", "--platform", "linux/amd64", "--target", "production",
    "--build-arg", "PAPERCLIP_BUILD_COMMIT=$sourceCommit",
    "--build-arg", "PROVIDER_PACK_EXCLUDE=pi,cursor",
    "--secret", "id=npmrc,src=$NpmConfigPath",
    "--tag", $image, "--file", (Join-Path $PSScriptRoot "clippy\Dockerfile"), $context
  )
  $platform = (Invoke-Checked $docker @("image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", $image) | Out-String).Trim()
  if ($platform -ne "linux/amd64") { throw "Built image has unexpected platform '$platform'." }
} finally {
  Remove-Item -LiteralPath $temporary -Recurse -Force
}

if ($BuildOnly) {
  Write-Host "Built local image: $image"
} else {
  Invoke-Checked $docker @("push", $image)
  $digest = (Invoke-Checked $az (@(
    "acr", "repository", "show", "--name", $RegistryName, "--image", "${ImageName}:$Tag",
    "--query", "digest", "--output", "tsv"
  ) + $azureArguments) | Out-String).Trim()
  if ($digest -notmatch '^sha256:[a-f0-9]{64}$') { throw "ACR did not return a valid published image digest." }
  $latestImage = "$loginServer/${ImageName}:latest"
  Invoke-Checked $docker @("tag", $image, $latestImage)
  Invoke-Checked $docker @("push", $latestImage)
  $latestDigest = (Invoke-Checked $az (@(
    "acr", "repository", "show", "--name", $RegistryName, "--image", "${ImageName}:latest",
    "--query", "digest", "--output", "tsv"
  ) + $azureArguments) | Out-String).Trim()
  if ($latestDigest -ne $digest) { throw "Published latest tag does not match the versioned image digest." }
  Write-Host "Published image: $image"
  Write-Host "Published image: $latestImage"
  Write-Host "Deployment reference: $loginServer/$ImageName@$digest"
}
