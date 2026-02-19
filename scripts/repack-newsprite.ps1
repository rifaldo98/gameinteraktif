param(
    [string]$InputPath = "public/newsprite.png",
    [string]$OutputPath = "public/newsprite_repacked.png"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

function Is-Background([System.Drawing.Color]$c) {
    $lum = (0.299 * $c.R) + (0.587 * $c.G) + (0.114 * $c.B)
    $drg = [Math]::Abs([int]$c.R - [int]$c.G)
    $dgb = [Math]::Abs([int]$c.G - [int]$c.B)
    $drb = [Math]::Abs([int]$c.R - [int]$c.B)

    # Strip the checkerboard background from source sheet.
    if ($lum -ge 210 -and $drg -le 10 -and $dgb -le 10 -and $drb -le 10) {
        return $true
    }

    return $false
}

function Get-Components([System.Drawing.Bitmap]$img, [int]$sx, [int]$sy, [int]$w, [int]$h) {
    $mask = New-Object bool[] ($w * $h)
    for ($y = 0; $y -lt $h; $y++) {
        for ($x = 0; $x -lt $w; $x++) {
            $color = $img.GetPixel($sx + $x, $sy + $y)
            $mask[($y * $w) + $x] = -not (Is-Background $color)
        }
    }

    $labels = New-Object int[] ($w * $h)
    $components = New-Object System.Collections.ArrayList
    $componentId = 0

    for ($y = 0; $y -lt $h; $y++) {
        for ($x = 0; $x -lt $w; $x++) {
            $startIndex = ($y * $w) + $x
            if (-not $mask[$startIndex] -or $labels[$startIndex] -ne 0) {
                continue
            }

            $componentId += 1
            $queue = New-Object System.Collections.Generic.Queue[int]
            $pixels = New-Object System.Collections.Generic.List[int]
            $queue.Enqueue($startIndex)
            $labels[$startIndex] = $componentId

            $minX = $x
            $maxX = $x
            $minY = $y
            $maxY = $y

            while ($queue.Count -gt 0) {
                $index = $queue.Dequeue()
                [void]$pixels.Add($index)

                $px = $index % $w
                $py = [int]($index / $w)

                if ($px -lt $minX) { $minX = $px }
                if ($px -gt $maxX) { $maxX = $px }
                if ($py -lt $minY) { $minY = $py }
                if ($py -gt $maxY) { $maxY = $py }

                if ($px -gt 0) {
                    $left = $index - 1
                    if ($mask[$left] -and $labels[$left] -eq 0) {
                        $labels[$left] = $componentId
                        $queue.Enqueue($left)
                    }
                }

                if ($px -lt ($w - 1)) {
                    $right = $index + 1
                    if ($mask[$right] -and $labels[$right] -eq 0) {
                        $labels[$right] = $componentId
                        $queue.Enqueue($right)
                    }
                }

                if ($py -gt 0) {
                    $up = $index - $w
                    if ($mask[$up] -and $labels[$up] -eq 0) {
                        $labels[$up] = $componentId
                        $queue.Enqueue($up)
                    }
                }

                if ($py -lt ($h - 1)) {
                    $down = $index + $w
                    if ($mask[$down] -and $labels[$down] -eq 0) {
                        $labels[$down] = $componentId
                        $queue.Enqueue($down)
                    }
                }
            }

            $component = [PSCustomObject]@{
                Id = $componentId
                Size = $pixels.Count
                MinX = $minX
                MaxX = $maxX
                MinY = $minY
                MaxY = $maxY
                Pixels = $pixels
            }
            [void]$components.Add($component)
        }
    }

    return [PSCustomObject]@{
        Labels = $labels
        Components = $components
    }
}

if (-not (Test-Path $InputPath)) {
    throw "Input file not found: $InputPath"
}

$src = [System.Drawing.Bitmap]::FromFile($InputPath)

[int]$sourceCellWidth = 128
[int]$sourceCellHeight = 204
[int]$targetCellWidth = 192
[int]$targetCellHeight = 256
[int]$targetCols = 7
[int]$targetRows = 4
[int]$bboxPadding = 2
[int]$neighbourMargin = 20

$rowMappings = @(
    @{ Name = "punch-attack"; SourceRow = 0; Cols = @(0, 1, 2, 3, 4, 5, 6) },
    @{ Name = "punch-defend"; SourceRow = 1; Cols = @(0, 1, 2, 3, 4, 5, 6) },
    @{ Name = "sword-attack"; SourceRow = 4; Cols = @(0, 1, 2, 3, 4, 5, 6) },
    @{ Name = "sword-defend"; SourceRow = 3; Cols = @(0, 1, 2, 3, 4, 5, 6) }
)

$outputWidth = $targetCellWidth * $targetCols
$outputHeight = $targetCellHeight * $targetRows
$dst = New-Object System.Drawing.Bitmap -ArgumentList @(
    $outputWidth,
    $outputHeight,
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
)

$graphics = [System.Drawing.Graphics]::FromImage($dst)
$graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
$graphics.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
$graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
$graphics.Dispose()

for ($targetRow = 0; $targetRow -lt $targetRows; $targetRow++) {
    $map = $rowMappings[$targetRow]
    $sourceRowY = $map.SourceRow * $sourceCellHeight

    for ($targetCol = 0; $targetCol -lt $targetCols; $targetCol++) {
        $sourceCol = [int]$map.Cols[$targetCol]
        $sourceX = $sourceCol * $sourceCellWidth

        $analysis = Get-Components -img $src -sx $sourceX -sy $sourceRowY -w $sourceCellWidth -h $sourceCellHeight
        $components = $analysis.Components
        $labels = $analysis.Labels

        if ($components.Count -eq 0) {
            continue
        }

        $anchorX = [int]($sourceCellWidth / 2)
        $anchorY = [int]($sourceCellHeight * 0.7)

        $bestComponent = $null
        $bestScore = [double]::NegativeInfinity
        foreach ($component in $components) {
            $centerX = ($component.MinX + $component.MaxX) / 2.0
            $centerY = ($component.MinY + $component.MaxY) / 2.0
            $distance = [Math]::Sqrt(
                [Math]::Pow($centerX - $anchorX, 2) +
                [Math]::Pow($centerY - $anchorY, 2)
            )
            $score = ($component.Size * 3.0) - ($distance * 7.5)
            if ($score -gt $bestScore) {
                $bestScore = $score
                $bestComponent = $component
            }
        }

        if ($null -eq $bestComponent) {
            continue
        }

        $selectedIds = New-Object System.Collections.Generic.HashSet[int]
        [void]$selectedIds.Add([int]$bestComponent.Id)

        foreach ($component in $components) {
            if ($component.Id -eq $bestComponent.Id -or $component.Size -lt 10) {
                continue
            }

            $intersects =
                $component.MinX -le ($bestComponent.MaxX + $neighbourMargin) -and
                $component.MaxX -ge ($bestComponent.MinX - $neighbourMargin) -and
                $component.MinY -le ($bestComponent.MaxY + $neighbourMargin) -and
                $component.MaxY -ge ($bestComponent.MinY - $neighbourMargin)

            if ($intersects) {
                [void]$selectedIds.Add([int]$component.Id)
            }
        }

        $selectedMinX = $sourceCellWidth
        $selectedMinY = $sourceCellHeight
        $selectedMaxX = 0
        $selectedMaxY = 0
        $hasAny = $false

        foreach ($component in $components) {
            if (-not $selectedIds.Contains([int]$component.Id)) {
                continue
            }

            if ($component.MinX -lt $selectedMinX) { $selectedMinX = $component.MinX }
            if ($component.MinY -lt $selectedMinY) { $selectedMinY = $component.MinY }
            if ($component.MaxX -gt $selectedMaxX) { $selectedMaxX = $component.MaxX }
            if ($component.MaxY -gt $selectedMaxY) { $selectedMaxY = $component.MaxY }
            $hasAny = $true
        }

        if (-not $hasAny) {
            continue
        }

        $selectedMinX = [Math]::Max(0, $selectedMinX - $bboxPadding)
        $selectedMinY = [Math]::Max(0, $selectedMinY - $bboxPadding)
        $selectedMaxX = [Math]::Min($sourceCellWidth - 1, $selectedMaxX + $bboxPadding)
        $selectedMaxY = [Math]::Min($sourceCellHeight - 1, $selectedMaxY + $bboxPadding)

        $bboxWidth = $selectedMaxX - $selectedMinX + 1
        $bboxHeight = $selectedMaxY - $selectedMinY + 1

        $targetCellX = $targetCol * $targetCellWidth
        $targetCellY = $targetRow * $targetCellHeight
        $drawX = $targetCellX + [int](($targetCellWidth - $bboxWidth) / 2)
        $drawY = $targetCellY + ($targetCellHeight - 2 - $bboxHeight)

        if ($drawX -lt $targetCellX) { $drawX = $targetCellX }
        if (($drawX + $bboxWidth) -gt ($targetCellX + $targetCellWidth)) {
            $drawX = ($targetCellX + $targetCellWidth) - $bboxWidth
        }
        if ($drawY -lt $targetCellY) { $drawY = $targetCellY }

        for ($localY = $selectedMinY; $localY -le $selectedMaxY; $localY++) {
            for ($localX = $selectedMinX; $localX -le $selectedMaxX; $localX++) {
                $label = $labels[($localY * $sourceCellWidth) + $localX]
                if (-not $selectedIds.Contains([int]$label)) {
                    continue
                }

                $sourceColor = $src.GetPixel($sourceX + $localX, $sourceRowY + $localY)
                if (Is-Background $sourceColor) {
                    continue
                }

                $outX = $drawX + ($localX - $selectedMinX)
                $outY = $drawY + ($localY - $selectedMinY)

                $dst.SetPixel(
                    $outX,
                    $outY,
                    [System.Drawing.Color]::FromArgb(255, $sourceColor.R, $sourceColor.G, $sourceColor.B)
                )
            }
        }
    }
}

$dst.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
$src.Dispose()
$dst.Dispose()

Write-Output "Repacked sprite saved to: $OutputPath"
