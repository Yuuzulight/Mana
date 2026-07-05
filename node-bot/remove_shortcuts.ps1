<#
Remove the "Start Mana.lnk" shortcuts created by create_shortcut.ps1.
This script will move the shortcuts to a timestamped backup folder inside the repo instead of permanently deleting them, so you can restore if needed.

Usage (from node-bot folder):
  powershell -ExecutionPolicy Bypass -File .\remove_shortcuts.ps1
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Push-Location $scriptDir

$desktop = [Environment]::GetFolderPath('Desktop')
$desktopShortcut = Join-Path $desktop 'Start Mana.lnk'
$repoShortcut = Join-Path $scriptDir 'Start Mana.lnk'

$backupDir = Join-Path $scriptDir ("shortcut-backup-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

function Move-ToBackup($path) {
    if (Test-Path $path) {
        try {
            $dest = Join-Path $backupDir ([IO.Path]::GetFileName($path))
            Move-Item -Path $path -Destination $dest -Force
            Write-Host "Moved $path -> $dest"
        } catch {
            Write-Warning "Failed to move $path: $($_.Exception.Message)"
        }
    } else {
        Write-Host "Not found: $path"
    }
}

Write-Host "Backing up and removing Mana shortcuts to: $backupDir"
Move-ToBackup -path $desktopShortcut
Move-ToBackup -path $repoShortcut

Write-Host "Done. If you want to permanently delete the backups, remove the folder: $backupDir"

Pop-Location
