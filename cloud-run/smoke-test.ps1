$ErrorActionPreference = 'Stop'
$results = [System.Collections.Generic.List[object]]::new()
$serverProcess = $null
$secretBytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
$secret = [Convert]::ToBase64String($secretBytes)
$hmacKey = [System.Text.Encoding]::UTF8.GetBytes($secret)
$hmac = [System.Security.Cryptography.HMACSHA256]::new($hmacKey)
$baselineProcessIds = @((Get-CimInstance Win32_Process | Select-Object -ExpandProperty ProcessId))
$ownedServerNodes = [System.Collections.Generic.List[object]]::new()

function Add-Result([string]$Name, [bool]$Passed, [string]$Detail = '') {
    $results.Add([pscustomobject]@{ Name = $Name; Passed = $Passed })
    if ($Passed) { Write-Output "PASS $Name" }
    elseif ($Detail) { Write-Output "FAIL $Name — $Detail" }
    else { Write-Output "FAIL $Name" }
}
function Get-Signature([string]$Timestamp, [byte[]]$BodyBytes) {
    $prefix = [System.Text.Encoding]::UTF8.GetBytes($Timestamp + "`n")
    $bytes = [byte[]]::new($prefix.Length + $BodyBytes.Length)
    [Array]::Copy($prefix, 0, $bytes, 0, $prefix.Length)
    [Array]::Copy($BodyBytes, 0, $bytes, $prefix.Length, $BodyBytes.Length)
    [Convert]::ToHexString($hmac.ComputeHash($bytes)).ToLowerInvariant()
}
function Send-Check([string]$BaseUrl, [string]$Timestamp, [string]$Signature, [byte[]]$BodyBytes) {
    Invoke-WebRequest -Uri "$BaseUrl/v1/check" -Method Post `
        -Headers @{ 'X-Watchly-Timestamp' = $Timestamp; 'X-Watchly-Signature' = $Signature } `
        -ContentType 'application/json' -Body $BodyBytes -SkipHttpErrorCheck -TimeoutSec 12
}
function Track-ServerNodeProcesses {
    $known = @($ownedServerNodes | ForEach-Object { $_.ProcessId })
    $newNodes = Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq 'node.exe' -and
        $_.CommandLine -match '--experimental-strip-types cloud-run/server\.ts' -and
        $_.ProcessId -notin $baselineProcessIds -and $_.ProcessId -notin $known
    }
    foreach ($node in $newNodes) {
        $ownedServerNodes.Add([pscustomobject]@{ ProcessId = $node.ProcessId; CreationDate = $node.CreationDate })
    }
}

try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start(); $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port; $listener.Stop()

    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $env:ComSpec
    $psi.Arguments = '/d /s /c "npm run cloud-run"'
    $psi.WorkingDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    $psi.Environment['PORT'] = [string]$port
    $psi.Environment['WATCHLY_HMAC_SECRET'] = $secret
    $serverProcess = [System.Diagnostics.Process]::new(); $serverProcess.StartInfo = $psi
    [void]$serverProcess.Start(); $serverProcess.BeginOutputReadLine(); $serverProcess.BeginErrorReadLine()
    Track-ServerNodeProcesses

    $baseUrl = "http://127.0.0.1:$port"; $ready = $false; $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while ([DateTime]::UtcNow -lt $deadline -and -not $serverProcess.HasExited) {
        Track-ServerNodeProcesses
        try {
            $health = Invoke-WebRequest -Uri "$baseUrl/health" -TimeoutSec 2
            $healthJson = $health.Content | ConvertFrom-Json -ErrorAction Stop
            if ($health.StatusCode -eq 200 -and $healthJson.status -eq 'ok') { $ready = $true; break }
        } catch { Start-Sleep -Milliseconds 250 }
    }
    if (-not $ready) {
        $probe = [System.Net.Sockets.TcpClient]::new(); $occupied = $false
        try { $probe.Connect('127.0.0.1', $port); $occupied = $true } catch { } finally { $probe.Dispose() }
        if ($occupied -and $serverProcess.HasExited) { throw "Port $port was occupied before the service became ready; external processes were left untouched." }
        Add-Result 'Server starts and /health responds within 15 seconds' $false
        throw 'Local service did not become healthy in time.'
    }
    Add-Result 'Server starts and /health responds within 15 seconds' $true

    $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes('{"url":"https://example.com/"}')
    $timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString()
    $signature = Get-Signature $timestamp $bodyBytes
    try {
        $valid = Send-Check $baseUrl $timestamp $signature $bodyBytes
        $json = $valid.Content | ConvertFrom-Json -ErrorAction Stop
        $ok = $valid.StatusCode -eq 200 -and $json.outcome -in @('initial','unchanged','changed') -and
            $json.httpStatus -ge 200 -and $json.httpStatus -lt 300 -and $json.contentHash -match '^[a-f0-9]{64}$' -and
            $json.contentType -is [string] -and $null -ne $json.metrics.durationMs -and
            $null -ne $json.metrics.fetchMs -and $null -ne $json.metrics.extractMs -and
            $null -ne $json.metrics.hashMs -and $null -ne $json.metrics.bytesReceived
        Add-Result 'Authenticated POST /v1/check for example.com' $ok
        if (-not $ok) { Write-Output ("Valid request details: service HTTP {0}; outcome {1}; upstream HTTP {2}; hash present {3}." -f $valid.StatusCode,$json.outcome,$json.httpStatus,[bool]$json.contentHash) }
    } catch { Add-Result 'Authenticated POST /v1/check for example.com' $false }

    try {
        $bad = if ($signature[0] -eq '0') { '1' + $signature.Substring(1) } else { '0' + $signature.Substring(1) }
        $response = Send-Check $baseUrl $timestamp $bad $bodyBytes
        Add-Result 'Invalid signature returns HTTP 401' ($response.StatusCode -eq 401)
    } catch { Add-Result 'Invalid signature returns HTTP 401' $false }

    try {
        $oldTimestamp = ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - 301).ToString()
        $oldSignature = Get-Signature $oldTimestamp $bodyBytes
        $response = Send-Check $baseUrl $oldTimestamp $oldSignature $bodyBytes
        Add-Result 'Expired timestamp returns HTTP 401' ($response.StatusCode -eq 401)
    } catch { Add-Result 'Expired timestamp returns HTTP 401' $false }
}
catch {
    if ($results.Count -eq 0 -or $results[$results.Count - 1].Passed) {
        $detail = 'Smoke test setup failed.'
        if ($_.Exception.Message -match '^Port \d+ was occupied') { $detail = $_.Exception.Message }
        Add-Result 'Smoke test setup' $false $detail
    }
}
finally {
    if ($null -ne $serverProcess) {
        try { if (-not $serverProcess.HasExited) { $serverProcess.Kill($true); $serverProcess.WaitForExit(5000) | Out-Null } } catch { }
        $serverProcess.Dispose()
    }
    foreach ($owned in $ownedServerNodes) {
        $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($owned.ProcessId)" -ErrorAction SilentlyContinue
        if ($null -ne $current -and $current.Name -eq 'node.exe' -and
            $current.CreationDate -eq $owned.CreationDate -and
            $current.CommandLine -match '--experimental-strip-types cloud-run/server\.ts') {
            Stop-Process -Id $owned.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
    # npm/cmd can detach its node child before the parent process exits; only
    # terminate matching server processes that did not exist before this run.
    $remainingOwned = Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq 'node.exe' -and
        $_.CommandLine -match '--experimental-strip-types cloud-run/server\.ts' -and
        $_.ProcessId -notin $baselineProcessIds
    }
    foreach ($node in $remainingOwned) { Stop-Process -Id $node.ProcessId -Force -ErrorAction SilentlyContinue }
    $hmac.Dispose(); [Array]::Clear($secretBytes, 0, $secretBytes.Length); [Array]::Clear($hmacKey, 0, $hmacKey.Length); $secret = $null
}

$failed = @($results | Where-Object { -not $_.Passed }).Count
Write-Output ("Smoke test summary: {0} passed, {1} failed." -f ($results.Count - $failed), $failed)
if ($failed -gt 0) { exit 1 }
