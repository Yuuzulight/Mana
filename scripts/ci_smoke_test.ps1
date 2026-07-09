<#
Simple CI smoke test script to run after installer is downloaded in CI.
Usage: powershell -ExecutionPolicy Bypass -File .\scripts\ci_smoke_test.ps1 -InstallerPath .\installer.exe
#>
param(
    [string]$InstallerPath
)

function Write-Log($m){ Write-Host "[smoke-test] $m" }

if (-not $InstallerPath){ Write-Error "InstallerPath is required. Example: .\installer-artifacts\Mana-Setup.exe"; exit 2 }
if (-not (Test-Path $InstallerPath)){ Write-Error "Installer not found at $InstallerPath"; exit 3 }

try{
    Write-Log "Starting installer: $InstallerPath"
    Start-Process -FilePath $InstallerPath -ArgumentList "/S" -Wait
    Write-Log "Installer finished"

    # Try to locate installed exe
    Start-Sleep -Seconds 2
    $installed = Get-ChildItem -Path $env:LOCALAPPDATA\Programs -Recurse -Filter Mana.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $installed){ Write-Error "Installed exe not found in LocalAppData\Programs"; exit 4 }
    Write-Log "Found installed exe: $($installed.FullName)"

    # Start the app and wait for health endpoint
    $proc = Start-Process -FilePath $installed.FullName -PassThru
    Write-Log "Started process id $($proc.Id)"

    $ok = $false
    for ($i=0; $i -lt 60; $i++){
        Start-Sleep -Seconds 5
        try{
            $res = Invoke-RestMethod -Uri 'http://127.0.0.1:5005/health' -Method GET -TimeoutSec 3
            if ($res){ $ok = $true; break }
        } catch {}
    }
    if (-not $ok){ Write-Error "Health check failed (timeout)"; Stop-Process -Id $proc.Id -Force; exit 5 }
    Write-Log "Health OK"

    Stop-Process -Id $proc.Id -Force
    Write-Log "Smoke test passed"
    exit 0
} catch {
    Write-Error "Smoke test failed: $($_.Exception.Message)"
    exit 10
}
