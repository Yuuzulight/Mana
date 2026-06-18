Set-StrictMode -Version Latest

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$venv = Join-Path $here "venv"

$pycmd = if (Get-Command py -ErrorAction SilentlyContinue) {
    "py"
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
    "python"
} else {
    $null
}

if (-not $pycmd) {
    Write-Error "Python not found. Install Python 3.10+ first."
    exit 1
}

$pyArgs = @()
if ($pycmd -eq "py") {
    $pyArgs = @("-3.13")
}

if (-not (Test-Path $venv)) {
    & $pycmd @pyArgs -m venv $venv
}

$activate = Join-Path $venv "Scripts\Activate.ps1"
. $activate

if (-not (Test-Path (Join-Path $venv "Scripts\python.exe"))) {
    Write-Error "TTS venv Python not found."
    exit 1
}

$venvPython = Join-Path $venv "Scripts\python.exe"

& $venvPython -m pip install --upgrade pip
& $venvPython -m pip install -r (Join-Path $here "requirements.txt")

& $venvPython -m uvicorn service:app --host 127.0.0.1 --port 5010
