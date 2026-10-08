/* 本文件由 scripts/fetch-basemap.ps1 自动生成，请勿手工编辑。
   卫星底图的像素坐标系元数据：编辑器据此把 public/basemap/aerial.jpg
   贴到「经纬度 → 本地米」的投影上（见 src/editor/baseMap.ts）。
   重新生成：npm run basemap（需后端在跑，走 GET /api/map/school 取岛面轮廓）。 */

import type { BaseMapMeta } from './editorTypes';

export const BASEMAP_META: BaseMapMeta = {
    "source":  "Esri World Imagery (ArcGIS REST tile service)",
    "note":  "仅用于本地开发验证，正式发布前需替换为自有或已授权影像",
    "fetchedAt":  "2026-09-24 14:56:56",
    "url":  "basemap/aerial.jpg",
    "zoom":  18,
    "width":  3328,
    "height":  2304,
    "metersPerPixel":  0.5141,
    "bounds":  {
                   "west":  103.97735595703125,
                   "south":  30.578814670835,
                   "east":  103.99520874023438,
                   "north":  30.589454856169539
               }
};

