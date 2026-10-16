# Registers (or removes) the Windows scheduled task that runs tools/arcana-soak.js, so Arcana's
# week of use needs nobody at the keyboard. The task survives restarts, catches up on a run it
# missed while the PC was off, never overlaps itself, runs at below-normal priority with no window,
# and (the script itself) skips a run while a game is open or RAM is high.
[CmdletBinding()]
param(
    [int]$EveryHours = 4,
    [int]$Days = 7,
    [string]$TaskName = 'Mana Arcana soak',
    [switch]$Remove
)
$ErrorActionPreference = 'Stop'
if ($Remove) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed '$TaskName'."
    return
}
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$node = (Get-Command node -ErrorAction Stop).Source
$soak = Join-Path $repo 'tools\arcana-soak.js'
if (-not (Test-Path -LiteralPath $soak)) { throw "Not found: $soak" }
$command = "`$p = Start-Process -FilePath '$node' -ArgumentList '`"$soak`"' -WorkingDirectory '$repo' -WindowStyle Hidden -PassThru; `$p.PriorityClass = 'BelowNormal'; `$p.WaitForExit()"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -Command `"$command`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Hours $EveryHours) -RepetitionDuration (New-TimeSpan -Days $Days)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Registered '$TaskName': every $EveryHours hours for $Days days, first run in about a minute."
Write-Host "Report: node `"$soak`" --report   (also written to node-bot\data\arcana-soak\report.md after every run)"
