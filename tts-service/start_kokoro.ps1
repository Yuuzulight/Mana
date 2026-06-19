Set-StrictMode -Version Latest

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$venv = Join-Path $here "venv"
$venvPython = Join-Path $venv "Scripts\python.exe"
$kokoroDir = Join-Path $here "kokoro"
$modelPath = Join-Path $kokoroDir "kokoro-v1.0.int8.onnx"
$voicesPath = Join-Path $kokoroDir "voices-v1.0.bin"
$modelUrl = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx"
$voicesUrl = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"

if (-not (Test-Path $venvPython)) {
    Write-Error "TTS venv Python not found. Run .\start.ps1 once first."
    exit 1
}

& $venvPython -m pip install -r (Join-Path $here "requirements.txt")

if (-not (Test-Path $kokoroDir)) {
    New-Item -ItemType Directory -Path $kokoroDir | Out-Null
}

if (-not (Test-Path $modelPath)) {
    Invoke-WebRequest -Uri $modelUrl -OutFile $modelPath
}

if (-not (Test-Path $voicesPath)) {
    Invoke-WebRequest -Uri $voicesUrl -OutFile $voicesPath
}

& $venvPython -m uvicorn kokoro_service:app --host 127.0.0.1 --port 5011
