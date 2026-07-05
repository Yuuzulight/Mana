<#
CI runner for Mana local stack (retriever, node, smoke tests, unit tests)
Usage (from node-bot):
  powershell -ExecutionPolicy Bypass -File ci_run.ps1

This script:
 - Starts the Python retriever service (using project venv python if present)
 - Waits for retriever health (/health)
 - Starts Node backend
 - Waits for Node health (/health)
 - Runs smoke_test.js
 - Runs native unit tests (node --test test/*.test.js)
 - Tears down processes and exits with non-zero if any step failed
#>

param(
  [int]$RetrieverRetries = 60,
  [int]$RetrieverDelayMs = 2000,
  [int]$NodeRetries = 30,
  [int]$NodeDelayMs = 1000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Push-Location $scriptDir

Write-Host "[CI] Starting CI-runner in $scriptDir"

# Find python binary (project venv preferred)
$projectVenv = Join-Path $scriptDir "..\ManaAIManatext-generation-webui\venv\Scripts\python.exe"
if (Test-Path $projectVenv) {
    $pythonBin = (Resolve-Path $projectVenv).Path
    Write-Host "[CI] Using project venv python at $pythonBin"
} else {
    $pythonBin = "python"
    Write-Host "[CI] Using python from PATH"
}

$retrieverScript = Join-Path $scriptDir "..\tools\retriever_service.py"
if (-not (Test-Path $retrieverScript)) {
    Write-Error "Retriever script not found at $retrieverScript"
    exit 2
}

# Start retriever
Write-Host "[CI] Starting retriever service..."
$pyProc = Start-Process -FilePath $pythonBin -ArgumentList '-u', "$retrieverScript" -PassThru -WindowStyle Hidden
Write-Host "[CI] Retriever PID: $($pyProc.Id)"

# Wait for retriever health
$retrieverHealthUrl = 'http://127.0.0.1:9000/health'
function Wait-ForUrl($url, $retries, $delayMs, $name) {
    for ($i = 1; $i -le $retries; $i++) {
        try {
            $r = Invoke-RestMethod -Method Get -Uri $url -TimeoutSec 5 -ErrorAction Stop
            if ($r -and $r.status -eq 'healthy') {
                Write-Host "[CI] $name is healthy: $($r.details)"
                return $true
            } else {
                Write-Host "[CI] $name not ready (status=$($r.status)) - attempt $i/$retries"
            }
        } catch {
            Write-Host "[CI] $name health check attempt $i/$retries: $($_.Exception.Message)"
        }
        Start-Sleep -Milliseconds $delayMs
    }
    return $false
}

$ok = Wait-ForUrl $retrieverHealthUrl $RetrieverRetries $RetrieverDelayMs 'Retriever'
if (-not $ok) {
    Write-Error "[CI] Retriever failed to become healthy"
    # Tear down
    if ($pyProc) { Stop-Process -Id $pyProc.Id -Force -ErrorAction SilentlyContinue }
    exit 3
}

# Start Node backend
Write-Host "[CI] Starting Node backend..."
$nodeCmd = "node"
$nodeProc = Start-Process -FilePath $nodeCmd -ArgumentList 'server.js' -WorkingDirectory $scriptDir -PassThru -WindowStyle Hidden
Write-Host "[CI] Node PID: $($nodeProc.Id)"

# Wait for Node /health
$nodeHealthUrl = 'http://127.0.0.1:5005/health'
$okNode = Wait-ForUrl $nodeHealthUrl $NodeRetries $NodeDelayMs 'Node'
if (-not $okNode) {
    Write-Error "[CI] Node failed to become healthy"
    if ($nodeProc) { Stop-Process -Id $nodeProc.Id -Force -ErrorAction SilentlyContinue }
    if ($pyProc) { Stop-Process -Id $pyProc.Id -Force -ErrorAction SilentlyContinue }
    exit 4
}

# Run smoke test
Write-Host "[CI] Running smoke test..."
$smokeExit = 0
try {
    & $nodeCmd (Join-Path $scriptDir "..\tools\smoke_test.js")
    $smokeExit = $LASTEXITCODE
    Write-Host "[CI] Smoke test exit code: $smokeExit"
} catch {
    Write-Host "[CI] Smoke test failed: $($_.Exception.Message)"
    $smokeExit = 1
}

# Run unit tests (node --test test/*.test.js)
Write-Host "[CI] Running unit tests (node --test test/*.test.js)..."
$unitExit = 0
try {
    & $nodeCmd '--test' (Join-Path $scriptDir 'test\*.test.js')
    $unitExit = $LASTEXITCODE
    Write-Host "[CI] Unit tests exit code: $unitExit"
} catch {
    Write-Host "[CI] Unit tests failed: $($_.Exception.Message)"
    $unitExit = 1
}

# Teardown
Write-Host "[CI] Shutting down Node (PID $($nodeProc.Id)) and Retriever (PID $($pyProc.Id))..."
if ($nodeProc) { Stop-Process -Id $nodeProc.Id -Force -ErrorAction SilentlyContinue }
if ($pyProc) { Stop-Process -Id $pyProc.Id -Force -ErrorAction SilentlyContinue }

if ($smokeExit -eq 0 -and $unitExit -eq 0) {
    Write-Host "[CI] All checks passed"
    exit 0
} else {
    Write-Error "[CI] CI checks failed: smoke=$smokeExit unit=$unitExit"
    exit ([Math]::Max($smokeExit, $unitExit))
}

Pop-Location
