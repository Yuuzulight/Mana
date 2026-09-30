# #995: updates a running Mana without closing her. Pulls main, installs
# node-bot's packages and packs Folio when those changed, builds the
# launcher into a staging folder beside the running one when it changed,
# then tells the running launcher: -Now applies it straight away,
# otherwise at a quiet moment. With no new launcher build only the backend
# restarts. Also the tray's "Update now". Log: bin\update.log.
#
#   powershell -File windows-native-launcher\update-mana.ps1 [-Now] [-NoPull]
param(
    [switch]$Now,
    # Already pulled by hand: just build and apply.
    [switch]$NoPull,
    # The running launcher's folder; found from the running process, else bin\Release\<tfm>.
    [string]$LiveDir
)

$ErrorActionPreference = 'Stop'
$launcherDir = $PSScriptRoot
$root = Split-Path $launcherDir
New-Item -ItemType Directory -Force (Join-Path $launcherDir 'bin') | Out-Null
Start-Transcript -Path (Join-Path $launcherDir 'bin\update.log') | Out-Null

function Invoke-Git {
    $output = git -C $root @args
    if ($LASTEXITCODE) { throw "git $args failed" }
    $output
}

# True when $path was written after $than (or $than doesn't exist).
function Test-Newer($path, $than) {
    -not (Test-Path $than) -or (Get-Item $path).LastWriteTimeUtc -gt (Get-Item $than).LastWriteTimeUtc
}

try {
    if (-not $LiveDir) {
        $running = Get-Process ManaNativeLauncher -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($running) {
            $LiveDir = Split-Path $running.Path
        } else {
            $tfm = ([xml](Get-Content (Join-Path $launcherDir 'ManaNativeLauncher.csproj'))).Project.PropertyGroup.TargetFramework | Where-Object { $_ } | Select-Object -First 1
            $LiveDir = Join-Path $launcherDir "bin\Release\$tfm"
        }
    }
    $staging = "$LiveDir.staging"

    if (-not $NoPull) {
        $branch = Invoke-Git rev-parse --abbrev-ref HEAD
        if ($branch -ne 'main') { throw "$root is on $branch, not main; not pulling." }
        Invoke-Git pull --ff-only origin main
    }
    $head = Invoke-Git rev-parse HEAD

    $nodeBot = Join-Path $root 'node-bot'
    if (Test-Newer (Join-Path $nodeBot 'package-lock.json') (Join-Path $nodeBot 'node_modules\.package-lock.json')) {
        npm install --prefix $nodeBot --no-audit --no-fund
        if ($LASTEXITCODE) { throw 'npm install failed' }
    }

    # pack-folio.ps1 arrives with #946; the pin lives in the csproj.
    $packFolio = Join-Path $launcherDir 'pack-folio.ps1'
    if ((Test-Path $packFolio) -and (Test-Newer (Join-Path $launcherDir 'ManaNativeLauncher.csproj') (Join-Path $launcherDir 'folio-feed'))) {
        & $packFolio
    }

    # The commit each build was made from, so a pull done by hand is caught too.
    $built = Get-Content (Join-Path $LiveDir 'build-commit') -ErrorAction SilentlyContinue
    $staged = if (Test-Path (Join-Path $staging 'update-ready')) { Get-Content (Join-Path $staging 'build-commit') -ErrorAction SilentlyContinue }
    $launcherChanged = -not $built -or [bool](Invoke-Git diff --name-only $built $head -- windows-native-launcher)
    if ($launcherChanged -and $staged -ne $head) {
        if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
        dotnet build (Join-Path $launcherDir 'ManaNativeLauncher.csproj') -c Release -o $staging -v q -nologo
        $buildFailed = $LASTEXITCODE
        dotnet build-server shutdown | Out-Null
        if ($buildFailed) { throw 'The launcher build failed; nothing was staged.' }
        Set-Content (Join-Path $staging 'build-commit') $head
        Set-Content (Join-Path $staging 'update-ready') ''
        "Staged the launcher build of $head in $staging."
    }

    $name = if ($Now) { 'Local\Mana.NativeLauncher.UpdateNow' } else { 'Local\Mana.NativeLauncher.Update' }
    $signal = $null
    if ([Threading.EventWaitHandle]::TryOpenExisting($name, [ref]$signal)) {
        [void]$signal.Set()
        $signal.Dispose()
        'Told the running launcher to apply it.'
    } else {
        'Mana is not running; she picks this up when she next starts.'
    }
} catch {
    Write-Output "Update failed: $_"
    Stop-Transcript | Out-Null
    exit 1
}
Stop-Transcript | Out-Null
