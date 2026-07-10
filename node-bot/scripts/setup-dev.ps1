# PowerShell helper to prepare a development environment for node-bot
# Usage: run from repository root or from node-bot folder
# Example: pwsh .\node-bot\scripts\setup-dev.ps1 -Passcode 2468 -AdminToken "yourtoken"
param(
  [string]$Passcode = '',
  [string]$AdminToken = ''
)

$repoRoot = Resolve-Path '..' -Relative | Resolve-Path -Relative
Write-Host "Repo root: $PWD"
if ($Passcode -eq '') {
  Write-Host "No passcode provided. You can run the Node helper to create one interactively: node .\node-bot\scripts\generate_mobile_auth.js"
} else {
  Write-Host "Generating mobile auth hash and secret for passcode: $Passcode"
  node .\node-bot\scripts\generate_mobile_auth.js $Passcode
  Write-Host "(Run the printed setx commands if you want to persist them.)"
}

Write-Host "Setting recommended dev env vars for this PowerShell session..."
$env:SKIP_HEAVY_MODEL_TESTS = '1'
$env:LLAMA_ENABLE_FLASHATTN = '0'
$env:LLAMA_KV_COMPRESS = ''
$env:LLAMA_ENABLE_SMART_CONTEXT = '0'
$env:LLAMA_ENABLE_NO_KV_OFFLOAD = '0'
if ($AdminToken) { $env:ADMIN_TOKEN = $AdminToken }

Write-Host 'Environment variables set (in this shell):'
Write-Host "SKIP_HEAVY_MODEL_TESTS=$env:SKIP_HEAVY_MODEL_TESTS"
Write-Host "LLAMA_ENABLE_FLASHATTN=$env:LLAMA_ENABLE_FLASHATTN"
Write-Host "LLAMA_KV_COMPRESS=$env:LLAMA_KV_COMPRESS"
Write-Host "LLAMA_ENABLE_SMART_CONTEXT=$env:LLAMA_ENABLE_SMART_CONTEXT"
Write-Host "LLAMA_ENABLE_NO_KV_OFFLOAD=$env:LLAMA_ENABLE_NO_KV_OFFLOAD"
if ($AdminToken) { Write-Host "ADMIN_TOKEN is set for this session" }

Write-Host "To start the backend in this shell run: npm start`n"
