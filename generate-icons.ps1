# generate-icons.ps1 — Creates PNG icon files for PersonPeek extension
# Uses .NET System.Drawing to render programmatic icons

Add-Type -AssemblyName System.Drawing

function New-PersonPeekIcon([int]$size, [string]$outputPath) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

    # Background
    $g.Clear([System.Drawing.Color]::FromArgb(255, 12, 12, 20))

    # Gradient brush (purple to teal)
    $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $gradBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $rect,
        [System.Drawing.Color]::FromArgb(255, 108, 99, 255),
        [System.Drawing.Color]::FromArgb(255, 0, 212, 170),
        [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal
    )

    # Center of magnifying glass
    $cx = [int]($size * 0.42)
    $cy = [int]($size * 0.37)

    # Magnifying glass circle
    $magR = [int]($size * 0.22)
    $strokeWidth = [Math]::Max(2, [int]($size * 0.047))
    $pen = New-Object System.Drawing.Pen($gradBrush, $strokeWidth)
    $g.DrawEllipse($pen, ($cx - $magR), ($cy - $magR), ($magR * 2), ($magR * 2))

    # Handle
    $handleWidth = [Math]::Max(3, [int]($size * 0.06))
    $handlePen = New-Object System.Drawing.Pen($gradBrush, $handleWidth)
    $handlePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $handlePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLine($handlePen,
        [int]($cx + $magR * 0.7), [int]($cy + $magR * 0.7),
        [int]($size * 0.82), [int]($size * 0.82)
    )

    # Person silhouette inside magnifying glass
    # Head
    $headR = [int]($size * 0.08)
    $g.FillEllipse($gradBrush, ($cx - $headR), ($cy - $headR - [int]($size * 0.04)), ($headR * 2), ($headR * 2))

    # Body arc
    $bodyW = [int]($size * 0.22)
    $bodyH = [int]($size * 0.12)
    $bodyPen = New-Object System.Drawing.Pen($gradBrush, [Math]::Max(2, [int]($size * 0.035)))
    $bodyPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $bodyPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawArc($bodyPen,
        ($cx - [int]($bodyW / 2)), ($cy + [int]($size * 0.02)),
        $bodyW, $bodyH,
        0, 180
    )

    # Save
    $bmp.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Host "Created: $outputPath ($($bmp.Width)x$($bmp.Height))"

    # Cleanup
    $pen.Dispose()
    $handlePen.Dispose()
    $bodyPen.Dispose()
    $gradBrush.Dispose()
    $g.Dispose()
    $bmp.Dispose()
}

$iconsDir = Join-Path $PSScriptRoot 'icons'

foreach ($size in @(16, 48, 128)) {
    $outPath = Join-Path $iconsDir "icon$size.png"
    New-PersonPeekIcon -size $size -outputPath $outPath
}

Write-Host "All icons generated!"
