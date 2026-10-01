# Closes a running Mana the same way the tray's "Exit Mana" does: every
# service she started is stopped cleanly, then the launcher exits. Returns
# once she's gone, so a Mana started straight after isn't turned away by
# the one still closing (SingleInstance).
#
#   powershell -File windows-native-launcher\quit-mana.ps1
param(
    # SingleInstance's name; tests pass their own.
    [string]$Name = 'Mana.NativeLauncher',
    [int]$TimeoutSeconds = 120
)
$signal = $null
if (-not [Threading.EventWaitHandle]::TryOpenExisting("Local\$Name.Quit", [ref]$signal)) {
    'Mana is not running (or her launcher is older than the quit signal).'
    exit 0
}
[void]$signal.Set()
$signal.Dispose()

# Her single-instance mutex goes when the launcher exits.
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$mutex = $null
while ([Threading.Mutex]::TryOpenExisting("Local\$Name", [ref]$mutex)) {
    $mutex.Dispose()
    if ((Get-Date) -gt $deadline) {
        "Asked Mana to close, but she's still closing after $TimeoutSeconds s."
        exit 1
    }
    Start-Sleep -Milliseconds 250
}
'Mana has closed.'
