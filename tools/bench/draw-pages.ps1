param(
  [Parameter(Mandatory = $true)][string]$Spec,
  [Parameter(Mandatory = $true)][string]$OutDir
)
# ASCII-only script body: text comes from a UTF-8 JSON spec, never from literals.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$json = [System.IO.File]::ReadAllText($Spec, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

$fontFamily = 'Microsoft YaHei'
$monoFamily = 'Consolas'

foreach ($page in $json.pages) {
  $w = [int]$page.width
  $h = [int]$page.height
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $bg = if ($page.dark) { [System.Drawing.Color]::FromArgb(24, 26, 32) } else { [System.Drawing.Color]::White }
  $fg = if ($page.dark) { [System.Drawing.Color]::FromArgb(232, 234, 240) } else { [System.Drawing.Color]::FromArgb(16, 16, 16) }
  $g.Clear($bg)
  $y = [int]$page.margin
  foreach ($line in $page.lines) {
    $family = if ($line.mono) { $monoFamily } else { $fontFamily }
    $style = if ($line.bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
    $font = New-Object System.Drawing.Font $family, ([float]$line.size), $style, ([System.Drawing.GraphicsUnit]::Pixel)
    $brush = New-Object System.Drawing.SolidBrush $fg
    $g.DrawString($line.text, $font, $brush, [float]$page.margin, [float]$y)
    $brush.Dispose()
    $y += [int]([Math]::Round($line.size * 1.6))
    $font.Dispose()
  }
  $g.Dispose()
  $file = Join-Path $OutDir ($page.name)
  $ext = [System.IO.Path]::GetExtension($file).ToLowerInvariant()
  if ($ext -eq '.jpg' -or $ext -eq '.jpeg') {
    # 75% JPEG is roughly what a phone photo / slide screenshot carries
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
    $params = New-Object System.Drawing.Imaging.EncoderParameters 1
    $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([int64]$page.quality)
    $bmp.Save($file, $codec, $params)
  } else {
    $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  }
  $bmp.Dispose()
  Write-Output (ConvertTo-Json @{ name = $page.name; width = $w; height = $h } -Compress)
}
