param(
  [Parameter(Mandatory = $true)]
  [string]$Source,

  [string]$OutputDir = "windows-launcher/assets/avatar"
)

Add-Type -AssemblyName System.Drawing

$sourcePath = (Resolve-Path -LiteralPath $Source).Path
$outputPath = (Resolve-Path -LiteralPath $OutputDir).Path

$image = [System.Drawing.Bitmap]::new($sourcePath)

function Test-IsAvatarPixel {
  param(
    [System.Drawing.Color]$Color
  )

  # The sheet background is near-black. Keep the white/gray art and outlines.
  return ($Color.R -gt 36 -or $Color.G -gt 36 -or $Color.B -gt 36)
}

function Find-ContentBounds {
  param(
    [System.Drawing.Bitmap]$Bitmap,
    [System.Drawing.Rectangle]$SearchRect
  )

  $minX = $SearchRect.Right
  $minY = $SearchRect.Bottom
  $maxX = $SearchRect.Left
  $maxY = $SearchRect.Top

  for ($y = $SearchRect.Top; $y -lt $SearchRect.Bottom; $y++) {
    for ($x = $SearchRect.Left; $x -lt $SearchRect.Right; $x++) {
      if (Test-IsAvatarPixel $Bitmap.GetPixel($x, $y)) {
        if ($x -lt $minX) { $minX = $x }
        if ($y -lt $minY) { $minY = $y }
        if ($x -gt $maxX) { $maxX = $x }
        if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }

  if ($maxX -le $minX -or $maxY -le $minY) {
    throw "No avatar pixels found in search rectangle $SearchRect"
  }

  $padding = 10
  $x = [Math]::Max(0, $minX - $padding)
  $y = [Math]::Max(0, $minY - $padding)
  $right = [Math]::Min($Bitmap.Width - 1, $maxX + $padding)
  $bottom = [Math]::Min($Bitmap.Height - 1, $maxY + $padding)

  return [System.Drawing.Rectangle]::new($x, $y, $right - $x + 1, $bottom - $y + 1)
}

function Copy-WithTransparentBackground {
  param(
    [System.Drawing.Bitmap]$Bitmap,
    [System.Drawing.Rectangle]$CropRect
  )

  $output = [System.Drawing.Bitmap]::new(
    $CropRect.Width,
    $CropRect.Height,
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
  )

  for ($y = 0; $y -lt $CropRect.Height; $y++) {
    for ($x = 0; $x -lt $CropRect.Width; $x++) {
      $sourceColor = $Bitmap.GetPixel($CropRect.X + $x, $CropRect.Y + $y)
      if (Test-IsAvatarPixel $sourceColor) {
        $output.SetPixel($x, $y, $sourceColor)
      } else {
        $output.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0))
      }
    }
  }

  return $output
}

try {
  # Left half is speaking. Right half is inactive.
  $speakingSearch = [System.Drawing.Rectangle]::new(0, 92, [int]($image.Width / 2), $image.Height - 92)
  $idleSearch = [System.Drawing.Rectangle]::new([int]($image.Width / 2), 92, [int]($image.Width / 2), $image.Height - 92)

  $speakingRect = Find-ContentBounds $image $speakingSearch
  $idleRect = Find-ContentBounds $image $idleSearch

  $speaking = Copy-WithTransparentBackground $image $speakingRect
  $idle = Copy-WithTransparentBackground $image $idleRect

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
