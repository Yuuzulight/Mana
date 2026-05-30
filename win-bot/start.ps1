# start.ps1 - native Windows start script for the voice bot
# Put this file in C:\ManaAI\Mana\win-bot

Set-StrictMode -Version Latest
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$venv = Join-Path $here "venv"

# Find a python executable: prefer 'python' then 'py'
$pycmd = if (Get-Command python -ErrorAction SilentlyContinue) { 'python' } elseif (Get-Command py -ErrorAction SilentlyContinue) { 'py' } else { $null }
if (-not $pycmd) {
    Write-Error "Python not found in PATH and py launcher not found. Please install Python 3.10+ and ensure 'python' or 'py' is available."
    exit 1
}
$pyArgs = ''
if ($pycmd -eq 'py') { $pyArgs = '-3' }

Write-Output "Using python runner: $pycmd $pyArgs"

if (-not (Test-Path $venv)) {
    Write-Output "Creating virtualenv at $venv"
    & $pycmd $pyArgs -m venv $venv
}

# Activate the venv for this script
$activate = Join-Path $venv "Scripts\Activate.ps1"
. $activate

Write-Output "Upgrading pip and installing requirements..."
& $pycmd $pyArgs -m pip install --upgrade pip
& $pycmd $pyArgs -m pip install -r (Join-Path $here "..\wsl-bot\requirements.txt")

# Start text-generation-webui if present (adjust command to your webui version)
$webui_dir = Join-Path $here "..\wsl-bot\text-generation-webui"
if (Test-Path $webui_dir) {
    Write-Output "Found text-generation-webui at $webui_dir. Starting it..."
    if ($pyArgs -and $pyArgs.Trim() -ne '') {
        $webuiArgs = @($pyArgs, 'server.py', '--listen', '--port', '7860')
    } else {
        $webuiArgs = @('server.py', '--listen', '--port', '7860')
    }
    Start-Process -FilePath $pycmd -ArgumentList $webuiArgs -WorkingDirectory $webui_dir -NoNewWindow
    Start-Sleep -Seconds 3
} else {
    Write-Output "text-generation-webui not found in $webui_dir"
    Write-Output "Clone https://github.com/oobabooga/text-generation-webui into $webui_dir and place your GGUF model under models\\"
}

# Start voice_bridge (FastAPI)
Write-Output "Starting voice_bridge (FastAPI) on port 5005"
if ($pyArgs -and $pyArgs.Trim() -ne '') {
    $voiceArgs = @($pyArgs, '..\wsl-bot\voice_bridge.py')
} else {
    $voiceArgs = @('..\wsl-bot\voice_bridge.py')
}
Start-Process -FilePath $pycmd -ArgumentList $voiceArgs -WorkingDirectory $here -NoNewWindow

Write-Output "Started services. Web UI (if available) at http://localhost:7860"
Write-Output "Voice bridge available at http://localhost:5005 (endpoints: /transcribe, /synthesize)"

Write-Output "Logs: voice_bridge will print to the console window started by this script. To run interactively, open PowerShell and run this script without Start-Process calls."
