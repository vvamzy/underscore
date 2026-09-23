<#
  Vocal Extractor — start the local website + AI server.

  Usage:
      powershell -ExecutionPolicy Bypass -File start.ps1

  Then open http://localhost:8000 (a browser tab opens automatically).
  Stop with Ctrl+C.
#>
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$venvPy = Join-Path $root ".venv\Scripts\python.exe"

if (-not (Test-Path $venvPy)) {
    Write-Host "  Setup hasn't run yet. Run this first:" -ForegroundColor Red
    Write-Host "  powershell -ExecutionPolicy Bypass -File setup.ps1"
    exit 1
}

Write-Host ""
Write-Host "  Starting Vocal Extractor on http://localhost:8000" -ForegroundColor Magenta
Write-Host "  (Ctrl+C stops the server)"
Write-Host ""

$job = Start-Job -ScriptBlock {
    param($py, $dir)
    Set-Location $dir
    & $py -m uvicorn server:app --host 127.0.0.1 --port 8000
} -ArgumentList $venvPy, $root

# Wait for the health endpoint, then open the browser.
$opened = $false
for ($i = 0; $i -lt 40; $i++) {
    if ($job.State -ne "Running") { break }
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:8000/api/health" -UseBasicParsing -TimeoutSec 2
        if ($resp.StatusCode -eq 200) {
            if (-not $opened) { Start-Process "http://localhost:8000"; $opened = $true }
            break
        }
    } catch { Start-Sleep -Milliseconds 700 }
}

if (-not $opened -and $job.State -eq "Running") {
    Start-Process "http://localhost:8000"
    $opened = $true
}

# Uvicorn writes its logs to stderr. Inside a PowerShell job those appear as
# error records, and with $ErrorActionPreference="Stop" the first log line
# would kill the streaming loop. So collect them quietly and relay as plain
# log lines instead of letting them abort the script.
function Drain-JobOutput([object]$j) {
    $errs = @()
    Receive-Job $j -ErrorVariable +errs -ErrorAction SilentlyContinue |
        ForEach-Object { Write-Host $_ }
    $errs | ForEach-Object { Write-Host $_.Exception.Message }
}

try {
    # Stream the server's logs live. (`Receive-Job -Follow` isn't available on
    # every PowerShell build, so poll instead — works on PS 5.1 and PS 7.)
    while ($job.State -eq "Running") {
        Drain-JobOutput $job
        Start-Sleep -Milliseconds 400
    }
    Drain-JobOutput $job
} finally {
    Stop-Job $job -ErrorAction SilentlyContinue
    Remove-Job $job -Force -ErrorAction SilentlyContinue
    Write-Host ""
    Write-Host "  Server stopped." -ForegroundColor Yellow
}
