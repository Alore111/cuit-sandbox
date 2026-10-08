<#
  生成编辑器 2D 画布的卫星底图（离线拼接，一次性产物）。

  范围取自后端 `GET /api/map/school` 的 island.outline（岛面轮廓），外扩一圈余量，
  换算出需要的 Esri World Imagery 瓦片，下载并拼成一张大图。

  产出：
    public/basemap/aerial.jpg        拼接后的正射影像（编辑器的底图图层）
    src/editor/basemap.generated.ts  像素坐标系元数据（编辑器据此把影像贴到本地米坐标上）

  【口径】走 HTTP 取数，不直接读 ../4ct_ctmap_server/data/school.json：
  与 `npm run check` 同一条链路，脚本不 import 后端源码、不依赖对方的目录结构。
  因此有前置条件：后端要先在跑（`npm run dev:server`），连不上就明确报错退出，不做兜底。

  数据许可：Esri World Imagery 仅用于本地开发验证，正式发布前需替换为自有或已授权影像。

  依赖：Windows PowerShell 5.1 + .NET System.Drawing（拼图用，无需第三方库）。
#>
#Requires -Version 5.1
param(
    [string]$ApiBase = 'http://127.0.0.1:3001',
    [double]$MarginMeter = 120,       # 岛面轮廓外再扩的余量，让岛缘装饰物也进画面
    [int]$Zoom = 18,                  # z18 在 30.58°N 约 0.51 m/px
    [int]$JpegQuality = 85
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ImageOut = Join-Path $ProjectRoot 'public\basemap\aerial.jpg'
$MetaOut = Join-Path $ProjectRoot 'src\editor\basemap.generated.ts'
$TileCache = Join-Path $PSScriptRoot '.basemap-cache'
$TileUrlTemplate = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{0}/{1}/{2}'

# ===============================================================
# Web Mercator ↔ 瓦片索引
# ===============================================================

function Get-GlobalTileX([double]$Lon, [double]$Zoom) {
    return (($Lon + 180.0) / 360.0) * [Math]::Pow(2, $Zoom)
}
function Get-GlobalTileY([double]$Lat, [double]$Zoom) {
    $rad = $Lat * [Math]::PI / 180.0
    $merc = [Math]::Log([Math]::Tan($rad) + 1.0 / [Math]::Cos($rad))
    return (1.0 - $merc / [Math]::PI) / 2.0 * [Math]::Pow(2, $Zoom)
}
function Get-LonFromTileX([double]$TileX, [double]$Zoom) {
    return $TileX / [Math]::Pow(2, $Zoom) * 360.0 - 180.0
}
function Get-LatFromTileY([double]$TileY, [double]$Zoom) {
    $n = [Math]::PI * (1.0 - 2.0 * $TileY / [Math]::Pow(2, $Zoom))
    return [Math]::Atan([Math]::Sinh($n)) * 180.0 / [Math]::PI
}

# ===============================================================
# 1. 取岛面轮廓，推算瓦片范围
# ===============================================================

Write-Host '=== 拼接卫星底图 ===' -ForegroundColor Cyan

$schoolUrl = "$ApiBase/api/map/school"
try {
    $response = Invoke-RestMethod -Uri $schoolUrl -TimeoutSec 30
} catch {
    throw "取数失败：$schoolUrl（先确认后端在跑：npm run dev:server）。$($_.Exception.Message)"
}
if (-not $response.success) { throw "$schoolUrl 返回失败：$($response.message)" }

$outline = $response.data.island.outline
if (-not $outline -or $outline.Count -lt 3) { throw "$schoolUrl 的 island.outline 不合法" }
Write-Host ("[BASE] 岛面轮廓 {0} 点，来自 {1}" -f $outline.Count, $schoolUrl)

$lats = $outline | ForEach-Object { $_[0] }
$lons = $outline | ForEach-Object { $_[1] }
$minLat = ($lats | Measure-Object -Minimum).Minimum
$maxLat = ($lats | Measure-Object -Maximum).Maximum
$minLon = ($lons | Measure-Object -Minimum).Minimum
$maxLon = ($lons | Measure-Object -Maximum).Maximum
Write-Host ("[BASE] 岛面范围 lat {0:N6}~{1:N6}, lon {2:N6}~{3:N6}" -f $minLat, $maxLat, $minLon, $maxLon)

$latPad = $MarginMeter / 111320.0
$lonPad = $MarginMeter / (111320.0 * [Math]::Cos($minLat * [Math]::PI / 180.0))
$west = $minLon - $lonPad
$east = $maxLon + $lonPad
$north = $maxLat + $latPad
$south = $minLat - $latPad

$tx0 = [int][Math]::Floor((Get-GlobalTileX -Lon $west -Zoom $Zoom))
$tx1 = [int][Math]::Floor((Get-GlobalTileX -Lon $east -Zoom $Zoom))
$ty0 = [int][Math]::Floor((Get-GlobalTileY -Lat $north -Zoom $Zoom))   # 纬度越大 y 越小
$ty1 = [int][Math]::Floor((Get-GlobalTileY -Lat $south -Zoom $Zoom))

$cols = $tx1 - $tx0 + 1
$rows = $ty1 - $ty0 + 1
Write-Host "[BASE] z$Zoom 瓦片 x $tx0..$tx1 / y $ty0..$ty1，共 $($cols * $rows) 块，拼接后 $($cols * 256)x$($rows * 256) px"

# ===============================================================
# 2. 下载并拼接
# ===============================================================

New-Item -ItemType Directory -Force -Path $TileCache | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ImageOut) | Out-Null

$canvas = [System.Drawing.Bitmap]::new($cols * 256, $rows * 256, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$graphics = [System.Drawing.Graphics]::FromImage($canvas)
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

$downloaded = 0
$cached = 0
try {
    for ($tx = $tx0; $tx -le $tx1; $tx++) {
        for ($ty = $ty0; $ty -le $ty1; $ty++) {
            $tileFile = Join-Path $TileCache ("{0}_{1}_{2}.jpg" -f $Zoom, $tx, $ty)
            if (-not (Test-Path $tileFile) -or (Get-Item $tileFile).Length -eq 0) {
                $url = $TileUrlTemplate -f $Zoom, $ty, $tx
                curl.exe -s --max-time 90 -A 'Mozilla/5.0' -o $tileFile $url | Out-Null
                if ($LASTEXITCODE -ne 0 -or -not (Test-Path $tileFile) -or (Get-Item $tileFile).Length -eq 0) {
                    throw "瓦片下载失败：$url"
                }
                $downloaded++
                Start-Sleep -Milliseconds 120      # 轻量节流，避免被判定为爬取
            } else {
                $cached++
            }

            $tile = [System.Drawing.Bitmap]::FromFile($tileFile)
            try {
                $graphics.DrawImage($tile, ($tx - $tx0) * 256, ($ty - $ty0) * 256, 256, 256)
            } finally {
                $tile.Dispose()
            }
        }
    }
} finally {
    $graphics.Dispose()
}

$jpegCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
    Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
$encoderParams = [System.Drawing.Imaging.EncoderParameters]::new(1)
$encoderParams.Param[0] = [System.Drawing.Imaging.EncoderParameter]::new([System.Drawing.Imaging.Encoder]::Quality, [int64]$JpegQuality)
try {
    $canvas.Save($ImageOut, $jpegCodec, $encoderParams)
} finally {
    $canvas.Dispose()
}
Write-Host "[BASE] 新下载 $downloaded 块，命中瓦片缓存 $cached 块"
Write-Host "[BASE] 已写出 $ImageOut（$([Math]::Round((Get-Item $ImageOut).Length / 1MB, 2)) MB）"

# ===============================================================
# 3. 输出像素坐标系元数据
# ===============================================================
# 边界由首尾瓦片索引反算，而不是直接用请求 bbox：
# 瓦片会向下取整到整块，用原始 bbox 会让像素↔经纬度换算整体偏移最多半张瓦片。

$imgWest = Get-LonFromTileX -TileX $tx0 -Zoom $Zoom
$imgEast = Get-LonFromTileX -TileX ($tx1 + 1) -Zoom $Zoom
$imgNorth = Get-LatFromTileY -TileY $ty0 -Zoom $Zoom
$imgSouth = Get-LatFromTileY -TileY ($ty1 + 1) -Zoom $Zoom
$metersPerPixel = 156543.03392 * [Math]::Cos(($imgSouth + $imgNorth) / 2.0 * [Math]::PI / 180.0) / [Math]::Pow(2, $Zoom)

$metaPayload = [ordered]@{
    source         = 'Esri World Imagery (ArcGIS REST tile service)'
    note           = '仅用于本地开发验证，正式发布前需替换为自有或已授权影像'
    fetchedAt      = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    url            = 'basemap/aerial.jpg'
    zoom           = $Zoom
    width          = $cols * 256
    height         = $rows * 256
    metersPerPixel = [Math]::Round($metersPerPixel, 4)
    bounds         = [ordered]@{
        west  = $imgWest
        south = $imgSouth
        east  = $imgEast
        north = $imgNorth
    }
}

$json = $metaPayload | ConvertTo-Json -Depth 6
$header = @(
    '/* 本文件由 scripts/fetch-basemap.ps1 自动生成，请勿手工编辑。',
    '   卫星底图的像素坐标系元数据：编辑器据此把 public/basemap/aerial.jpg',
    '   贴到「经纬度 → 本地米」的投影上（见 src/editor/baseMap.ts）。',
    '   重新生成：npm run basemap（需后端在跑，走 GET /api/map/school 取岛面轮廓）。 */',
    '',
    "import type { BaseMapMeta } from './editorTypes';",
    '',
    "export const BASEMAP_META: BaseMapMeta = $json;",
    ''
) -join "`n"

Set-Content -Path $MetaOut -Value $header -Encoding UTF8
Write-Host "[BASE] 已写出 $MetaOut"
Write-Host '完成。' -ForegroundColor Green
