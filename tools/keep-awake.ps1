# Keeps Windows from sleeping for as long as the process with -ParentPid is alive (the gate streak
# uses it so five long runs are not cut short by the PC going to sleep). It changes no setting: the
# request ends when this script ends.
param([Parameter(Mandatory)][int]$ParentPid)
Add-Type -Namespace Keep -Name Awake -MemberDefinition '[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
$ES_CONTINUOUS = [uint32]2147483648
$ES_SYSTEM_REQUIRED = [uint32]1
while (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) {
    [void][Keep.Awake]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)
    Start-Sleep -Seconds 30
}
