# Sets up Mana's local SearXNG (web search) install from scratch.
#
# Run this once (or after deleting tools\searxng\) to reproduce the local
# search backend. Downloads a source tarball instead of `git clone` because
# SearXNG ships a few packaging template files with a literal ":" in the
# filename, which NTFS cannot create; the tarball extraction below skips
# them (they're Apache/nginx/uwsgi config templates, unused by the plain
# Python dev-server path this script sets up).
#
# Usage:
#   cd C:\ManaAI\Mana\tools
#   .\setup-searxng.ps1

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$searxngDir = Join-Path $here "searxng"
$tarballUrl = "https://github.com/searxng/searxng/archive/refs/heads/master.tar.gz"
$tarballPath = Join-Path $here "searxng.tar.gz"

if (Test-Path $searxngDir) {
    Write-Host "tools\searxng already exists; delete it first to redo setup."
    exit 0
}

Write-Host "Downloading SearXNG source..."
Invoke-WebRequest -Uri $tarballUrl -OutFile $tarballPath

Write-Host "Extracting (excluding packaging templates with Windows-invalid filenames)..."
tar -xzf $tarballPath --exclude="*/utils/templates/*" -C $here
if ($LASTEXITCODE -ne 0) {
    Write-Error "tar extraction failed"
    exit 1
}
Move-Item (Join-Path $here "searxng-master") $searxngDir
Remove-Item $tarballPath

Write-Host "Locating a Windows Python (3.11-3.13 recommended; SearXNG deps may lack wheels for newer versions)..."
$pythonCandidates = @(
    "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe"
)
$python = $pythonCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $python) {
    $python = "python"
    Write-Warning "No known Python 3.11-3.13 install found; falling back to plain 'python' on PATH. If dependency installation fails, install Python 3.13 and re-run."
}

Write-Host "Creating venv with $python..."
& $python -m venv (Join-Path $searxngDir "venv")

$venvPython = Join-Path $searxngDir "venv\Scripts\python.exe"
Write-Host "Installing SearXNG dependencies (this takes a few minutes)..."
& $venvPython -m pip install --quiet --upgrade pip
& $venvPython -m pip install --quiet -r (Join-Path $searxngDir "requirements.txt")

Write-Host "Installing pwd module stub (SearXNG imports the POSIX-only 'pwd' module for a Linux-only log line inside a Valkey-connection-failure handler that Mana's config never triggers)..."
$sitePackages = & $venvPython -c "import site; print(site.getsitepackages()[0])"
$pwdStub = @"
"""Windows stub for the POSIX-only ``pwd`` module.

SearXNG's valkeydb.py imports ``pwd`` unconditionally at module load time to
format a username into a log line inside a Valkey-connection-failure handler
(searx/valkeydb.py). Mana's local instance never configures Valkey, so that
code path never runs, but the bare ``import pwd`` still crashes on Windows
without this stub. getpwuid raises if the codepath is ever hit instead of
silently returning fake data.
"""


def getpwuid(uid):
    raise KeyError(f"no pwd module on Windows (uid={uid})")
"@
Set-Content -Path (Join-Path $sitePackages "pwd.py") -Value $pwdStub -Encoding utf8

Write-Host "Copying Mana's SearXNG settings..."
Copy-Item (Join-Path $here "mana-searxng-settings.yml") (Join-Path $searxngDir "mana-settings.yml")

Write-Host ""
Write-Host "Done. Start it with:"
Write-Host "  cd $searxngDir"
Write-Host '  $env:SEARXNG_SETTINGS_PATH = "' -NoNewline
Write-Host (Join-Path $searxngDir "mana-settings.yml") -NoNewline
Write-Host '"'
Write-Host "  .\venv\Scripts\python.exe -m searx.webapp"
Write-Host ""
Write-Host "Or just start the launcher - it starts SearXNG automatically."
