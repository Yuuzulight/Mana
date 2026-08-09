# One-shot health summary for the ManaNodeBot Windows service (see
# install-mana-service.ps1 / README.md) -- Get-Service status, /health, and
# a per-check /doctor summary, without opening either Electron app. Safe to
# run without elevation (only reads service status, no start/stop/install).
#
# Exit code: 0 if the service is running, /health responds, and no /doctor
# check reports "fail" (a "warn" alone doesn't fail the script). Non-zero
# otherwise -- usable in a scheduled task or script, not just interactively.

param(
    [string]$BaseUrl = "http://127.0.0.1:5005"
)

$BaseUrl = $BaseUrl.TrimEnd("/")
$ServiceName = "ManaNodeBot"
$exitCode = 0

Write-Host "Service: $ServiceName"
$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $service) {
    Write-Host "  NOT INSTALLED -- see node-bot\service\install-mana-service.ps1"
    $exitCode = 1
} else {
    Write-Host "  Status: $($service.Status)  StartType: $($service.StartType)"
    if ($service.Status -ne "Running") {
        $exitCode = 1
    }
}

Write-Host ""
Write-Host "Health: $BaseUrl/health"
try {
    $health = Invoke-RestMethod -Uri "$BaseUrl/health" -TimeoutSec 5
    Write-Host "  OK"
} catch {
    Write-Host "  UNREACHABLE: $($_.Exception.Message)"
    $exitCode = 1
}

Write-Host ""
Write-Host "Doctor: $BaseUrl/doctor"
try {
    $doctor = try {
        Invoke-RestMethod -Uri "$BaseUrl/doctor" -TimeoutSec 15
    } catch {
        # /doctor intentionally returns 503 (not 200) when any check fails --
        # Invoke-RestMethod throws on that. ErrorDetails.Message is the usual
        # way to recover a REST error body, but it didn't reliably contain
        # the response here (confirmed against a real 503 response on this
        # PowerShell version) -- reading the response stream directly does.
        $response = $_.Exception.Response
        if ($response) {
            $stream = $response.GetResponseStream()
            $reader = New-Object System.IO.StreamReader($stream)
            $reader.ReadToEnd() | ConvertFrom-Json
        } else {
            throw
        }
    }
    foreach ($check in $doctor.checks) {
        Write-Host "  [$($check.status.ToUpper())] $($check.label): $($check.message)"
        if ($check.status -eq "fail") {
            $exitCode = 1
        }
    }
    Write-Host ""
    Write-Host "  $($doctor.summary.pass) pass, $($doctor.summary.warn) warn, $($doctor.summary.fail) fail"
} catch {
    Write-Host "  UNREACHABLE: $($_.Exception.Message)"
    $exitCode = 1
}

exit $exitCode
