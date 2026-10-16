# Summarises Mana's browser engine log for Arcana's M2 exit: a week of runs with
# no unexplained fallback to Edge. An Edge start that was asked for (Take over,
# MANA_BROWSER_ENGINE=edge) is explained; Arcana failing to start or dying is not.
param(
  [string]$Path = (Join-Path $PSScriptRoot '..\node-bot\data\browser-profile\arcana-events.jsonl'),
  [int]$Days = 7
)

$since = (Get-Date).ToUniversalTime().AddDays(-$Days)
$events = if (Test-Path -LiteralPath $Path) { Get-Content -LiteralPath $Path | ForEach-Object { try { $_ | ConvertFrom-Json } catch {} } } else { @() }
$recent = @($events | Where-Object { $_.at -and (([datetime]$_.at).ToUniversalTime() -ge $since) })
$started = @($recent | Where-Object type -eq 'arcana_started')
$failed = @($recent | Where-Object type -in 'arcana_start_failed', 'arcana_disconnected')
$requested = @($recent | Where-Object type -eq 'edge_requested')
# Observation runs from the first event ever logged: a window of Days can only be
# "clean" once the log is at least that old and Arcana has run inside it.
$first = @($events | Where-Object { $_.at } | ForEach-Object { ([datetime]$_.at).ToUniversalTime() } | Sort-Object | Select-Object -First 1)
$observedDays = if ($first.Count) { ((Get-Date).ToUniversalTime() - $first[0]).TotalDays } else { 0 }
[pscustomobject]@{
  since = $since.ToString('o')
  arcanaStarts = $started.Count
  unexplainedFallbacks = $failed.Count
  explainedEdgeUses = $requested.Count
  observedDays = [math]::Round($observedDays, 2)
  # An empty or new log is not a clean week.
  status = if ($observedDays -lt $Days -or $started.Count -eq 0) { 'insufficient_observation' } elseif ($failed.Count -eq 0) { 'clean' } else { 'investigate' }
  failureReasons = @($failed | ForEach-Object { if ($_.reason) { $_.reason } else { $_.type } } | Select-Object -Unique)
} | ConvertTo-Json
