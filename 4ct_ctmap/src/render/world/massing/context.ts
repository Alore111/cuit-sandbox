/* ================================================================
   体量做法的公共上下文
   —— 每种做法只拿到「足迹、地面层、名义总层数、参数、随机源」，
      自己决定台基/墙体/屋面怎么堆，因此天桥这种「没有台基与出屋面」的做法
      也不需要在外层加特判。
================================================================ */

import type { MassingParams } from '../../../contract';
import type { DetailVoxels } from '../../constants';
import { MIN_BODY_LAYERS, PLINTH_LAYERS, ROOF_LAYERS } from '../../constants';
import type { VoxelModel } from '../../voxel/VoxelModel';
import type { GridCell } from '../rasterize';

export interface MassingContext {
    model: VoxelModel;
    /** 已裁到网格内的足迹格 */
    cells: GridCell[];
    /** 地面层号（地表体素所在层） */
    groundY: number;
    /** 地面以上名义总层数：由推定高度折算，并按结构下限 clamp */
    totalVoxels: number;
    params: MassingParams;
    voxelMeters: number;
    details: DetailVoxels;
    /** 确定性随机（窗灯亮灭用），同一份数据每次刷新结果一致 */
    random: () => number;
    /** 供报错信息定位是哪栋楼 */
    label: string;
}

/** @returns 实际生成的最高顶点（体素层号）；冠部与矮栏等超出名义高度的部分照实返回 */
export type MassingBuilder = (context: MassingContext) => number;

/** 板楼类的墙体层数 = 名义总层数 − 台基 − 屋面 */
export function bodyLayersFor(totalVoxels: number): number {
    return Math.max(MIN_BODY_LAYERS, totalVoxels - PLINTH_LAYERS - ROOF_LAYERS);
}

/** 台基：足迹本身铺一层，让建筑「从地里长出来」而不是浮在草皮上 */
export function addPlinth(model: VoxelModel, cells: GridCell[], groundY: number): number {
    const y = groundY + 1;
    for (const { vx, vz } of cells) model.set(vx, y, vz, 'plinth');
    return y;
}

/** 取以米为单位的几何参数；缺参数直接报错，不猜默认值 */
export function requireMetersParam(params: MassingParams, key: string, context: MassingContext): number {
    const value = params[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new Error(
            `${context.label} 的体量做法缺少合法参数「${key}」：请在该建筑类型字典的 massingParams 里补上（单位：米）`
        );
    }
    return value;
}
