# Registers node-bot as a genuine Windows service via NSSM, so it starts on
# boot and restarts on crash instead of only running while windows-launcher
# happens to be open. See README.md in this folder for the reasoning and
# the windows-launcher-side Settings > Connection change this requires
# (must be the LAN IP, not localhost -- see that doc).
#
# Requires: an elevated (Administrator) PowerShell session, and Chocolatey
# (already present on this machine) to install NSSM itself if it's missing.
# Re-running this script is safe -- `nssm install` on an existing service
# just reports it's already installed; every `nssm set` below simply
# overwrites the prior value.

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Error "This script must be run from an elevated (Administrator) PowerShell session. Right-click PowerShell/Terminal and choose 'Run as administrator', then re-run this script."
    exit 1
}

$ServiceName = "ManaNodeBot"
$NodeBotDir = Split-Path -Parent $PSScriptRoot
$RootDir = Split-Path -Parent $NodeBotDir
$LogDir = Join-Path $NodeBotDir "data"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) {
    Write-Host "NSSM not found -- installing via Chocolatey..."
    choco install nssm -y
}

$nodeExe = (Get-Command node -ErrorAction Stop).Source

Write-Host "Installing service '$ServiceName'..."
nssm install $ServiceName $nodeExe "server.js"
nssm set $ServiceName AppDirectory $NodeBotDir
nssm set $ServiceName DisplayName "Mana Node Backend"
nssm set $ServiceName Description "node-bot backend for Mana (llama.cpp replies, Whisper transcription, TTS, memory). See node-bot/service/README.md."
nssm set $ServiceName Start SERVICE_AUTO_START
nssm set $ServiceName AppExit Default Restart
nssm set $ServiceName AppRestartDelay 3000
nssm set $ServiceName AppStdout (Join-Path $LogDir "service-stdout.log")
nssm set $ServiceName AppStderr (Join-Path $LogDir "service-stderr.log")

# Same defaults windows-launcher's main.js passes when it spawns node-bot
# itself (startWindowsServices()) -- replicated explicitly here since a
# standalone `node server.js` doesn't get them for free. USE_EMBEDDINGS is
# the one that actually matters: node-bot's own default is OFF
# (tools/retriever-index.js), so without this, session search and Deep
# Research would silently lose semantic retrieval under the service.
$whisperBin = Join-Path $RootDir "tools\whisper\Release\whisper-cli.exe"
$whisperModel = Join-Path $RootDir "tools\whisper\models\ggml-tiny.en.bin"
nssm set $ServiceName AppEnvironmentExtra `
    "WHISPER_BIN=$whisperBin" `
    "WHISPER_MODEL=$whisperModel" `
    "TTS_PROVIDER=fish" `
    "KOKORO_TTS_URL=http://127.0.0.1:5011" `
    "VTUBE_STUDIO_URL=ws://127.0.0.1:8001" `
    "VTUBE_STUDIO_ENABLED=1" `
    "USE_EMBEDDINGS=1" `
    "RETRIEVER_EMBEDDER_URL=http://127.0.0.1:9001"

Write-Host "Starting service..."
nssm start $ServiceName

Write-Host ""
Write-Host "Done. '$ServiceName' is now running as a Windows service (auto-starts on boot, restarts on crash)."
Write-Host "Logs: $LogDir\service-stdout.log / service-stderr.log"
Write-Host ""
Write-Host "IMPORTANT: in windows-launcher's Settings > Connection, set the backend URL to this machine's LAN IP (e.g. http://192.168.x.x:5005), NOT localhost:5005 -- localhost is treated as loopback and windows-launcher will spawn a second, redundant local copy of node-bot on top of this service otherwise. desktop-client needs no change; it never spawns node-bot itself."
