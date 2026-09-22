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

try {
    Receive-Job $job -Wait -Follow
} finally {
    Stop-Job $job -ErrorAction SilentlyContinue
    Remove-Job $job -Force -ErrorAction SilentlyContinue
    Write-Host ""
    Write-Host "  Server stopped." -ForegroundColor Yellow
}
