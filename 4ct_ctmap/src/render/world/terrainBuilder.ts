/* ================================================================
   地表：由地皮多边形铺出场地
   —— 取代 DEMO 的「正射影像 HSV 分类 + OSM 场地覆盖」两级流程。
      现在的输入只有一份数据：地皮多边形（后端已按面积降序返回）。

   规则（口径）：
     1) 只在 island.outline 内铺地表 —— 岛面是一块校园形状的顶面，不是矩形；
     2) 岛面内先铺 defaultTerrainTypeKey（基础地面），再按地皮顺序「大盖小」盖章；
     3) 颜色在建模阶段就按坐标哈希从 paletteKeys 里挑好（挑色与主题无关），
        切主题时只把色键重新解析成新主题的颜色；
     4) 只铺 y = 0 这一层 —— 岛面之下交给 islandBuilder 的倒锥岩层，
        这里再堆土壤就会与岩层打架。
================================================================ */

import type { Parcel, TerrainTypeDef } from '../../contract';
import type { RenderWarning, WorldStats } from '../../types/world';
import type { GridSystem } from '../../utils/geo';
import { GROUND_Y, type DetailVoxels } from '../constants';
import type { Slicer } from '../scheduler';
import { hash2 } from '../voxel/random';
import type { VoxelColorKey } from '../theme/palette';
import { VoxelModel } from '../voxel/VoxelModel';
import { cellKey, clipToGrid, rasterizeOutline } from './rasterize';

/** 岛面之外的格子不铺地表 */
const OUTSIDE = -1;

export interface TerrainInput {
    grid: GridSystem;
    /** 岛面格掩码（1 = 格心在岛面内），与岛体倒锥共用同一份 */
    mask: Uint8Array;
    /** 已按面积降序（大盖小） */
    parcels: Parcel[];
    terrainTypes: Record<string, TerrainTypeDef>;
    defaultTerrainTypeKey: string;
    /** 建筑足迹：这些格子不抬树冠，避免树冠与建筑穿插 */
    occupied: Set<string>;
    details: DetailVoxels;
}

export interface TerrainResult {
    solid: VoxelModel;
    water: VoxelModel;
    /** 逐格地皮类型索引（OUTSIDE = 岛外）；装饰物据此判断「这格能不能长花草」 */
    classGrid: Int16Array;
    /** 索引 → 地皮类型 key */
    typeKeys: string[];
    warnings: RenderWarning[];
    stats: Pick<
        WorldStats,
        'islandCells' | 'terrainCellsByType' | 'spanMeters' | 'gridSize' | 'voxelMeters'
    >;
}

/** 岛外的格子在该表里的索引 */
export const OUTSIDE_TYPE_INDEX = OUTSIDE;

export async function buildTerrain(input: TerrainInput, slicer: Slicer): Promise<TerrainResult> {
    const { grid, mask, parcels, terrainTypes, defaultTerrainTypeKey, occupied, details } = input;
    const { width, height } = grid;

    /* ---------- 1. 类别网格 ---------- */
    const typeKeys: string[] = [];
    const indexByKey = new Map<string, number>();
    const indexOf = (key: string): number => {
        const existing = indexByKey.get(key);
        if (existing !== undefined) return existing;
        const index = typeKeys.length;
        typeKeys.push(key);
        indexByKey.set(key, index);
        return index;
    };

    const classGrid = new Int16Array(width * height).fill(OUTSIDE);
    let islandCells = 0;

    const defaultIndex = indexOf(defaultTerrainTypeKey);
    for (let vz = 0; vz < height; vz++) {
        for (let vx = 0; vx < width; vx++) {
            if (mask[vz * width + vx] === 0) continue;
            classGrid[vz * width + vx] = defaultIndex;
            islandCells++;
        }
        if (slicer.shouldYield()) await slicer.yield();
    }

    /* ---------- 2. 地皮盖章（大盖小） ---------- */
    const warnings: RenderWarning[] = [];

    for (const parcel of parcels) {
        const index = indexOf(parcel.typeKey);
        const raw = await rasterizeOutline(grid, parcel.outline, slicer);
        const cells = clipToGrid(raw, grid);
        let stamped = 0;

        for (const { vx, vz } of cells) {
            const at = vz * width + vx;
            /* 只在岛面内盖章：岛外的地皮不参与渲染 */
            if (classGrid[at] === OUTSIDE) continue;
            classGrid[at] = index;
            stamped++;
        }

        if (stamped === 0) {
            const label = parcel.name || terrainTypes[parcel.typeKey].label;
            warnings.push({
                id: parcel.id,
                kind: 'parcel',
                name: label,
                reason:
                    cells.length === 0
                        ? raw.length === 0
                            ? '轮廓在网格内一格都没有（多边形可能退化或自交）'
                            : `轮廓整条落在网格之外（多边形 ${raw.length} 格全在板外）`
                        : '轮廓完全落在岛面之外，未参与渲染'
            });
        }

        /* 地皮有 200 多条，轮廓栅格化与盖章逐条累计起来同样是长任务：逐条让出 */
        if (slicer.shouldYield()) await slicer.yield();
    }

    /* ---------- 3. 类别 → 体素 ---------- */
    const solid = new VoxelModel();
    const water = new VoxelModel();
    const terrainCellsByType: Record<string, number> = {};
    for (const key of Object.keys(terrainTypes)) terrainCellsByType[key] = 0;

    for (let vz = 0; vz < height; vz++) {
        for (let vx = 0; vx < width; vx++) {
            const index = classGrid[vz * width + vx];
            if (index === OUTSIDE) continue;

            const typeKey = typeKeys[index];
            const spec = terrainTypes[typeKey];
            terrainCellsByType[typeKey] += 1;

            /* 按坐标哈希在近似色里挑一个，形成 1 格粒度的色块感 */
            const pick = spec.paletteKeys[
                Math.floor(hash2(vx, vz) * spec.paletteKeys.length)
            ] as VoxelColorKey;

            if (spec.water) {
                /* 水面与地面齐平，只占一层 */
                water.set(vx, GROUND_Y, vz, pick);
            } else {
                solid.set(vx, GROUND_Y, vz, pick);
            }

            /* 林地抬起树冠：高度由哈希决定，避免整片林地一样高像块绿板 */
            if (spec.canopy && !occupied.has(cellKey(vx, vz))) {
                const roll = hash2(vx + 7919, vz + 104729);
                const canopyHeight =
                    roll > 0.86 ? details.canopyTallHeight : details.canopyHeight;
                for (let y = 1; y <= canopyHeight; y++) {
                    solid.set(vx, GROUND_Y + y, vz, roll > 0.45 ? 'canopy' : 'canopyHi');
                }
            }
        }
        if (slicer.shouldYield()) await slicer.yield();
    }

    return {
        solid,
        water,
        classGrid,
        typeKeys,
        warnings,
        stats: {
            voxelMeters: grid.voxelMeters,
            gridSize: { width, height },
            spanMeters: grid.spanMeters,
            islandCells,
            terrainCellsByType
        }
    };
}
