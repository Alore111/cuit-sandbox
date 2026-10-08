/* ================================================================
   坐标系统
   —— 全项目只有这里做「经纬度 / 本地米 / 体素 / 世界」之间的换算。

       本地米 (x, y)   以校园边界包围盒的西南角为原点，x 向东、y 向北
       体素   (vx, vz) 整数网格，vz 向南增大；y 轴向上，与平面网格正交
       世界   单位 = 体素，(x,y,z) 体素的中心是 (x+0.5, y+0.5, z+0.5)

   为什么不再有 DEMO 的「影像像素」层：影像分类已废弃，像素层原本只是
   为了与瓦片影像逐像素对齐；现在直接用等距圆柱近似落到本地米即可，
   校园尺度下误差远小于一个体素。
================================================================ */

import { METERS_PER_DEGREE_LAT, metersPerDegreeLon } from '../contract';
import type { LonLat, School } from '../contract';

export interface LocalPoint {
    x: number;
    y: number;
}

export interface GridPoint {
    vx: number;
    vz: number;
}

export interface GridSystem {
    voxelMeters: number;
    /** 网格尺寸（体素列数 × 行数，闭区间） */
    width: number;
    height: number;
    /** 校园边界包围盒的实际跨度（米） */
    spanMeters: { x: number; z: number };
    /** 本地米原点对应的经纬度（即边界包围盒西南角） */
    origin: LonLat;
    /** 校园中心的世界坐标（相机默认注视点） */
    center: { x: number; z: number };
    /** 世界尺度（体素），供相机取景与平移限位 */
    size: { x: number; z: number };
    /** 经纬度 → 体素（浮点，调用方自行取整） */
    lonLatToVoxel(lat: number, lon: number): GridPoint;
    /** 本地米 → 体素（浮点，供多边形栅格化用） */
    localToVoxel(point: LocalPoint): GridPoint;
    /** 体素平面坐标 → 世界坐标（忽略高度） */
    voxelToWorld(vx: number, vz: number): { x: number; z: number };
    /** 体素中心是否落在岛面轮廓内 */
    isInsideIsland(vx: number, vz: number): boolean;
    /** 体素中心在本地米坐标下的位置 */
    voxelToLocal(vx: number, vz: number): LocalPoint;
}

/**
 * 射线法判断点是否在多边形内。
 * 只用于「格心是否落在多边形内」，边界处差一个体素无所谓，因此不做容差处理。
 */
export function isInsidePolygon(x: number, y: number, polygon: LocalPoint[]): boolean {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const { x: xi, y: yi } = polygon[i];
        const { x: xj, y: yj } = polygon[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}

/** 经纬度轮廓 → 本地米轮廓 */
export function toLocalPolygon(outline: LonLat[], origin: LonLat): LocalPoint[] {
    const kx = metersPerDegreeLon(origin[0]);
    return outline.map(([lat, lon]) => ({
        x: (lon - origin[1]) * kx,
        y: (lat - origin[0]) * METERS_PER_DEGREE_LAT
    }));
}

/** 经纬度点 → 本地米点 */
export function toLocalPoint(lat: number, lon: number, origin: LonLat): LocalPoint {
    const kx = metersPerDegreeLon(origin[0]);
    return {
        x: (lon - origin[1]) * kx,
        y: (lat - origin[0]) * METERS_PER_DEGREE_LAT
    };
}

/** 本地米点 → 经纬度点（编辑器的拖点回写要走这一步） */
export function toLonLatPoint(point: LocalPoint, origin: LonLat): LonLat {
    const kx = metersPerDegreeLon(origin[0]);
    return [origin[0] + point.y / METERS_PER_DEGREE_LAT, origin[1] + point.x / kx];
}

/**
 * 由学校配置推出网格系统。
 * 网格范围 = **岛面轮廓**包围盒 + gridPaddingMeters 余量 ——
 * 岛面比校园边界大一圈，若按 boundary 取网格会把外圈的草地缘切掉。
 */
export function createGrid(school: School): GridSystem {
    const { voxelMeters, island } = school;

    const lats = island.outline.map(([lat]) => lat);
    const lons = island.outline.map(([, lon]) => lon);
    const origin: LonLat = [Math.min(...lats), Math.min(...lons)];

    const islandLocal = toLocalPolygon(island.outline, origin);
    const spanX = Math.max(...islandLocal.map((p) => p.x));
    const spanY = Math.max(...islandLocal.map((p) => p.y));

    /* 余量允许为 0，因此这里不加「至少 1 格」的下限（那是质感参数的规则） */
    const paddingVoxels = Math.max(0, Math.round(school.gridPaddingMeters / voxelMeters));
    const width = Math.ceil(spanX / voxelMeters) + paddingVoxels * 2;
    const height = Math.ceil(spanY / voxelMeters) + paddingVoxels * 2;

    /* 体素 (0,0) 的西南角在本地米坐标下的位置 */
    const x0 = -paddingVoxels * voxelMeters;
    const y0 = spanY + paddingVoxels * voxelMeters;

    const voxelToLocal = (vx: number, vz: number): LocalPoint => ({
        x: x0 + (vx + 0.5) * voxelMeters,
        y: y0 - (vz + 0.5) * voxelMeters
    });

    const localToVoxel = (point: LocalPoint): GridPoint => ({
        vx: (point.x - x0) / voxelMeters - 0.5,
        vz: (y0 - point.y) / voxelMeters - 0.5
    });

    return {
        voxelMeters,
        width,
        height,
        spanMeters: { x: spanX, z: spanY },
        origin,
        center: { x: width / 2, z: height / 2 },
        size: { x: width, z: height },
        lonLatToVoxel(lat: number, lon: number): GridPoint {
            return localToVoxel(toLocalPoint(lat, lon, origin));
        },
        localToVoxel,
        voxelToWorld(vx: number, vz: number): { x: number; z: number } {
            return { x: vx + 0.5, z: vz + 0.5 };
        },
        isInsideIsland(vx: number, vz: number): boolean {
            const point = voxelToLocal(vx, vz);
            return isInsidePolygon(point.x, point.y, islandLocal);
        },
        voxelToLocal
    };
}
