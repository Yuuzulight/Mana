param(
  [Parameter(Mandatory = $true)]
  [string]$Source,

  [string]$OutputDir = "windows-launcher/assets/avatar"
)

Add-Type -AssemblyName System.Drawing

$sourcePath = Resolve-Path -LiteralPath $Source
$outputPath = Join-Path (Resolve-Path -LiteralPath $OutputDir) "."

$image = [System.Drawing.Bitmap]::new($sourcePath)

try {
  # Coordinates are tuned for the provided 790x499 reference sheet.
  # Left image is speaking. Right image is inactive.
  $speakingRect = [System.Drawing.Rectangle]::new(54, 126, 285, 357)
  $idleRect = [System.Drawing.Rectangle]::new(434, 126, 285, 357)

  $speaking = $image.Clone($speakingRect, $image.PixelFormat)
  $idle = $image.Clone($idleRect, $image.PixelFormat)

  try {
    $speaking.Save((Join-Path $outputPath "talking.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $idle.Save((Join-Path $outputPath "idle.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $speaking.Dispose()
    $idle.Dispose()
  }
} finally {
  $image.Dispose()
}

Write-Host "Wrote $OutputDir/idle.png and $OutputDir/talking.png"
