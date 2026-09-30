# #937: fills folio-feed\ (the local package source in nuget.config) with the Folio packages the launcher pins.
# It clones Folio, checks out FolioCommit and packs it with Folio's own tools\pack.ps1, then checks that the commit
# packed as FolioVersion. CI runs it before restoring; locally, run it once after changing the pin:
#
#   powershell -File windows-native-launcher\pack-folio.ps1 [-Repo <Folio clone or URL>]
param([string]$Repo = 'https://github.com/Yuuzulight/Folio')
$ErrorActionPreference = 'Stop'
$project = [xml](Get-Content -Raw (Join-Path $PSScriptRoot 'ManaNativeLauncher.csproj'))
$commit = $project.SelectSingleNode('//FolioCommit').InnerText
$version = $project.SelectSingleNode('//FolioVersion').InnerText
$feed = Join-Path $PSScriptRoot 'folio-feed'
$package = Join-Path $feed "Folio.WinForms.$version.nupkg"

# The full history (without file contents) is needed: the version number counts the commits.
$src = Join-Path ([IO.Path]::GetTempPath()) "folio-$commit"
if (Test-Path $src) { Remove-Item -Recurse -Force $src }
git clone --quiet --filter=blob:none $Repo $src
if ($LASTEXITCODE) { exit $LASTEXITCODE }
git -C $src -c advice.detachedHead=false checkout --quiet $commit
if ($LASTEXITCODE) { exit $LASTEXITCODE }

& (Join-Path $src 'tools\pack.ps1') -Output $feed
if ($LASTEXITCODE) { exit $LASTEXITCODE }
Remove-Item -Recurse -Force $src
if (-not (Test-Path $package)) {
    throw "Folio $commit did not pack as $version (see the version above); FolioCommit and FolioVersion must match."
}
