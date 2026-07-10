# Check retriever health (PowerShell)
param(
  [string]$Url = 'http://127.0.0.1:9000/health',
  [int]$TimeoutSec = 3
)
try {
  $res = Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec $TimeoutSec
  Write-Host "Retriever response:" (ConvertTo-Json $res -Depth 3)
} catch {
  Write-Host "Retriever not reachable at $Url : $_"
  exit 1
}
