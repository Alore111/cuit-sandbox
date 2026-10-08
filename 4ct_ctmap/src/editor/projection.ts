/* ================================================================
   编辑器的坐标口径
   —— 经纬度 ↔ 本地米的换算必须与渲染层完全一致，否则「拖出来的轮廓」
      在沙盘上会整体偏移。因此这里复用 utils/geo 的同一套公式，
      原点取参考轮廓（岛面）包围盒的西南角 —— 与 createGrid 的取法相同。

      【口径】原点在**一次编辑会话内固定不变**（由 EditorApp 在读取数据时
      快照一次）。岛面轮廓本身现在也能编辑，若原点跟着轮廓包围盒实时变，
      拖动西南角的那个点时整幅画布都会跟着漂移。
================================================================ */

import type { LonLat } from '../contract';
import { toLocalPoint, toLonLatPoint } from '../utils/geo';

export interface MeterPoint {
    x: number;
    y: number;
}

export interface EditorProjection {
    /** 经纬度 → 本地米 */
    toMeters: (point: LonLat) => MeterPoint;
    /** 本地米 → 经纬度（保留 7 位小数，与数据文件同一精度） */
    toLonLat: (point: MeterPoint) => LonLat;
}

/** 投影原点：参考轮廓包围盒的西南角 */
export function projectionOrigin(reference: LonLat[]): LonLat {
    const lats = reference.map(([lat]) => lat);
    const lons = reference.map(([, lon]) => lon);
    return [Math.min(...lats), Math.min(...lons)];
}

export function createProjection(origin: LonLat): EditorProjection {
    return {
        toMeters: ([lat, lon]) => toLocalPoint(lat, lon, origin),
        toLonLat: ({ x, y }) => {
            const [lat, lon] = toLonLatPoint({ x, y }, origin);
            return [Number(lat.toFixed(7)), Number(lon.toFixed(7))];
        }
    };
}
