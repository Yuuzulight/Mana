# Summarises Mana's browser engine log for Arcana's M2 exit: 72 hours of runs with
# no unexplained fallback to Edge. An Edge start that was asked for (Take over,
# MANA_BROWSER_ENGINE=edge) is explained; Arcana failing to start or dying is not.
param(
  [string]$Path = (Join-Path $PSScriptRoot '..\node-bot\data\browser-profile\arcana-events.jsonl'),
  [int]$Days = 3,
  # One start in a quiet observation window is not evidence; clean needs at least this many.
  [int]$MinStarts = 5,
  [string]$Since = '',
  [string]$Until = ''
)

$windowEnd = if ($Until) { ([datetime]$Until).ToUniversalTime() } else { (Get-Date).ToUniversalTime() }
$windowStart = if ($Since) { ([datetime]$Since).ToUniversalTime() } else { $windowEnd.AddDays(-$Days) }

$events = if (Test-Path -LiteralPath $Path) {
  Get-Content -LiteralPath $Path | ForEach-Object { try { $_ | ConvertFrom-Json } catch {} }
} else {
  @()
}

$recent = @($events | Where-Object {
  if (-not $_.at) { return $false }
  $t = ([datetime]$_.at).ToUniversalTime()
  $t -ge $windowStart -and $t -le $windowEnd
})

$started = @($recent | Where-Object type -eq 'arcana_started')
$failed = @($recent | Where-Object type -in 'arcana_start_failed', 'arcana_disconnected')
$requested = @($recent | Where-Object type -eq 'edge_requested')

$first = @($recent | Where-Object { $_.at } | ForEach-Object { ([datetime]$_.at).ToUniversalTime() } | Sort-Object | Select-Object -First 1)
$last = @($recent | Where-Object { $_.at } | ForEach-Object { ([datetime]$_.at).ToUniversalTime() } | Sort-Object | Select-Object -Last 1)

$observedDays = if ($first.Count -and $last.Count) {
  ($last[0] - $first[0]).TotalDays
} else {
  0
}

$effectiveObservedDays = if ($Since -and $Until -and $recent.Count -gt 0) {
  ($windowEnd - $windowStart).TotalDays
} else {
  $observedDays
}

$status = if (-not (Test-Path -LiteralPath $Path) -or $recent.Count -eq 0) {
  'insufficient_observation'
} elseif ($failed.Count -gt 0) {
  'investigate'
} elseif ($effectiveObservedDays -lt ($Days - 0.05)) {
  'insufficient_observation'
} elseif ($started.Count -lt $MinStarts) {
  'insufficient_observation'
} else {
  'clean'
}

[pscustomobject]@{
  since = $windowStart.ToString('o')
  until = $windowEnd.ToString('o')
  arcanaStarts = $started.Count
  unexplainedFallbacks = $failed.Count
  explainedEdgeUses = $requested.Count
  observedDays = [math]::Round($effectiveObservedDays, 2)
  status = $status
  failureReasons = @($failed | ForEach-Object { if ($_.reason) { $_.reason } else { $_.type } } | Select-Object -Unique)
} | ConvertTo-Json
