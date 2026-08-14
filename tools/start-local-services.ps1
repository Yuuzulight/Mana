# Starts Mana's local backend services (SearXNG + llama-server) standalone,
# without bringing up the full launcher (tray, bots, etc.). Useful for
# anything that just needs these two running, e.g. Wisp.
#
# Safe to re-run: skips a service that's already responding.
#
# Usage:
#   cd C:\GitHub Projects\Mana\tools
#   .\start-local-services.ps1

Set-StrictMode -Version Latest

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$searxngDir = Join-Path $here "searxng"
$searxngPython = Join-Path $searxngDir "venv\Scripts\python.exe"
$searxngSettings = Join-Path $searxngDir "mana-settings.yml"
$llamaDir = Join-Path $here "llama"
$llamaExe = Join-Path $llamaDir "llama-server.exe"
$llamaModelsDir = Join-Path $llamaDir "gguf-models"

function Test-Health($url) {
    try {
        $resp = Invoke-WebRequest -Uri $url -TimeoutSec 3 -UseBasicParsing
        return $resp.StatusCode -eq 200
    } catch {
        return $false
    }
}

# --- SearXNG (http://127.0.0.1:8890) ---
if (Test-Health "http://127.0.0.1:8890/search?q=health&format=json") {
    Write-Host "SearXNG already running on http://127.0.0.1:8890"
} elseif (-not (Test-Path $searxngPython)) {
    Write-Warning "SearXNG isn't set up on this machine yet. Run .\setup-searxng.ps1 first."
} else {
    Write-Host "Starting SearXNG..."
    $env:SEARXNG_SETTINGS_PATH = $searxngSettings
    Start-Process -FilePath $searxngPython -ArgumentList "-m", "searx.webapp" `
        -WorkingDirectory $searxngDir `
        -RedirectStandardOutput (Join-Path $searxngDir "searxng.out.log") `
        -RedirectStandardError (Join-Path $searxngDir "searxng.err.log") `
        -WindowStyle Hidden
}

# --- llama-server (http://127.0.0.1:8090) ---
if (Test-Health "http://127.0.0.1:8090/health") {
    Write-Host "llama-server already running on http://127.0.0.1:8090"
} elseif (-not (Test-Path $llamaExe)) {
    Write-Warning "llama-server.exe not found under tools\llama\. It isn't set up on this machine yet."
} else {
    $model = Get-ChildItem -Path $llamaModelsDir -Filter "*.gguf" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $model) {
        Write-Warning "No .gguf model found under tools\llama\gguf-models\."
    } else {
        Write-Host "Starting llama-server with $($model.Name)..."
        Start-Process -FilePath $llamaExe -ArgumentList @(
            "-m", $model.FullName,
            "--host", "127.0.0.1",
            "--port", "8090",
            "-t", "8",
            "-c", "8192",
            "--no-webui"
        ) -WorkingDirectory $llamaDir `
          -RedirectStandardOutput (Join-Path $llamaDir "llama-server.out.log") `
          -RedirectStandardError (Join-Path $llamaDir "llama-server.err.log") `
          -WindowStyle Hidden
    }
}

# --- Wait for both to come up ---
Write-Host "Waiting for services to respond (up to 60s; first model load can take longer)..."
$deadline = (Get-Date).AddSeconds(60)
do {
    $searxngOk = Test-Health "http://127.0.0.1:8890/search?q=health&format=json"
    $llamaOk = Test-Health "http://127.0.0.1:8090/health"
    if ($searxngOk -and $llamaOk) { break }
    Start-Sleep -Seconds 2
} while ((Get-Date) -lt $deadline)

Write-Host ""
Write-Host "SearXNG:      $(if ($searxngOk) { 'up at http://127.0.0.1:8890' } else { 'not responding yet -- check tools\searxng\searxng.err.log' })"
Write-Host "llama-server: $(if ($llamaOk) { 'up at http://127.0.0.1:8090' } else { 'not responding yet -- check tools\llama\llama-server.err.log' })"
