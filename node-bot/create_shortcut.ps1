<#
Create a convenient Windows shortcut (.lnk) that launches the Mana startup PowerShell script.
This script creates two shortcuts:
 - Desktop: "Start Mana.lnk" (for quick access)
 - Repo folder: "Start Mana.lnk" (so the .lnk lives inside the repository)

Usage (from node-bot folder):
  powershell -ExecutionPolicy Bypass -File .\create_shortcut.ps1
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Push-Location $scriptDir

$wsh = New-Object -ComObject WScript.Shell

$powerShellExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$startScript = Join-Path $scriptDir 'start_mana.ps1'

if (-not (Test-Path $startScript)) {
    Write-Error "start_mana.ps1 not found at $startScript. Please ensure the file exists before creating shortcuts."
    Pop-Location
    exit 2
}

$arguments = "-ExecutionPolicy Bypass -File `"$startScript`""

# Helper to create a shortcut
function New-Shortcut($path, $target, $argString, $workingDir) {
    $sc = $wsh.CreateShortcut($path)
    $sc.TargetPath = $target
    $sc.Arguments = $argString
    $sc.WorkingDirectory = $workingDir
    $sc.IconLocation = "$target,0"
    $sc.Save()
    Write-Host "Created shortcut: $path"
}

# Desktop shortcut
$desktop = [Environment]::GetFolderPath('Desktop')
$desktopShortcut = Join-Path $desktop 'Start Mana.lnk'
New-Shortcut -path $desktopShortcut -target $powerShellExe -argString $arguments -workingDir $scriptDir

# Repo folder shortcut (node-bot folder)
$repoShortcut = Join-Path $scriptDir 'Start Mana.lnk'
New-Shortcut -path $repoShortcut -target $powerShellExe -argString $arguments -workingDir $scriptDir

Write-Host "Shortcuts created. You can now double-click the .lnk to start Mana (retriever + node)."
Pop-Location
