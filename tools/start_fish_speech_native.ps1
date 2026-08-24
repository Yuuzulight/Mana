# Starts Mana's S1-mini TTS server natively on Windows -- no WSL required.
#
# Supersedes start_fish_speech_wsl.sh: native Windows torch.compile now works
# via the triton-windows package plus one inductor config fix (see
# fish_speech_native_server.py and docs/fish_speech_tts.md for how these were
# found and why they're needed), and measures consistently faster than the
# WSL path on the same GPU besides.
#
# Safe to re-run: skips starting a new server if one is already responding.
#
# Usage:
#   cd D:\Mana\tools
#   .\start_fish_speech_native.ps1

Set-StrictMode -Version Latest

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$fishDir = Join-Path $here "fish-speech"
$venvPython = Join-Path $fishDir ".venv-native\Scripts\python.exe"
$serverScript = Join-Path $here "fish_speech_native_server.py"
$healthUrl = "http://127.0.0.1:8080/v1/health"

function Test-Health {
    try {
        $resp = Invoke-WebRequest -Uri $healthUrl -TimeoutSec 3 -UseBasicParsing
        return $resp.StatusCode -eq 200
    } catch {
        return $false
    }
}

if (Test-Health) {
    Write-Host "Fish Speech (S1-mini) already running on http://127.0.0.1:8080"
    exit 0
}

if (-not (Test-Path $venvPython)) {
    Write-Warning "Native fish-speech venv not found at $venvPython. See docs/fish_speech_tts.md for setup."
    exit 1
}

# The checkpoint loads via mmap, which stages through host RAM regardless of
# its eventual GPU destination -- a low-RAM machine can crash here, not just
# run slowly. This is a warning, not a hard block: it has been observed to
# still work with less headroom than this, just with more risk.
$freeRamGB = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB, 1)
if ($freeRamGB -lt 6) {
    Write-Warning "Only ${freeRamGB}GB RAM free -- loading the checkpoint (~3.6GB, mmap'd through host RAM) may be tight. Consider closing other apps first."
}

Write-Host "Starting Fish Speech (S1-mini) natively -- first start compiles (~1-4 min one-time trace, faster once the inductor cache is warm)..."
Start-Process -FilePath $venvPython -ArgumentList "`"$serverScript`"" -WorkingDirectory $fishDir `
    -RedirectStandardOutput (Join-Path $fishDir "native_server.out.log") `
    -RedirectStandardError (Join-Path $fishDir "native_server.err.log") `
    -WindowStyle Hidden

Write-Host "Waiting for the server to come up (up to 6 minutes for a cold compile trace)..."
$deadline = (Get-Date).AddMinutes(6)
do {
    Start-Sleep -Seconds 5
    $ready = Test-Health
} while (-not $ready -and (Get-Date) -lt $deadline)

if ($ready) {
    Write-Host "Fish Speech (S1-mini) is up at http://127.0.0.1:8080"
} else {
    Write-Warning "Not responding yet after 6 minutes -- check tools\fish-speech\native_server.err.log"
}
