/* ================================================================
   路灯：沿水泥路两侧成对布置
   —— 【口径】只立在数据里标了 streetLamp 的地皮上；沿路的长轴每 LAMP_SPACING_METERS
      取一个断面，在该断面道路宽度方向的两侧各放一盏。

   实现上不做「中线拟合」：断面处的两条路缘直接从**该处的实际路格**里取 min/max，
   因此折线弯折、宽窄不一的路，灯也一定落在路面上，而不是靠几何推出的位置。

   形制：总高 LAMP_HEIGHT_METERS（4 m 在 2 m 体素下就是 2 格），
   下格灯杆（metal）、顶格灯头（lampGlow）。灯头单独一个 InstancedMesh + 自发光材质，
   夜间把 emissiveIntensity 拉高吃满 Bloom，白天压到近 0 —— 表示「灯没开」。
================================================================ */

import * as THREE from 'three';
import type { Parcel, TerrainTypeDef } from '../../contract';
import type { ThemeName } from '../../types/theme';
import type { GridSystem } from '../../utils/geo';
import { metersToVoxels } from '../constants';
import type { Slicer } from '../scheduler';
import { resolveThemeConfig, createSlotLookup, type ThemeConfig } from '../theme/palette';
import { createVoxelMesh } from '../voxel/buildVoxelMesh';
import { VoxelModel } from '../voxel/VoxelModel';
import { cellKey, clipToGrid, rasterizeOutline, type GridCell } from './rasterize';

/** 同侧相邻两盏灯的间距（米） */
export const LAMP_SPACING_METERS = 32;
/** 灯的总高（米） */
export const LAMP_HEIGHT_METERS = 4;
/** 灯杆与灯头用的色键 */
const LAMP_POLE_KEY = 'metal';
const LAMP_HEAD_KEY = 'lampGlow';
/** 断面带宽（格，单边）：只取沿长轴投影落在站位附近的格子来定路缘 */
const BAND_HALF_CELLS = 1.6;

export interface LampInput {
    grid: GridSystem;
    parcels: Parcel[];
    terrainTypes: Record<string, TerrainTypeDef>;
    /** 建筑足迹：灯不立在建筑里 */
    occupied: Set<string>;
}

export interface LampHandle {
    group: THREE.Group;
    /** 灯杆根数 */
    lampCount: number;
    /** 成对落位的组数（一侧有路灯、另一侧没有时不计入） */
    pairCount: number;
    applyTheme: (themeOrConfig: ThemeName | ThemeConfig) => void;
    dispose: () => void;
}

/** 路格集合的主轴（格心协方差的主特征向量）：不需要真的做特征分解，2×2 有闭式解 */
function principalAxis(cells: GridCell[]): { x: number; z: number; cx: number; cz: number } {
    let sx = 0;
    let sz = 0;
    for (const cell of cells) {
        sx += cell.vx + 0.5;
        sz += cell.vz + 0.5;
    }
    const cx = sx / cells.length;
    const cz = sz / cells.length;

    let xx = 0;
    let zz = 0;
    let xz = 0;
    for (const cell of cells) {
        const dx = cell.vx + 0.5 - cx;
        const dz = cell.vz + 0.5 - cz;
        xx += dx * dx;
        zz += dz * dz;
        xz += dx * dz;
    }

    const theta = 0.5 * Math.atan2(2 * xz, xx - zz);
    return { x: Math.cos(theta), z: Math.sin(theta), cx, cz };
}

export async function buildLamps(input: LampInput, slicer: Slicer): Promise<LampHandle> {
    const { grid, parcels, terrainTypes, occupied } = input;

    const pole = new VoxelModel();
    const head = new VoxelModel();
    const taken = new Set<string>();
    let lampCount = 0;
    let pairCount = 0;

    const spacingCells = Math.max(1, Math.round(LAMP_SPACING_METERS / grid.voxelMeters));
    const headY = Math.max(1, metersToVoxels(LAMP_HEIGHT_METERS, grid.voxelMeters));

    /** 立一盏灯：同一格只立一次（相邻两段路会在同一条路缘上重复取到同一格） */
    const place = (cell: GridCell): boolean => {
        const key = cellKey(cell.vx, cell.vz);
        if (taken.has(key) || occupied.has(key)) return false;
        taken.add(key);
        pole.set(cell.vx, 1, cell.vz, LAMP_POLE_KEY);
        head.set(cell.vx, headY, cell.vz, LAMP_HEAD_KEY);
        lampCount += 1;
        return true;
    };

    for (const parcel of parcels) {
        /* 一条地皮要跑轮廓栅格化 + 逐断面扫一遍路格：逐条让出（放在最前，跳过的地皮也照样让） */
        if (slicer.shouldYield()) await slicer.yield();

        const def = terrainTypes[parcel.typeKey];
        if (!def || !def.streetLamp) continue;

        const cells = clipToGrid(await rasterizeOutline(grid, parcel.outline, slicer), grid);
        if (cells.length === 0) continue;

        const axis = principalAxis(cells);

        /* 投影求长轴范围（u）与站位序列 */
        let uMin = Infinity;
        let uMax = -Infinity;
        for (const cell of cells) {
            const u =
                (cell.vx + 0.5 - axis.cx) * axis.x + (cell.vz + 0.5 - axis.cz) * axis.z;
            if (u < uMin) uMin = u;
            if (u > uMax) uMax = u;
        }
        const mid = (uMin + uMax) / 2;

        for (let station = mid; station <= uMax; station += spacingCells) {
            const stations = station === mid ? [station] : [station, 2 * mid - station];

            for (const t of stations) {
                if (t < uMin || t > uMax) continue;

                /* 断面带内取 v 的两端，就是这一处的两条路缘 */
                let minV = Infinity;
                let maxV = -Infinity;
                let minCell: GridCell | null = null;
                let maxCell: GridCell | null = null;

                for (const cell of cells) {
                    const dx = cell.vx + 0.5 - axis.cx;
                    const dz = cell.vz + 0.5 - axis.cz;
                    const u = dx * axis.x + dz * axis.z;
                    if (Math.abs(u - t) > BAND_HALF_CELLS) continue;

                    const v = -dx * axis.z + dz * axis.x;
                    if (v < minV) {
                        minV = v;
                        minCell = cell;
                    }
                    if (v > maxV) {
                        maxV = v;
                        maxCell = cell;
                    }
                }

                if (!minCell || !maxCell) continue;
                const first = place(minCell);
                /* 单格宽的路两侧是同一格，此时只立一盏 */
                const second = minCell === maxCell ? false : place(maxCell);
                if (first && second) pairCount += 1;
            }
        }
    }

    /* ---------- 装配 ---------- */
    const slotOf = createSlotLookup();
    const poleMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.5,
        metalness: 0.5,
        flatShading: true
    });
    const headMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.35,
        metalness: 0,
        flatShading: true
    });

    const poleMesh = await createVoxelMesh(await pole.toArray(slicer), poleMaterial, slotOf, slicer, {
        castShadow: true
    });
    poleMesh.mesh.name = 'lampPoles';
    const headMesh = await createVoxelMesh(await head.toArray(slicer), headMaterial, slotOf, slicer, {
        castShadow: false
    });
    headMesh.mesh.name = 'lampHeads';
    /* 灯头是自发光的透明感来源，排在最后画，避免被水面的透明排序盖住 */
    headMesh.mesh.renderOrder = 3;

    const group = new THREE.Group();
    group.name = 'streetLamps';
    group.add(poleMesh.mesh, headMesh.mesh);

    function applyTheme(next: ThemeName | ThemeConfig): void {
        const config = resolveThemeConfig(next);
        poleMaterial.roughness = config.material.roughness;
        /* 灯头自发光不走调色板（它只作用在漫反射色上），因此这里单独给 */
        headMaterial.emissive.setHex(config.voxel[LAMP_HEAD_KEY]);
        headMaterial.emissiveIntensity = config.lamp.emissiveIntensity;
    }

    function dispose(): void {
        poleMaterial.dispose();
        headMaterial.dispose();
    }

    return { group, lampCount, pairCount, applyTheme, dispose };
}
