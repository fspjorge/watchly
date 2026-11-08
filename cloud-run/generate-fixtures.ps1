param(
    [string]$OpenSSL = "openssl"
)

$ErrorActionPreference = "Stop"
$fixtures = Join-Path $PSScriptRoot "fixtures"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("watchly-certs-" + [guid]::NewGuid().ToString("N"))

function Invoke-OpenSSL {
    param(
        [Parameter(Mandatory)][string]$Executable,
        [Parameter(Mandatory)][string[]]$Arguments,
        [switch]$CaptureOutput
    )

    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $Executable
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    # ArgumentList is unavailable in some PowerShell/.NET combinations used on
    # Windows. All arguments here are paths or simple OpenSSL flags; quote each
    # one and escape embedded quotes for ProcessStartInfo.Arguments.
    $psi.Arguments = (($Arguments | ForEach-Object {
        '"' + $_.Replace('"', '\"') + '"'
    }) -join ' ')

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $psi
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
        throw "OpenSSL '$($Arguments[0])' falhou (exit $($process.ExitCode)): $stderr$stdout"
    }
    if ($CaptureOutput) { return $stdout + $stderr }
}

try {
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    New-Item -ItemType Directory -Path $fixtures -Force | Out-Null
    $opensslCommand = Get-Command $OpenSSL -ErrorAction Stop
    $opensslPath = $opensslCommand.Path
    if ([string]::IsNullOrWhiteSpace($opensslPath)) { $opensslPath = $opensslCommand.Source }
    if ([string]::IsNullOrWhiteSpace($opensslPath)) { throw "Não foi possível localizar o executável OpenSSL '$OpenSSL'." }

    @"
[req]
prompt = no
distinguished_name = dn
x509_extensions = v3_ca
[dn]
CN = Watchly Test CA
[v3_ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
"@ | Set-Content -LiteralPath (Join-Path $tmp "ca.cnf") -Encoding ascii

    @"
[req]
prompt = no
distinguished_name = dn
req_extensions = v3_req
[dn]
CN = watchly.test
[v3_req]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names
subjectKeyIdentifier = hash
[alt_names]
DNS.1 = watchly.test
"@ | Set-Content -LiteralPath (Join-Path $tmp "server.cnf") -Encoding ascii

    @"
[req]
prompt = no
distinguished_name = dn
req_extensions = v3_req
[dn]
CN = localhost
[v3_req]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names
subjectKeyIdentifier = hash
[alt_names]
DNS.1 = localhost
DNS.2 = wrong-host.test
IP.1 = 127.0.0.1
IP.2 = ::1
"@ | Set-Content -LiteralPath (Join-Path $tmp "wrong-host.cnf") -Encoding ascii

    $caKey = Join-Path $tmp "ca-key.pem"
    $caCert = Join-Path $tmp "ca.pem"
    Invoke-OpenSSL $opensslPath @("req","-x509","-newkey","rsa:2048","-nodes","-keyout",$caKey,"-out",$caCert,"-days","3650","-config",(Join-Path $tmp "ca.cnf"),"-extensions","v3_ca")

    foreach ($name in @("server", "wrong-host")) {
        $config = Join-Path $tmp "$name.cnf"
        $key = Join-Path $tmp "$name-key.pem"
        $csr = Join-Path $tmp "$name.csr"
        $cert = Join-Path $tmp "$name.pem"
        Invoke-OpenSSL $opensslPath @("req","-newkey","rsa:2048","-nodes","-keyout",$key,"-out",$csr,"-config",$config)
        Invoke-OpenSSL $opensslPath @("x509","-req","-in",$csr,"-CA",$caCert,"-CAkey",$caKey,"-CAcreateserial","-out",$cert,"-days","365","-extensions","v3_req","-extfile",$config)
        $verified = Invoke-OpenSSL $opensslPath @("verify","-CAfile",$caCert,$cert) -CaptureOutput
        if ($verified -notmatch ': OK\s*$') { throw "A cadeia de $name.pem não foi validada: $verified" }
        $san = Invoke-OpenSSL $opensslPath @("x509","-in",$cert,"-noout","-ext","subjectAltName") -CaptureOutput
        if ($name -eq "server" -and $san -notmatch 'DNS:watchly\.test') { throw "server.pem não contém SAN DNS:watchly.test: $san" }
        if ($name -eq "wrong-host" -and ($san -notmatch 'DNS:localhost' -or $san -notmatch 'DNS:wrong-host\.test' -or $san -notmatch 'IP Address:127\.0\.0\.1' -or $san -notmatch 'IP Address:0:0:0:0:0:0:0:1')) {
            throw "wrong-host.pem não contém os SAN DNS/IP esperados: $san"
        }
    }

    Copy-Item -LiteralPath $caCert -Destination (Join-Path $fixtures "ca.pem") -Force
    Copy-Item -LiteralPath (Join-Path $tmp "server.pem") -Destination (Join-Path $fixtures "server.pem") -Force
    Copy-Item -LiteralPath (Join-Path $tmp "server-key.pem") -Destination (Join-Path $fixtures "server-key.pem") -Force
    Copy-Item -LiteralPath (Join-Path $tmp "wrong-host.pem") -Destination (Join-Path $fixtures "wrong-host.pem") -Force
    Copy-Item -LiteralPath (Join-Path $tmp "wrong-host-key.pem") -Destination (Join-Path $fixtures "wrong-host-key.pem") -Force

    Write-Output "Certificados de teste gerados e validados em $fixtures. A chave privada da CA foi mantida apenas na pasta temporária."
}
catch {
    Write-Error "Falha ao gerar fixtures TLS: $($_.Exception.Message)"
    exit 1
}
finally {
    if (Test-Path -LiteralPath $tmp) {
        Remove-Item -LiteralPath $tmp -Recurse -Force
    }
}
