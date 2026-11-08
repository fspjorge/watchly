$ErrorActionPreference = 'Stop'

$serviceUrl = 'https://watchly-check-932310457499.europe-southwest1.run.app'
$project = 'watchly-514121'
$secretName = 'watchly-hmac-secret'
$secretVersion = '2'
$testResults = [System.Collections.Generic.List[object]]::new()
$secretText = $null
$secretBytes = $null
$timestampBytes = $null
$bodyBytes = $null
$signedMessage = $null
$signatureBytes = $null
$signatureHex = $null
$hmac = $null

function Add-TestResult([string]$Name, [bool]$Passed, [string]$Detail = '') {
    $testResults.Add([pscustomobject]@{ Name = $Name; Passed = $Passed })
    if ($Passed -and $Detail) { Write-Output "$Name`: PASS — $Detail" }
    elseif ($Passed) { Write-Output "$Name`: PASS" }
    elseif ($Detail) { Write-Output "$Name`: FAIL — $Detail" }
    else { Write-Output "$Name`: FAIL" }
}

function Get-SecretFromGcloud {
    $gcloud = Get-Command gcloud -ErrorAction Stop
    $gcloudPath = if ($gcloud.Source) { $gcloud.Source } else { $gcloud.Path }
    if (-not $gcloudPath) { throw 'Google Cloud CLI executable not found.' }

    # Invoke the discovered PowerShell shim/native command directly. Routing a
    # gcloud.ps1 shim through cmd.exe fails on Windows and can hang on quoting.
    # Capture stdout only in memory and suppress stderr so neither can leak.
    $output = & $gcloudPath secrets versions access $secretVersion `
        "--secret=$secretName" "--project=$project" 2>$null
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        $output = $null
        throw 'gcloud secrets versions access returned a non-zero exit code.'
    }
    $secret = @($output) -join "`n"
    $output = $null
    if ([string]::IsNullOrEmpty($secret)) { throw 'Secret Manager returned an empty secret.' }
    return $secret
}

function Invoke-RemoteRequest([string]$Uri, [string]$Method, [hashtable]$Headers = @{}, [byte[]]$Body) {
    try {
        if ($PSBoundParameters.ContainsKey('Body')) {
            return Invoke-WebRequest -Uri $Uri -Method $Method -Headers $Headers -Body $Body `
                -ContentType 'application/json' -TimeoutSec 20 -SkipHttpErrorCheck
        }
        return Invoke-WebRequest -Uri $Uri -Method $Method -TimeoutSec 15 -SkipHttpErrorCheck
    }
    catch {
        return $null
    }
}

try {
    if ($PSVersionTable.PSVersion.Major -lt 7) {
        Add-TestResult 'PowerShell 7' $false 'Run this script from PowerShell 7 or later.'
    }
    else {
        $healthResponse = Invoke-RemoteRequest "$serviceUrl/health" 'Get'
        $healthOk = $false
        if ($null -ne $healthResponse -and $healthResponse.StatusCode -eq 200) {
            try {
                $healthJson = $healthResponse.Content | ConvertFrom-Json -ErrorAction Stop
                $healthOk = $healthJson.status -eq 'ok'
            }
            catch { $healthOk = $false }
        }
        $healthDetail = if ($healthOk) { '' } elseif ($null -eq $healthResponse) { 'Network, TLS, or timeout failure.' } else { "HTTP $($healthResponse.StatusCode) or unexpected health response." }
        Add-TestResult 'Health check' $healthOk $healthDetail

        if ($healthOk) {
            try {
                $secretText = Get-SecretFromGcloud
                Add-TestResult 'Secret Manager access' $true
            }
            catch {
                Add-TestResult 'Secret Manager access' $false 'gcloud failed or access to the configured secret version was denied; check gcloud login and secret access permission.'
            }

            if ($null -ne $secretText) {
                $secretBytes = [System.Text.Encoding]::UTF8.GetBytes($secretText)
                $secretText = $null
                $timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString([Globalization.CultureInfo]::InvariantCulture)
                $timestampBytes = [System.Text.Encoding]::UTF8.GetBytes($timestamp)
                $bodyBytes = [System.Text.UTF8Encoding]::new($false).GetBytes('{"url":"https://example.com/"}')
                $signedMessage = [byte[]]::new($timestampBytes.Length + 1 + $bodyBytes.Length)
                [Array]::Copy($timestampBytes, 0, $signedMessage, 0, $timestampBytes.Length)
                $signedMessage[$timestampBytes.Length] = 10 # LF separator, exactly as cloud-run/http.ts
                [Array]::Copy($bodyBytes, 0, $signedMessage, $timestampBytes.Length + 1, $bodyBytes.Length)

                $hmac = [System.Security.Cryptography.HMACSHA256]::new($secretBytes)
                $signatureBytes = $hmac.ComputeHash($signedMessage)
                $signatureHex = [Convert]::ToHexString($signatureBytes).ToLowerInvariant()
                $headers = @{
                    'X-Watchly-Timestamp' = $timestamp
                    'X-Watchly-Signature' = $signatureHex
                }

                $validResponse = Invoke-RemoteRequest "$serviceUrl/v1/check" 'Post' $headers $bodyBytes
                $validPayload = $null
                $validShape = $false
                if ($null -ne $validResponse -and $validResponse.StatusCode -eq 200) {
                    try {
                        $validPayload = $validResponse.Content | ConvertFrom-Json -ErrorAction Stop
                        $metrics = $validPayload.metrics
                        $validShape = $validPayload.outcome -in @('initial', 'unchanged', 'changed', 'error') -and
                            $validPayload.message -is [string] -and $null -ne $metrics -and
                            $metrics.durationMs -is [ValueType] -and $metrics.fetchMs -is [ValueType] -and
                            $metrics.extractMs -is [ValueType] -and $metrics.normalizeMs -is [ValueType] -and
                            $metrics.hashMs -is [ValueType] -and $metrics.bytesReceived -is [ValueType]
                        if ($validShape -and $validPayload.outcome -ne 'error') {
                            $validShape = $validPayload.content -is [string] -and
                                $validPayload.contentHash -match '^[a-f0-9]{64}$' -and
                                $validPayload.httpStatus -ge 200 -and $validPayload.httpStatus -lt 300 -and
                                $validPayload.contentType -is [string]
                        }
                    }
                    catch { $validShape = $false }
                }
                $validOk = $null -ne $validResponse -and $validResponse.StatusCode -eq 200 -and $validShape
                $validDetail = if ($null -eq $validResponse) { 'Network, TLS, or timeout failure.' }
                    elseif ($validResponse.StatusCode -ne 200) { "Service returned HTTP $($validResponse.StatusCode)." }
                    elseif (-not $validShape) { 'Service returned an unexpected JSON response.' }
                    elseif ($validPayload.outcome -eq 'error') { 'HTTP 200; signature accepted, but the monitored page returned an error outcome.' }
                    else { "HTTP 200; outcome=$($validPayload.outcome)." }
                Add-TestResult 'HMAC válido' $validOk $validDetail

                $invalidSignature = if ($signatureHex[0] -eq '0') { '1' + $signatureHex.Substring(1) } else { '0' + $signatureHex.Substring(1) }
                $invalidHeaders = @{
                    'X-Watchly-Timestamp' = $timestamp
                    'X-Watchly-Signature' = $invalidSignature
                }
                $invalidResponse = Invoke-RemoteRequest "$serviceUrl/v1/check" 'Post' $invalidHeaders $bodyBytes
                $invalidOk = $null -ne $invalidResponse -and $invalidResponse.StatusCode -eq 401
                $invalidDetail = if ($null -eq $invalidResponse) { 'Network, TLS, or timeout failure.' } else { "Expected HTTP 401; received HTTP $($invalidResponse.StatusCode)." }
                Add-TestResult 'HMAC inválido' $invalidOk $invalidDetail

                $invalidSignature = $null
                $invalidHeaders = $null
                $headers = $null
            }
        }
    }
}
catch {
    Add-TestResult 'Remote smoke test setup' $false 'An unexpected local error occurred. No secret or signature details were logged.'
}
finally {
    if ($null -ne $hmac) { $hmac.Dispose() }
    foreach ($bytes in @($secretBytes, $timestampBytes, $bodyBytes, $signedMessage, $signatureBytes)) {
        if ($null -ne $bytes) { [System.Security.Cryptography.CryptographicOperations]::ZeroMemory($bytes) }
    }
    $secretText = $null
    $secretBytes = $null
    $signatureBytes = $null
    $signatureHex = $null
}

$failures = @($testResults | Where-Object { -not $_.Passed })
Write-Output ("Remote smoke test summary: {0} passed, {1} failed." -f ($testResults.Count - $failures.Count), $failures.Count)
if ($failures.Count -gt 0) { exit 1 }
