<#
  Vocal Extractor — one-time setup.

  Usage (from this folder):
      powershell -ExecutionPolicy Bypass -File setup.ps1          # CPU (default, ~250 MB)
      powershell -ExecutionPolicy Bypass -File setup.ps1 -Gpu     # NVIDIA GPU (faster, ~2.5 GB)

  Requires Python 3.9 – 3.12. Python 3.11 is auto-detected if installed.
#>
param([switch]$Gpu)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$venvDir = Join-Path $root ".venv"
$venvPy  = Join-Path $venvDir "Scripts\python.exe"

Write-Host ""
Write-Host "  Vocal Extractor - setup" -ForegroundColor Magenta
Write-Host "  ================================="
Write-Host ""

# ---------------------------------------------------------------- Python 3.9-3.12
function Find-BasePython {
    $candidates = @()

    if (Get-Command py -ErrorAction SilentlyContinue) {
        foreach ($line in (& py -0p 2>$null)) {
            if ($line -match '-V:(\d+)\.(\d+)(?:\.\d+)?\s+(?:\*\s+)?(\S.*)$') {
                $maj = [int]$Matches[1]; $min = [int]$Matches[2]
                if ($maj -eq 3 -and $min -ge 9 -and $min -le 12) {
                    $candidates += , @($min, $Matches[3].Trim())
                }
            }
        }
    }

    foreach ($cmd in @("python", "python3")) {
        if (Get-Command $cmd -ErrorAction SilentlyContinue) {
            try {
                $v = & $cmd -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
                if ($v -match '^(3)\.(9|10|11|12)$') {
                    $path = (Get-Command $cmd).Source
                    $candidates += , @([int]$Matches[2], $path)
                }
            } catch { }
        }
    }

    if ($candidates.Count -eq 0) { return $null }
    $best = $candidates | Sort-Object { [int]$_[0] } -Descending | Select-Object -First 1
    return $best[1]
}

# 1) Virtual environment -------------------------------------------------------
if (Test-Path $venvPy) {
    Write-Host "  [1/4] Reusing existing .venv" -ForegroundColor Green
} else {
    $basePy = Find-BasePython
    if (-not $basePy) {
        Write-Host "  No Python 3.9-3.12 found." -ForegroundColor Red
        Write-Host "  Install Python 3.11 from https://www.python.org/downloads/ and re-run setup.ps1"
        exit 1
    }
    Write-Host "  [1/4] Creating virtual environment with $basePy" -ForegroundColor Cyan
    & $basePy -m venv $venvDir
    if ($LASTEXITCODE -ne 0) { Write-Host "  Failed to create the virtual environment." -ForegroundColor Red; exit 1 }
}

# 2) pip ----------------------------------------------------------------------
Write-Host "  [2/4] Upgrading pip" -ForegroundColor Cyan
& $venvPy -m pip install --upgrade pip --quiet
if ($LASTEXITCODE -ne 0) { Write-Host "  pip upgrade failed." -ForegroundColor Red; exit 1 }

# 3) PyTorch ------------------------------------------------------------------
$target = "CPU"
if ($Gpu) {
    $target = "GPU (CUDA 12.1)"
    $driver = $null
    if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
        $driver = (& nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>$null | Select-Object -First 1)
    }
    if (-not $driver) {
        Write-Host "  -Gpu was requested but no NVIDIA driver (nvidia-smi) was found." -ForegroundColor Red
        Write-Host "  Run:  powershell -ExecutionPolicy Bypass -File setup.ps1   (CPU version instead)"
        exit 1
    }
    $driverMajor = 0
    if ($driver -match '^(\d+)') { $driverMajor = [int]$Matches[1] }
    if ($driverMajor -lt 530) {
        Write-Host "  Your NVIDIA driver ($driver) is too old for the CUDA build (needs >= 530)." -ForegroundColor Red
        Write-Host "  Update the driver from GeForce Experience / nvidia.com, or run the CPU setup:"
        Write-Host "  powershell -ExecutionPolicy Bypass -File setup.ps1"
        exit 1
    }
}

Write-Host "  [3/4] Installing PyTorch for $target (this is the big download)" -ForegroundColor Cyan
$torchArgs = @("-m", "pip", "install", "torch==2.3.1", "torchaudio==2.3.1")
if ($Gpu) { $torchArgs += @("--index-url", "https://download.pytorch.org/whl/cu121") }
& $venvPy @torchArgs
if ($LASTEXITCODE -ne 0) { Write-Host "  PyTorch install failed." -ForegroundColor Red; exit 1 }

# 4) App + Demucs -------------------------------------------------------------
Write-Host "  [4/4] Installing the app server + Demucs" -ForegroundColor Cyan
& $venvPy -m pip install -r (Join-Path $root "requirements.txt")
if ($LASTEXITCODE -ne 0) { Write-Host "  Dependency install failed." -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "  Setup complete!" -ForegroundColor Green
Write-Host ""
Write-Host "  Start the app with:   .\start.ps1"
Write-Host "  (or:  powershell -ExecutionPolicy Bypass -File start.ps1 )"
Write-Host ""
if (-not $Gpu) {
    Write-Host "  Tip: have an NVIDIA GPU? Re-run  .\setup.ps1 -Gpu  for ~10x faster AI separation." -ForegroundColor DarkYellow
    Write-Host ""
}
