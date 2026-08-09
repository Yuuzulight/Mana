# Removes the ManaNodeBot Windows service installed by
# install-mana-service.ps1. Does not uninstall NSSM itself (it's a
# general-purpose tool Chocolatey manages; leaving it in place is harmless
# and useful if you ever want the service back). Requires an elevated
# (Administrator) PowerShell session, same as install.

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Error "This script must be run from an elevated (Administrator) PowerShell session."
    exit 1
}

$ServiceName = "ManaNodeBot"

if (Get-Command nssm -ErrorAction SilentlyContinue) {
    nssm stop $ServiceName
    nssm remove $ServiceName confirm
    Write-Host "Service '$ServiceName' removed. Remember to point windows-launcher's Settings > Connection back to http://localhost:5005 so it resumes spawning node-bot itself."
} else {
    Write-Host "NSSM isn't on PATH -- nothing to remove, or it was never installed."
}
