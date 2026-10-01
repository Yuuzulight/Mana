# Closes a running Mana the same way the tray's "Exit Mana" does: every
# service she started is stopped cleanly, then the launcher exits.
#
#   powershell -File windows-native-launcher\quit-mana.ps1
$signal = $null
if ([Threading.EventWaitHandle]::TryOpenExisting('Local\Mana.NativeLauncher.Quit', [ref]$signal)) {
    [void]$signal.Set()
    $signal.Dispose()
    'Asked Mana to close.'
} else {
    'Mana is not running (or her launcher is older than the quit signal).'
}
