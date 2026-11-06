# Prepare the complete SDK graph and standalone script host from the exact Folio pin.
param(
    [string]$Repo = 'https://github.com/Yuuzulight/Folio',
    [ValidateSet('win-x64', 'win-arm64')][string]$Runtime = 'win-x64'
)
$ErrorActionPreference = 'Stop'
$project = [xml](Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'ManaNativeLauncher.csproj'))
$commit = $project.SelectSingleNode('//FolioCommit').InnerText
$version = $project.SelectSingleNode('//FolioVersion').InnerText
if ($commit -notmatch '^[0-9a-f]{40}$') { throw 'FolioCommit must be a complete Git commit hash.' }
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$') { throw 'FolioVersion is not a supported NuGet version.' }
$feed = Join-Path $PSScriptRoot 'folio-feed'
$hostDirectory = Join-Path $feed "content-host/$commit/$Runtime"
$cacheRoot = Join-Path $PSScriptRoot '.folio-build'
$source = Join-Path $cacheRoot $commit
New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $source)) {
    git clone --quiet --filter=blob:none $Repo $source
    if ($LASTEXITCODE) { throw "Folio clone failed; the incomplete cache is preserved for inspection at $source" }
}
if (-not (Test-Path -LiteralPath (Join-Path $source '.git'))) { throw "The Folio build cache is not a Git checkout: $source" }
if (git -C $source status --porcelain --untracked-files=all) { throw 'The Folio source cache contains changes; refusing to overwrite them.' }
git -C $source -c advice.detachedHead=false checkout --quiet $commit
if ($LASTEXITCODE) { throw 'The pinned Folio commit could not be checked out.' }
if ((git -C $source rev-parse HEAD).Trim() -ne $commit) { throw 'Folio checkout does not match its pin.' }

# Its global.json selects the compiler. Keep verified source/intermediates for incremental builds;
# this ignored directory is never part of the launcher publish.
Push-Location -LiteralPath $source
try {
    & (Join-Path $source 'tools/pack.ps1') -Output $feed -Version $version
    if ($LASTEXITCODE) { throw 'Folio package creation failed.' }
    & (Join-Path $source 'tools/publish-content-host.ps1') -Destination $hostDirectory -Runtime $Runtime
    if ($LASTEXITCODE) { throw 'Folio native host creation failed.' }
} finally { Pop-Location }
foreach ($package in 'Folio', 'Folio.Diagrams', 'Folio.Scripting', 'Folio.WinForms') {
    if (-not (Test-Path -LiteralPath (Join-Path $feed "$package.$version.nupkg"))) { throw "Missing production package: $package $version" }
}
$manifest = Get-Content -LiteralPath (Join-Path $hostDirectory 'native-build.json') -Raw | ConvertFrom-Json
if ($manifest.sourceCommit -ne $commit -or $manifest.sourceDirty -ne $false -or $manifest.runtime -ne $Runtime) {
    throw 'The native host provenance does not match the clean Folio pin and requested architecture.'
}
if ((Get-FileHash -LiteralPath (Join-Path $hostDirectory 'Folio.ContentHost.exe') -Algorithm SHA256).Hash -ne $manifest.executableSha256) {
    throw 'The native host executable does not match its manifest.'
}
Write-Host "Prepared Folio $version at $commit, with standalone $Runtime host: $hostDirectory"
