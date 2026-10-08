/* ================================================================
   经纬度 ↔ 米的近似换算（纯函数）
   —— 校园尺度下（千米级）用等距圆柱近似即可，误差远小于一个体素。
      「数据源里不存面积、两端各自现算」的前提是两端用同一套公式，
      这也是本文件必须与另一个项目的同名副本逐字一致的原因。
================================================================ */

import type { LonLat } from './types';

/** 每度纬度对应的米数 */
export const METERS_PER_DEGREE_LAT = 111320;

/** 指定纬度上每度经度对应的米数 */
export function metersPerDegreeLon(lat: number): number {
    return METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180);
}

/**
 * 多边形面积（平方米）：经纬度先按等距圆柱近似换算成米，再套鞋带公式。
 * 经度方向统一用首点的纬度换算，避免逐点变尺度带来的账面误差。
 */
export function polygonAreaM2(points: LonLat[]): number {
    if (points.length < 3) return 0;

    const kx = metersPerDegreeLon(points[0][0]);
    let sum = 0;

    for (let i = 0; i < points.length; i++) {
        const [latA, lonA] = points[i];
        const [latB, lonB] = points[(i + 1) % points.length];
        sum += (lonA * kx) * (latB * METERS_PER_DEGREE_LAT) - (lonB * kx) * (latA * METERS_PER_DEGREE_LAT);
    }

    return Math.abs(sum) / 2;
}
