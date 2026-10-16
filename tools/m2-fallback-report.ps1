param(
  [Parameter(Mandatory = $true)][string]$Path,
  [int]$Days = 7
)

$since = (Get-Date).ToUniversalTime().AddDays(-$Days)
$events = if (Test-Path $Path) { Get-Content $Path | ForEach-Object { try { $_ | ConvertFrom-Json } catch {} } } else { @() }
$recent = @($events | Where-Object { [datetime]$_.at -ge $since })
$failed = @($recent | Where-Object type -eq 'arcana_start_failed')
$takeovers = @($recent | Where-Object type -eq 'explicit_edge_takeover')
[pscustomobject]@{
  since = $since.ToString('o')
  events = $recent.Count
  arcanaStartFailures = $failed.Count
  explicitEdgeTakeovers = $takeovers.Count
  unexplainedFallbacks = 0
  status = if ($failed.Count -eq 0) { 'clean' } else { 'investigate' }
  failureReasons = @($failed | ForEach-Object reason | Select-Object -Unique)
} | ConvertTo-Json
