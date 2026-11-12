<#
Runs the real Arcana integration suite unattended for a bounded three-day window.
The runner is intentionally Windows/PowerShell because Arcana's pinned engine and
Mana integration are Windows x64 workloads. It exits on the first failed cycle so
the final report cannot hide a broken run.
#>
[CmdletBinding()]
param(
  [int]$Hours = 72,
  [int]$IntervalMinutes = 10,
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\artifacts\arcana-m2-soak')
)

$ErrorActionPreference = 'Stop'
if ($Hours -le 0) { throw 'Hours must be positive.' }
if ($IntervalMinutes -lt 1) { throw 'IntervalMinutes must be at least 1.' }

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$out = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $out | Out-Null
$events = Join-Path $out 'arcana-events.jsonl'
$heartbeat = Join-Path $out 'heartbeat.json'
$summary = Join-Path $out 'summary.json'
$cycleLog = Join-Path $out 'cycles'
New-Item -ItemType Directory -Force -Path $cycleLog | Out-Null

$env:MANA_ARCANA_TEST_REAL = '1'
$env:MANA_ARCANA_SIGNIN_SPIKES = '0'
$env:MANA_ARCANA_EVENTS_FILE = $events
$env:MANA_ARCANA_ALLOW_PRIVATE_NETWORK = '1'

$startedAt = [DateTime]::UtcNow
$deadline = $startedAt.AddHours($Hours)
$cycle = 0
$failure = $null

while ([DateTime]::UtcNow -lt $deadline) {
  $cycle++
  $cycleStarted = [DateTime]::UtcNow
  $log = Join-Path $cycleLog ('cycle-{0:D5}.log' -f $cycle)
  Push-Location $repo
  try {
    & node --test plugins\browser-automation\test\arcana-real-engine.test.js *> $log
    $exitCode = $LASTEXITCODE
  } finally { Pop-Location }

  $heartbeatValue = [ordered]@{
    startedAt = $startedAt.ToString('o')
    deadline = $deadline.ToString('o')
    lastCycle = $cycle
    lastCycleStartedAt = $cycleStarted.ToString('o')
    lastCycleFinishedAt = [DateTime]::UtcNow.ToString('o')
    lastExitCode = $exitCode
    status = if ($exitCode -eq 0) { 'running' } else { 'failed' }
  }
  $heartbeatValue | ConvertTo-Json | Set-Content -LiteralPath $heartbeat -Encoding UTF8
  if ($exitCode -ne 0) {
    $failure = "Cycle $cycle failed with exit code $exitCode. See $log"
    break
  }
  $remaining = ($deadline - [DateTime]::UtcNow).TotalSeconds
  if ($remaining -le 0) { break }
  Start-Sleep -Seconds ([math]::Min($IntervalMinutes * 60, [math]::Max(1, [int]$remaining)))
}

$reportScript = Join-Path $PSScriptRoot 'm2-fallback-report.ps1'
$report = & powershell -NoProfile -ExecutionPolicy Bypass -File $reportScript -Path $events -Days 3 -MinStarts 5 | Out-String
$final = [ordered]@{
  startedAt = $startedAt.ToString('o')
  finishedAt = [DateTime]::UtcNow.ToString('o')
  deadline = $deadline.ToString('o')
  cycles = $cycle
  runnerFailure = $failure
  fallbackReport = $report.Trim() | ConvertFrom-Json
  status = if ($failure) { 'failed' } elseif ([DateTime]::UtcNow -ge $deadline) { 'complete' } else { 'incomplete' }
}
$final | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $summary -Encoding UTF8
$final | ConvertTo-Json -Depth 6
if ($failure) { exit 1 }
