<#
PowerShell helper to download a Windows Node.js distribution and place it into repo-root\node-bin
Usage examples (from repo root):
  powershell -ExecutionPolicy Bypass -File .\scripts\fetch_node_bin.ps1 -Version 18.18.0 -Arch x64
  powershell -ExecutionPolicy Bypass -File .\scripts\fetch_node_bin.ps1 -Version 18.18.0 -Arch x86 -Force

Defaults:
 - Version: 18.18.0
 - Arch: x64

This script will:
 - download the node zip from nodejs.org
 - extract it to a temporary folder
 - copy the extracted distribution files into ./node-bin (creating/overwriting as requested)

Note: Verify redistribution rights before distributing installers that bundle Node. Official Node binaries are typically redistributable, but confirm for your distribution.
#>

param(
    [string]$Version = "18.18.0",
    [ValidateSet('x64','x86','arm64')][string]$Arch = 'x64',
    [switch]$Force
)

function Write-Log($msg){ Write-Host "[fetch_node_bin] $msg" }

try{
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
    $repoRoot = Resolve-Path -Path (Join-Path $scriptDir '..')
    $nodeBinDir = Join-Path $repoRoot 'node-bin'

    $fileName = "node-v$Version-win-$Arch.zip"
    $url = "https://nodejs.org/dist/v$Version/$fileName"

    Write-Log "Downloading Node $Version for win-$Arch from: $url"

    $tmpDir = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ([System.Guid]::NewGuid().ToString()))
    $tmpZip = Join-Path $tmpDir.FullName $fileName

    Write-Log "Temporary directory: $($tmpDir.FullName)"

    Invoke-WebRequest -Uri $url -OutFile $tmpZip -UseBasicParsing -ErrorAction Stop
    Write-Log "Downloaded to $tmpZip"

    Write-Log "Extracting archive..."
    Expand-Archive -LiteralPath $tmpZip -DestinationPath $tmpDir.FullName -Force

    # Download SHASUMS256.txt for verification
    $shasumsUrl = "https://nodejs.org/dist/v$Version/SHASUMS256.txt"
    $shasumsFile = Join-Path $tmpDir.FullName 'SHASUMS256.txt'
    try{
        Write-Log "Downloading SHASUMS256 from $shasumsUrl"
        Invoke-WebRequest -Uri $shasumsUrl -OutFile $shasumsFile -UseBasicParsing -ErrorAction Stop
    } catch {
        Write-Log "Warning: Failed to download SHASUMS256.txt: $($_.Exception.Message)"
        $shasumsFile = $null
    }

    $extractedDir = Join-Path $tmpDir.FullName "node-v$Version-win-$Arch"
    if (!(Test-Path $extractedDir)){
        # sometimes the zip may contain files at root; find first folder
        $children = Get-ChildItem -Path $tmpDir.FullName | Where-Object { $_.PSIsContainer }
        if ($children.Count -ge 1){
            $extractedDir = $children[0].FullName
        }
    }

    if (!(Test-Path $extractedDir)){
        throw "Failed to locate extracted Node distribution in $($tmpDir.FullName)"
    }

    # Compute SHA256 of the downloaded zip and compare if possible
    try{
        $sha256 = Get-FileHash -Path $tmpZip -Algorithm SHA256 | Select-Object -ExpandProperty Hash
        Write-Log "Computed SHA256: $sha256"
        if ($shasumsFile){
            $matchLine = Select-String -Path $shasumsFile -Pattern [regex]::Escape($fileName) -SimpleMatch -Quiet
            if ($matchLine){
                $all = Get-Content $shasumsFile | Where-Object { $_ -match [regex]::Escape($fileName) } | Select-Object -First 1
                if ($all){
                    # SHASUMS file format: <hash>  <filename>
                    $parts = $all -split '\s+' | Where-Object { $_ -ne '' }
                    $expected = $parts[0]
                    Write-Log "Expected SHA256 from SHASUMS256.txt: $expected"
                    if ($expected -ne $sha256){
                        Write-Log "WARNING: SHA256 mismatch between downloaded zip and SHASUMS256.txt"
                    } else {
                        Write-Log "SHA256 verified against SHASUMS256.txt"
                    }
                }
            }
        }
    } catch { Write-Log "Warning: SHA256 verification failed: $($_.Exception.Message)" }

    if (Test-Path $nodeBinDir){
        if ($Force){
            Write-Log "Removing existing node-bin directory (force)"
            Remove-Item -Recurse -Force $nodeBinDir
        } else {
            Write-Host "A node-bin directory already exists at: $nodeBinDir"
            $resp = Read-Host "Overwrite existing node-bin? (y/N)"
            if ($resp -ne 'y' -and $resp -ne 'Y'){
                Write-Log "Aborting. Existing node-bin preserved. Use -Force to overwrite."; exit 1
            }
            Remove-Item -Recurse -Force $nodeBinDir
        }
    }

    Write-Log "Copying extracted files into $nodeBinDir"
    New-Item -ItemType Directory -Path $nodeBinDir | Out-Null
    Copy-Item -Path (Join-Path $extractedDir '*') -Destination $nodeBinDir -Recurse -Force

    # Ensure node.exe exists at top-level for Windows
    $nodeExe = Join-Path $nodeBinDir 'node.exe'
    if (!(Test-Path $nodeExe)){
        # Try to locate a node executable inside extracted structure and copy it to node-bin root
        $found = Get-ChildItem -Path $nodeBinDir -Filter 'node.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found){ Copy-Item -Path $found.FullName -Destination $nodeExe -Force }
    }

    if (Test-Path $nodeExe){
        Write-Log "Bundled node executable is available at: $nodeExe"
    } else {
        Write-Log "Warning: node.exe not found in node-bin. You may need to adjust placement depending on distribution contents."
    }

    # Save checksum to node-bin/CHECKSUMS.txt
    try{
        $checksumFile = Join-Path $nodeBinDir 'CHECKSUMS.txt'
        "SHA256 $fileName $sha256" | Out-File -FilePath $checksumFile -Encoding UTF8
        Write-Log "Saved checksum to $checksumFile"
    } catch {}

    Write-Host "\nDone. node-bin prepared at: $nodeBinDir"
    Write-Host "You can now run: cd desktop-client; npm ci; npm run dist"

} catch {
    Write-Error "Error: $($_.Exception.Message)"
    exit 1
} finally {
    # cleanup temp zip (optionally keep?)
    # Remove-Item -Recurse -Force $tmpDir
}
