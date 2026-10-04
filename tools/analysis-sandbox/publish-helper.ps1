param([int]$WaitSeconds = 1800, [switch]$RecoverGateOnly)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PSScriptRoot)
$bundle = Join-Path $root 'bundle'
$stage = Join-Path $root ("bundle.staging." + [guid]::NewGuid().ToString('N'))
$previous = Join-Path $root ("bundle.previous." + [guid]::NewGuid().ToString('N'))
$gate = Join-Path $root 'helper-launch.lock'
$owned = $false
$mutexName = 'Local\Mana.HelperPublish.' + ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant())))).Replace('-', '')
$mutex = New-Object Threading.Mutex($false, $mutexName)
$mutexOwned = $false

function Assert-OwnedPath([string]$target) {
    $resolved = [IO.Path]::GetFullPath($target)
    if (-not $resolved.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid helper deployment path' }
}
function Remove-Owned([string]$target) {
    Assert-OwnedPath $target
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
}

try {
    try { $mutexOwned = $mutex.WaitOne([TimeSpan]::FromSeconds($WaitSeconds)) }
    catch [Threading.AbandonedMutexException] { $mutexOwned = $true }
    if (-not $mutexOwned) { throw 'Timed out waiting for another helper publisher.' }
    if (-not $RecoverGateOnly) {
        dotnet publish (Join-Path $root 'Mana.AnalysisSandbox.csproj') -c Release -r win-x64 --self-contained true -o $stage -v q --disable-build-servers -p:UseSharedCompilation=false
        if ($LASTEXITCODE) { throw 'Native helper staging build failed; installed helper is unchanged.' }
        [IO.File]::WriteAllText((Join-Path $stage '.gitkeep'), "`n")
    }
    $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
    while (-not $owned) {
        try {
            New-Item -ItemType Directory -Path $gate -ErrorAction Stop | Out-Null
            $owned = $true
            [IO.File]::WriteAllText((Join-Path $gate 'owner'), [string]$PID)
        } catch {
            if (-not (Test-Path -LiteralPath $gate)) { throw }
            $ownerPath = Join-Path $gate 'owner'
            if (Test-Path -LiteralPath $ownerPath) {
                $ownerId = 0
                $ownerText = [IO.File]::ReadAllText($ownerPath).Trim()
                if ($ownerText -and (-not [int]::TryParse($ownerText, [ref]$ownerId) -or $ownerId -le 0)) { throw 'Invalid helper launch gate' }
                if ($ownerId -gt 0 -and -not (Get-Process -Id $ownerId -ErrorAction SilentlyContinue)) {
                    Remove-Owned $gate
                }
            }
            if ([DateTime]::UtcNow -gt $deadline) { throw 'Timed out waiting for the helper deployment gate; installed helper is unchanged.' }
            Start-Sleep -Milliseconds 100
        }
    }
    if ($RecoverGateOnly) { return }
    $executable = Join-Path $bundle 'Mana.AnalysisSandbox.exe'
    while (Get-CimInstance Win32_Process -Filter "Name = 'Mana.AnalysisSandbox.exe'" | Where-Object { $_.ExecutablePath -eq $executable }) {
        if ([DateTime]::UtcNow -gt $deadline) { throw 'Timed out waiting for active sandbox scripts; installed helper is unchanged.' }
        Start-Sleep -Milliseconds 250
    }
    Assert-OwnedPath $bundle
    Assert-OwnedPath $stage
    Assert-OwnedPath $previous
    if (Test-Path -LiteralPath $bundle) { Move-Item -LiteralPath $bundle -Destination $previous }
    try { Move-Item -LiteralPath $stage -Destination $bundle }
    catch {
        if (Test-Path -LiteralPath $previous) { Move-Item -LiteralPath $previous -Destination $bundle }
        throw
    }
    Remove-Owned $previous
} finally {
    if ($owned) { Remove-Owned $gate }
    Remove-Owned $stage
    if ($mutexOwned) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
