# Sets up GPT-SoVITS as a trial voice-cloning provider for Mana.
#
# Downloads the official self-contained Windows package (includes its own
# Python runtime and pretrained models, so it sidesteps the pip/conda
# dependency chain that GPT-SoVITS's "Install Manually" path needs on a
# Python version it doesn't officially support). Requires 7-Zip (the
# archive uses a BCJ2-compressed section that Python's py7zr cannot read);
# installs it via winget if missing.
#
# Usage:
#   cd C:\ManaAI\Mana\tools
#   .\setup-gpt-sovits.ps1

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$targetDir = Join-Path $here "gpt-sovits"
$packageUrl = "https://huggingface.co/lj1995/GPT-SoVITS-windows-package/resolve/main/GPT-SoVITS-v2pro-20250604.7z?download=true"
$archivePath = Join-Path $here "gpt-sovits-package.7z"

if (Test-Path $targetDir) {
    Write-Host "tools\gpt-sovits already exists; delete it first to redo setup."
    exit 0
}

$sevenZip = "C:\Program Files\7-Zip\7z.exe"
if (-not (Test-Path $sevenZip)) {
    Write-Host "7-Zip not found; installing via winget (a UAC prompt may appear)..."
    winget install --id 7zip.7zip -e --accept-package-agreements --accept-source-agreements
    if (-not (Test-Path $sevenZip)) {
        Write-Error "7-Zip install did not complete. Install it manually from https://www.7-zip.org/ and re-run."
        exit 1
    }
}

Write-Host "Downloading GPT-SoVITS V2ProPlus package (~8 GB; this takes a while)..."
Invoke-WebRequest -Uri $packageUrl -OutFile $archivePath

Write-Host "Extracting..."
$extractDir = Join-Path $here "gpt-sovits-extract"
& $sevenZip x $archivePath "-o$extractDir" -y | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error "7-Zip extraction failed"
    exit 1
}

$nested = Get-ChildItem $extractDir -Directory | Select-Object -First 1
Move-Item $nested.FullName $targetDir
Remove-Item $extractDir -Recurse -Force
Remove-Item $archivePath -Force

Write-Host "Pointing the default inference config at v2ProPlus (package ships configured for v2)..."
$configPath = Join-Path $targetDir "GPT_SoVITS\configs\tts_infer.yaml"
$lines = Get-Content $configPath
# The "custom:" block is always the first 8 lines of this file across
# package releases; replace its three model-selecting lines by content
# rather than matching exact original whitespace.
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^\s*t2s_weights_path:" -and $i -lt 10) {
        $lines[$i] = "  t2s_weights_path: GPT_SoVITS/pretrained_models/s1v3.ckpt"
    } elseif ($lines[$i] -match "^\s*version:\s*v2\s*$" -and $i -lt 10) {
        $lines[$i] = "  version: v2ProPlus"
    } elseif ($lines[$i] -match "^\s*vits_weights_path:" -and $i -lt 10) {
        $lines[$i] = "  vits_weights_path: GPT_SoVITS/pretrained_models/v2Pro/s2Gv2ProPlus.pth"
    }
}
Set-Content -Path $configPath -Value $lines

Write-Host ""
Write-Host "Done. Prepare a reference clip next (see docs/gpt_sovits_setup.md), then either:"
Write-Host "  - set TTS_PROVIDER=gpt_sovits and start the launcher (it starts GPT-SoVITS automatically), or"
Write-Host "  - start it by hand:"
Write-Host "      cd $targetDir"
Write-Host "      .\runtime\python.exe api_v2.py -a 127.0.0.1 -p 9880"
