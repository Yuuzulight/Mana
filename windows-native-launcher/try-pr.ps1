# #1010: runs a PR as the live Mana, or goes back to main. The live
# checkout moves to the PR's head (detached; only when no tracked file is
# modified), then update-mana.ps1 (#995) applies it: the backend restarts,
# or a new launcher build goes through the staging slot with its
# self-check and rollback. bin\trying-pr holds the PR number while one
# runs. Also the tray's "Try a PR..." and "Back to main". Log: bin\try-pr.log.
# A PR branched before this script existed doesn't have it, so it keeps a
# copy in bin\ (ignored by git) for Back to main to run from.
#
#   powershell -File windows-native-launcher\try-pr.ps1 -Pr 1020
#   powershell -File windows-native-launcher\try-pr.ps1 -Main
param(
    [int]$Pr,
    [switch]$Main,
    # The running launcher's folder, passed on to update-mana.ps1.
    [string]$LiveDir
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((git -C $PSScriptRoot rev-parse --show-toplevel))
$launcherDir = Join-Path $root 'windows-native-launcher'
$marker = Join-Path $launcherDir 'bin\trying-pr'
$copy = Join-Path $launcherDir 'bin\try-pr.ps1'
New-Item -ItemType Directory -Force (Join-Path $launcherDir 'bin') | Out-Null
if ($PSCommandPath -ne $copy) { Copy-Item $PSCommandPath $copy -Force }
Start-Transcript -Path (Join-Path $launcherDir 'bin\try-pr.log') | Out-Null

function Invoke-Git {
    $output = git -C $root @args
    if ($LASTEXITCODE) { throw "git $args failed" }
    $output
}

try {
    if (-not $Main -and $Pr -le 0) { throw 'Give -Pr <number> or -Main.' }
    # My own edits in the live checkout are never moved or lost.
    if (Invoke-Git status --porcelain --untracked-files=no) { throw "$root has changes to tracked files; not switching." }

    $update = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $launcherDir 'update-mana.ps1'), '-Now')
    if ($LiveDir) { $update += @('-LiveDir', $LiveDir) }
    if ($Main) {
        Invoke-Git checkout main
        Remove-Item $marker -ErrorAction SilentlyContinue
        "Back on main."
    } else {
        Invoke-Git fetch origin "pull/$Pr/head"
        Invoke-Git checkout --detach FETCH_HEAD
        Set-Content $marker $Pr
        $update += '-NoPull'
        "Trying PR #$Pr at $(Invoke-Git rev-parse --short HEAD)."
    }
    # Its own process: its transcript and exit code stay its own.
    & powershell.exe @update
    if ($LASTEXITCODE) { throw 'update-mana.ps1 failed; see bin\update.log.' }
} catch {
    Write-Output "Try PR failed: $_"
    Stop-Transcript | Out-Null
    exit 1
}
Stop-Transcript | Out-Null
