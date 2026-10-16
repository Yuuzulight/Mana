[CmdletBinding()]
param([string]$Repo, [string]$Destination)
$ErrorActionPreference = 'Stop'
$pin = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'arcana.lock.json') -Raw | ConvertFrom-Json
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
    $enginePin = Get-Content -LiteralPath (Join-Path $source 'engine.lock.json') -Raw | ConvertFrom-Json
    if ($enginePin.version -ne $pin.engineVersion) { throw 'Arcana engine version disagrees with the Mana pin.' }
    & dotnet publish (Join-Path $source 'src\Arcana.Cli\Arcana.Cli.csproj') --configuration Release --output $Destination
    if ($LASTEXITCODE -ne 0) { throw 'Arcana publish failed. Close any running Arcana session before retrying.' }
    & (Join-Path $source 'tools\fetch-engine.ps1') -Destination (Join-Path $Destination 'engines\obscura\current')
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
