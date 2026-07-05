<#
PowerShell downloader for large model and audio assets
Usage:
  .\download_large_assets.ps1 -BaseUrl "https://example.com/assets" -OutDir "."

By default the script expects assets to be hosted under a common base URL. You can also pass explicit URLs per-file.
#>
param(
  [string]$BaseUrl = $env:ASSET_BASE_URL,
  [string]$OutDir = ".",
  [switch]$WhatIf
)

$files = @(
  @{ path = "tools/whisper/models/ggml-tiny.en.bin"; name = "ggml-tiny.en.bin" },
  @{ path = "tools/whisper/test.wav"; name = "test.wav" },
  @{ path = "mana-younger-sister-voice-test.wav"; name = "mana-younger-sister-voice-test.wav" },
  @{ path = "tts-language-tests-single-voice/english.wav"; name = "tts-english.wav" }
)

if (-not $BaseUrl) {
  Write-Host "ERROR: No BaseUrl provided. Set ASSET_BASE_URL environment variable or pass -BaseUrl." -ForegroundColor Red
  Write-Host "Example: $env:ASSET_BASE_URL = 'https://github.com/your-user/Mana/releases/download/v1'"
  exit 1
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

foreach ($f in $files) {
  $targetPath = Join-Path $OutDir $f.path
  $targetDir = Split-Path $targetPath -Parent
  New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

  $url = "${BaseUrl}/${f.name}"
  Write-Host "Downloading $url -> $targetPath"
  if ($WhatIf) { continue }
  try {
    Invoke-WebRequest -Uri $url -OutFile $targetPath -UseBasicParsing -ErrorAction Stop
  } catch {
    Write-Host "Failed to download $url: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

Write-Host "Done. Verify files exist in $OutDir" -ForegroundColor Green
