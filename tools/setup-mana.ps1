<#
Automates the safely-automatable parts of Mana's first-time setup:
  - installs npm dependencies for node-bot, windows-launcher, desktop-client
  - creates node-bot\.env from .env.sample (never overwrites an existing one)
  - scaffolds the directories whisper.cpp/llama.cpp binaries and models go in
  - runs node-bot's doctor.js at the end to report what's configured

It deliberately does NOT download whisper.cpp, llama.cpp, GGUF model
weights, or Whisper models - those come from several different third-party
sources (GitHub releases, HuggingFace) with no single stable URL to pin,
and they're multi-gigabyte downloads you should fetch (and pick the right
CPU/CUDA build/model size for your hardware) yourself. This script prints
exactly what's still needed and where each file goes.

Usage:
  cd C:\ManaAI\Mana\tools
  .\setup-mana.ps1

  # Skip npm install (e.g. you've already run it and just want the .env/
  # directory scaffolding + doctor report):
  .\setup-mana.ps1 -SkipInstall
#>
param(
  [switch]$SkipInstall
)

$ErrorActionPreference = "Continue"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Write-Step($text) {
  Write-Host ""
  Write-Host "== $text ==" -ForegroundColor Cyan
}

function Write-Ok($text) {
  Write-Host "  [ok] $text" -ForegroundColor Green
}

function Write-Warn($text) {
  Write-Host "  [!]  $text" -ForegroundColor Yellow
}

Write-Host "Mana setup" -ForegroundColor Magenta
Write-Host "Repo root: $repoRoot"

# --- Prerequisite checks -----------------------------------------------
Write-Step "Checking prerequisites"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
  $nodeVersion = (& node --version).Trim()
  Write-Ok "Node.js $nodeVersion found"
  $majorVersion = [int]($nodeVersion.TrimStart("v").Split(".")[0])
  if ($majorVersion -lt 18) {
    Write-Warn "Node $majorVersion is older than the recommended LTS (18+). Consider upgrading from https://nodejs.org."
  }
} else {
  Write-Warn "Node.js not found on PATH. Install the LTS build from https://nodejs.org, then re-run this script."
}

$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if ($gitCmd) {
  Write-Ok "Git found"
} else {
  Write-Warn "Git not found on PATH. Install Git for Windows if you'll be pulling updates."
}

# --- npm install ----------------------------------------------------------
if (-not $SkipInstall) {
  Write-Step "Installing npm dependencies"
  $npmProjects = @("node-bot", "windows-launcher", "desktop-client")
  foreach ($project in $npmProjects) {
    $projectPath = Join-Path $repoRoot $project
    if (-not (Test-Path (Join-Path $projectPath "package.json"))) {
      Write-Warn "$project`: no package.json found, skipping"
      continue
    }
    Write-Host "  Installing $project..."
    Push-Location $projectPath
    try {
      & npm install --no-audit --no-fund
      if ($LASTEXITCODE -eq 0) {
        Write-Ok "$project dependencies installed"
      } else {
        Write-Warn "$project`: npm install exited with code $LASTEXITCODE"
      }
    } finally {
      Pop-Location
    }
  }
} else {
  Write-Step "Skipping npm install (-SkipInstall)"
}

# --- .env scaffolding -------------------------------------------------
Write-Step "Setting up node-bot\.env"
$envSample = Join-Path $repoRoot "node-bot\.env.sample"
$envFile = Join-Path $repoRoot "node-bot\.env"
if (Test-Path $envFile) {
  Write-Ok ".env already exists, leaving it untouched"
} elseif (Test-Path $envSample) {
  Copy-Item $envSample $envFile
  Write-Ok "Created node-bot\.env from .env.sample - edit it to point at your whisper.cpp/llama.cpp binaries and models"
} else {
  Write-Warn "node-bot\.env.sample not found; cannot scaffold .env"
}

# --- Directory scaffolding ---------------------------------------------
Write-Step "Creating model/binary directories"
$directories = @(
  "tools\whisper\Release",
  "tools\whisper\models",
  "tools\llama\gguf-models"
)
foreach ($dir in $directories) {
  $fullPath = Join-Path $repoRoot $dir
  if (-not (Test-Path $fullPath)) {
    New-Item -ItemType Directory -Force -Path $fullPath | Out-Null
    Write-Ok "Created $dir"
  } else {
    Write-Ok "$dir already exists"
  }
}

# --- Doctor report -------------------------------------------------------
Write-Step "Running node-bot doctor"
$doctorPath = Join-Path $repoRoot "node-bot\doctor.js"
if (Test-Path $doctorPath) {
  Push-Location (Join-Path $repoRoot "node-bot")
  try {
    & node doctor.js
  } finally {
    Pop-Location
  }
} else {
  Write-Warn "node-bot\doctor.js not found, skipping"
}

# --- Remaining manual steps ----------------------------------------------
Write-Step "Manual steps still needed"
$manualSteps = @'
These involve downloading multi-gigabyte third-party binaries/models from
several different sources, so they are left for you to fetch deliberately
rather than auto-downloaded by this script:

  1. whisper.cpp (speech-to-text)
     - Get a Windows build (CPU or CUDA) from the whisper.cpp releases page.
     - Place the executable at tools\whisper\Release\whisper-cli.exe
     - Download a ggml model (ggml-base.en.bin or ggml-small.en.bin are a
       good starting point) into tools\whisper\models\
     - Point WHISPER_BIN / WHISPER_MODEL at them in node-bot\.env

  2. llama.cpp (local reply generation)
     - Get a Windows build (CPU or CUDA, matching your GPU) from the
       llama.cpp releases page.
     - Download a GGUF model (e.g. a Qwen3 quant) from Hugging Face into
       tools\llama\gguf-models\
     - Point LLAMA_BIN / LLAMA_MODEL at them in node-bot\.env

  3. Local TTS voice services (from tts-service\):
       .\start.ps1          # Chatterbox
       .\start_kokoro.ps1   # Kokoro
     Each installs its own Python dependencies and downloads its models on
     first run.

  4. Optional extras (each has its own setup doc under docs\):
     - Web search/wiki access: tools\setup-searxng.ps1
     - GPT-SoVITS trial voice: tools\setup-gpt-sovits.ps1
     - Vision (screen description): docs\vision_setup.md
     - Live2D avatar: cd windows-launcher; npm run fetch-live2d-core

Full details for every step: docs\quick_start_windows.md

Once your .env is filled in, start Mana with:
  cd windows-launcher
  npm run start
'@
Write-Host $manualSteps
