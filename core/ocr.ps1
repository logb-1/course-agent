param(
  [string]$Pdf = '',
  [string]$OutDir = '',
  [string]$Image = '',
  [switch]$NoPreprocess,
  [string]$Pages = '',
  [int]$First = 0,
  [int]$Last = -1,
  [int]$Width = 1600,
  [string]$Lang = 'zh-CN',
  [string]$Langs = '',
  [switch]$Lines
)
# ASCII-only on purpose: Windows PowerShell reads .ps1 as ANSI when there is no
# BOM, so any non-ASCII literal would be corrupted. All text comes from OCR.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$opGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
$actionGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
})[0]
function Await($op, $type) {
  $task = $opGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}
function AwaitAction($action) {
  $task = $actionGeneric.Invoke($null, @($action))
  $task.Wait(-1) | Out-Null
}

# Windows OCR reads a flat, light bitmap far better than a dark or tiny one.
# Slides and scans are often neither, so normalise before recognition: upscale
# small images, and grayscale+invert dark ones (light-on-dark reads badly).
# Returns a temp PNG path, or the original path when preprocessing fails.
function Get-OcrImage($srcPath) {
  try {
    Add-Type -AssemblyName System.Drawing
    $src = [System.Drawing.Image]::FromFile($srcPath)
    $minSide = [Math]::Min($src.Width, $src.Height)
    $scale = 1.0
    if ($minSide -gt 0 -and $minSide -lt 500) { $scale = [Math]::Min(2.5, 800.0 / $minSide) }
    $newW = [int]([Math]::Min(2600, [Math]::Round($src.Width * $scale)))
    $newH = [int]([Math]::Min(2600, [Math]::Round($src.Height * $scale)))
    if ($newW -lt 1) { $newW = 1 }
    if ($newH -lt 1) { $newH = 1 }

    # brightness from a 32x32 thumbnail: per-pixel loops on full images are slow
    $thumb = New-Object System.Drawing.Bitmap 32, 32
    $tg = [System.Drawing.Graphics]::FromImage($thumb)
    $tg.DrawImage($src, 0, 0, 32, 32)
    $sum = 0.0
    for ($y = 0; $y -lt 32; $y++) {
      for ($x = 0; $x -lt 32; $x++) {
        $c = $thumb.GetPixel($x, $y)
        $sum += (0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B)
      }
    }
    $mean = $sum / 1024.0
    $tg.Dispose()
    $thumb.Dispose()

    $cm = New-Object System.Drawing.Imaging.ColorMatrix
    $dark = ($mean -lt 100)
    # Nothing to fix: re-encoding a light, full-size page only disturbs it.
    if (-not $dark -and $scale -eq 1.0) {
      $src.Dispose()
      return $srcPath
    }
    if ($dark) {
      $cm.Matrix00 = -0.299
      $cm.Matrix01 = -0.299
      $cm.Matrix02 = -0.299
      $cm.Matrix10 = -0.587
      $cm.Matrix11 = -0.587
      $cm.Matrix12 = -0.587
      $cm.Matrix20 = -0.114
      $cm.Matrix21 = -0.114
      $cm.Matrix22 = -0.114
      $cm.Matrix40 = 1.0
      $cm.Matrix41 = 1.0
      $cm.Matrix42 = 1.0
    }
    $cm.Matrix33 = 1.0
    $attrs = New-Object System.Drawing.Imaging.ImageAttributes
    $attrs.SetColorMatrix($cm)

    $bmp = New-Object System.Drawing.Bitmap $newW, $newH
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $rect = New-Object System.Drawing.Rectangle 0, 0, $newW, $newH
    $g.DrawImage($src, $rect, 0, 0, $src.Width, $src.Height, [System.Drawing.GraphicsUnit]::Pixel, $attrs)
    $g.Dispose()
    $out = Join-Path $env:TEMP ("ocr-pre-" + [guid]::NewGuid().ToString("N") + ".png")
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $src.Dispose()
    return $out
  } catch {
    return $srcPath
  }
}

[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFolder, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null

$languages = @()
if ($Langs) { foreach ($token in $Langs.Split(',')) { if ($token.Trim()) { $languages += $token.Trim() } } }
if (-not $languages.Count) { $languages = @($Lang) }
$engine = $null
$recognizers = @()
foreach ($language in $languages) {
  $candidate = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language $language))
  if ($candidate) {
    $recognizers += @{ lang = $language; engine = $candidate }
    if (-not $engine) { $engine = $candidate }
  } elseif ($language -eq $languages[0]) {
    Write-Output (ConvertTo-Json @{ error = "no-ocr-engine:" + $language } -Compress)
    exit 3
  }
}
if (-not $engine) {
  Write-Output (ConvertTo-Json @{ error = 'no-ocr-engine' } -Compress)
  exit 3
}

if ($Image) {
  $target = $Image
  $tempFile = $null
  if (-not $NoPreprocess) {
    $target = Get-OcrImage $Image
    if ($target -ne $Image) { $tempFile = $target }
  }

  $imgFile = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($target)) ([Windows.Storage.StorageFile])
  $imgStream = Await ($imgFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $imgDecoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($imgStream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $imgBitmap = Await ($imgDecoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $imgResult = Await ($engine.RecognizeAsync($imgBitmap)) ([Windows.Media.Ocr.OcrResult])
  $imgText = ($imgResult.Lines | ForEach-Object { $_.Text }) -join "`n"
  Write-Output (ConvertTo-Json @{ page = 1; text = $imgText } -Compress)
  $imgStream.Dispose()
  if ($tempFile) { Remove-Item $tempFile -Force -ErrorAction SilentlyContinue }
  exit 0
}
if (-not $Pdf) {
  Write-Output (ConvertTo-Json @{ error = 'no-input' } -Compress)
  exit 4
}

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Pdf)) ([Windows.Storage.StorageFile])
$doc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
$numPages = $doc.PageCount
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
$folder = Await ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync($OutDir)) ([Windows.Storage.StorageFolder])

# -Pages "3,17,18" reads exactly those 1-based pages (page-level triage);
# otherwise the -First..-Last range is used, as before.
$targets = @()
if ($Pages) {
  foreach ($token in $Pages.Split(',')) {
    $n = 0
    if ([int]::TryParse($token.Trim(), [ref]$n)) {
      if ($n -ge 1 -and $n -le $numPages) { $targets += ($n - 1) }
    }
  }
  if ($targets.Count -eq 0) {
    Write-Output (ConvertTo-Json @{ error = 'no-valid-pages' } -Compress)
    exit 4
  }
} else {
  if ($Last -lt 0 -or $Last -ge $numPages) { $Last = $numPages - 1 }
  $targets = @($First..$Last)
}

Write-Output (ConvertTo-Json @{ pageCount = $numPages; first = $targets[0] + 1; last = $targets[$targets.Count - 1] + 1; pages = $targets.Count } -Compress)

foreach ($i in $targets) {
  $page = $doc.GetPage($i)
  $name = "page-$($i + 1).png"
  $outFile = Await ($folder.CreateFileAsync($name, [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])
  $outStream = Await ($outFile.OpenAsync([Windows.Storage.FileAccessMode]::ReadWrite)) ([Windows.Storage.Streams.IRandomAccessStream])
  # -Width 0 keeps the PDF's own render size; a wider render does not add detail
  # to an image-only page and measurably hurts WinRT on text pages.
  if ($Width -gt 0) {
    $renderOptions = New-Object Windows.Data.Pdf.PdfPageRenderOptions
    $renderOptions.DestinationWidth = [uint32]$Width
    AwaitAction ($page.RenderToStreamAsync([Windows.Storage.Streams.IRandomAccessStream]$outStream, $renderOptions))
  } else {
    AwaitAction ($page.RenderToStreamAsync([Windows.Storage.Streams.IRandomAccessStream]$outStream))
  }
  $outStream.Dispose()

  # One render, many readers: a second language pass costs a recognition, not a
  # second rasterisation.
  $png = Join-Path $OutDir $name
  $ocrPng = $png
  $preFile = $null
  if (-not $NoPreprocess) {
    $preFile = Get-OcrImage $png
    if ($preFile -ne $png) { $ocrPng = $preFile }
  }
  $pngFile = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ocrPng)) ([Windows.Storage.StorageFile])
  $readStream = Await ($pngFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($readStream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  $results = New-Object System.Collections.ArrayList
  foreach ($recognizer in $recognizers) {
    $result = Await ($recognizer.engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $text = ($result.Lines | ForEach-Object { $_.Text }) -join "`n"
    $rows = New-Object System.Collections.ArrayList
    if ($Lines) {
      foreach ($line in $result.Lines) {
        $minX = 1e9; $minY = 1e9; $maxX = -1e9; $maxY = -1e9
        foreach ($word in $line.Words) {
          $r = $word.BoundingRect
          if ($r.X -lt $minX) { $minX = $r.X }
          if ($r.Y -lt $minY) { $minY = $r.Y }
          if (($r.X + $r.Width) -gt $maxX) { $maxX = $r.X + $r.Width }
          if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
        }
        if ($maxX -gt $minX) {
          [void]$rows.Add(@{ text = $line.Text; x = [int]$minX; y = [int]$minY; w = [int]($maxX - $minX); h = [int]($maxY - $minY) })
        }
      }
    }
    [void]$results.Add(@{ lang = $recognizer.lang; text = $text; lines = $rows })
  }

  if ($results.Count -eq 0) {
    Write-Output (ConvertTo-Json @{ page = $i + 1; text = ''; lines = @(); error = 'no-ocr-result' } -Compress)
    continue
  }
  # `$first` would collide with the -First page parameter (variables are
  # case-insensitive in PowerShell), so this one is called $primary.
  $primary = $results[0]
  Write-Output (ConvertTo-Json @{ page = $i + 1; text = $primary.text; lines = $primary.lines; lang = $primary.lang; results = $results } -Compress -Depth 6)
  $readStream.Dispose()
  if ($preFile) { Remove-Item $preFile -Force -ErrorAction SilentlyContinue }
  Remove-Item $png -Force -ErrorAction SilentlyContinue
}
