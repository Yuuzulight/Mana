[CmdletBinding()]
param(
    [string]$Repo,
    [string]$Destination,
    [string]$FolioRepo = 'https://github.com/Yuuzulight/Folio.git'
)
$ErrorActionPreference = 'Stop'
$pin = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'arcana.lock.json') -Raw | ConvertFrom-Json
if ($pin.engineVersion -cnotmatch '^folio-([0-9a-f]{40})$') {
    throw 'The Arcana install requires a pinned Folio revision.'
}
$folioCommit = $Matches[1]
if ([string]::IsNullOrWhiteSpace($Repo)) { $Repo = $pin.repository }
if ([string]::IsNullOrWhiteSpace($Destination)) { $Destination = Join-Path $PSScriptRoot '..\node-bot\runtime\arcana' }
$Destination = [IO.Path]::GetFullPath($Destination)
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$source = [IO.Path]::GetFullPath((Join-Path $temporaryRoot ('mana-arcana-install-' + [guid]::NewGuid().ToString('N'))))
try {
    & git clone --quiet --filter=blob:none --no-checkout $Repo $source
    if ($LASTEXITCODE -ne 0) { throw 'Could not clone Arcana.' }
    & git -C $source -c advice.detachedHead=false checkout --quiet $pin.commit
    if ($LASTEXITCODE -ne 0) { throw 'Could not check out the pinned Arcana commit.' }
    $folioSource = Join-Path $source 'folio-source'
    & git clone --quiet --no-checkout $FolioRepo $folioSource
    if ($LASTEXITCODE -ne 0) { throw 'Could not clone Folio.' }
    & git -C $folioSource -c advice.detachedHead=false checkout --quiet $folioCommit
    if ($LASTEXITCODE -ne 0) { throw "Could not check out the pinned Folio commit $folioCommit." }
    & dotnet publish (Join-Path $source 'src\Arcana.Cli\Arcana.Cli.csproj') --configuration Release -p:ArcanaFolioOnly=true --output $Destination
    if ($LASTEXITCODE -ne 0) { throw 'Arcana publish failed. Close any running Arcana session before retrying.' }
    $folioDestination = Join-Path $Destination 'engines\folio\current'
    & (Join-Path $folioSource 'tools\publish-content-host.ps1') -Destination $folioDestination -Runtime win-x64
    $manifest = Get-Content -LiteralPath (Join-Path $folioDestination 'native-build.json') -Raw | ConvertFrom-Json
    $brokerHash = (Get-FileHash -LiteralPath (Join-Path $folioDestination 'Folio.ContentHost.exe')).Hash.ToLowerInvariant()
    if ($manifest.sourceCommit -cne $folioCommit -or $manifest.sourceDirty -ne $false -or $manifest.executableSha256 -cne $brokerHash) {
        throw 'The installed Folio broker did not match the pinned source and build manifest.'
    }
    Copy-Item -LiteralPath (Join-Path $source 'NOTICE') -Destination (Join-Path $Destination 'NOTICE')
    Copy-Item -LiteralPath (Join-Path $source 'LICENSE') -Destination (Join-Path $Destination 'LICENSE')
    $pin | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Destination 'arcana-install.json')
    Write-Host "Arcana $($pin.commit) installed at $Destination"
} finally {
    # Only the unique checkout created above is eligible for recursive cleanup.
    $resolvedSource = [IO.Path]::GetFullPath($source)
    $expectedPrefix = (Join-Path $temporaryRoot 'mana-arcana-install-')
    if (!$resolvedSource.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup outside the installer temporary directory.' }
    if (Test-Path -LiteralPath $resolvedSource) { Remove-Item -LiteralPath $resolvedSource -Recurse -Force }
}
