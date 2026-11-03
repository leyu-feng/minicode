param(
    [Parameter(Mandatory)]
    [string]$ClusterUri,
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$Database,
    [Parameter(Mandatory)]
    [string]$QueryFile
)

$ErrorActionPreference = 'Stop'
$cluster = $null
if (-not [Uri]::TryCreate($ClusterUri, [UriKind]::Absolute, [ref]$cluster) -or
    $cluster.Scheme -cne 'https' -or $cluster.UserInfo -or
    $cluster.AbsolutePath -cne '/' -or $cluster.Query -or $cluster.Fragment) {
    throw 'ClusterUri must be an HTTPS cluster origin without credentials, paths, query parameters or fragments.'
}
if ($env:WORKER_KUSTO_TOKEN_URL -notmatch '^http://127\.0\.0\.1:[0-9]+/v1/kusto/token$' -or
    $env:WORKER_KUSTO_TOKEN_CAPABILITY -notmatch '^[a-f0-9]{64}$') {
    throw 'The assignment-scoped worker Kusto token API is unavailable.'
}
$query = Get-Content -LiteralPath $QueryFile -Raw
if ([string]::IsNullOrWhiteSpace($query)) { throw 'The KQL file must not be empty.' }

$token = $null
$headers = @{}
try {
    $token = Invoke-RestMethod -Uri $env:WORKER_KUSTO_TOKEN_URL -Method Post `
        -Headers @{ Authorization = "Bearer $env:WORKER_KUSTO_TOKEN_CAPABILITY" } `
        -ContentType 'application/json' -Body '{}' `
        -MaximumRedirection 0 -TimeoutSec 35 -Verbose:$false -Debug:$false
    if ($token.tokenType -cne 'Bearer' -or
        [string]::IsNullOrWhiteSpace($token.accessToken) -or
        [DateTimeOffset]::Parse($token.expiresOn) -le [DateTimeOffset]::UtcNow) {
        throw 'The worker host did not return a valid Kusto token.'
    }
    $headers.Authorization = "Bearer $($token.accessToken)"
    $properties = @{ Options = @{
        request_readonly = $true
        request_readonly_hardline = $true
        servertimeout = '00:01:00'
        truncationmaxrecords = 1000
        truncationmaxsize = 1048576
    } } | ConvertTo-Json -Depth 5 -Compress
    $body = @{ db = $Database; csl = $query; properties = $properties } | ConvertTo-Json -Compress
    $result = Invoke-RestMethod -Uri "$($cluster.AbsoluteUri)v1/rest/query" -Method Post `
        -Headers $headers -ContentType 'application/json' -Body $body `
        -MaximumRedirection 0 -TimeoutSec 75 -Verbose:$false -Debug:$false
    $result | ConvertTo-Json -Depth 100
} catch {
    $status = if ($null -ne $_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 'unavailable' }
    throw "Worker/Kusto request failed (HTTP $status). No alternate authentication was attempted."
} finally {
    $token = $null
    $headers.Clear()
}
