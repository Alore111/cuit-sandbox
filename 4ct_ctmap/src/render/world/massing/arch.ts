/**
 * 大跨体育场馆：台基 + 墙体 + 阶梯收进的拱顶。
 *
 * 【为什么对足迹做腐蚀，而不是在包围盒里收矩形】
 * 校园里的大跨场馆平面基本是圆角异形（体育馆、游泳馆都是），
 * 若在包围盒里逐层收矩形，屋顶会盖成一块方板、压在异形墙体之外 ——
 * 视觉上就是「建筑是不规则的，屋顶却是方的」。
 * 改成每层向内腐蚀一格，壳体形状自然跟着轮廓走。
 */

import { addPlinth, bodyLayersFor, type MassingBuilder } from './context';
import { ROOF_OVERHANG, roofEdgeRunFor, roofInsetAt } from '../../constants';
import { boundsOf, dilate, erode, perimeterCells } from '../rasterize';

export const buildArch: MassingBuilder = (context) => {
    const { model, cells, random } = context;
    const plinthY = addPlinth(model, cells, context.groundY);
    const bodyBase = plinthY + 1;
    const bodyTop = bodyBase + bodyLayersFor(context.totalVoxels) - 1;

    for (const { vx, vz } of cells) {
        for (let y = bodyBase; y <= bodyTop; y++) model.set(vx, y, vz, 'wall');
    }

    for (const { vx, vz } of perimeterCells(cells)) {
        model.set(vx, bodyBase + 1, vz, 'glass');
        model.set(vx, bodyBase + 3, vz, random() > 0.4 ? 'glassLit' : 'glass');
    }

    /* 屋面：檐口外扩 ROOF_OVERHANG 格（出檐），再按剖面一路收到顶 —— 檐口缓、中心陡，不留平顶 */
    let roofBase = cells;
    for (let i = 0; i < ROOF_OVERHANG; i++) roofBase = dilate(roofBase);

    const { minVx, maxVx, minVz, maxVz } = boundsOf(roofBase);
    const horizontalReach = Math.floor(
        Math.min(maxVx - minVx + 1, maxVz - minVz + 1) / 2
    );
    const edgeRun = roofEdgeRunFor(horizontalReach);

    /* 檐口一层铺满屋面基底 */
    for (const { vx, vz } of roofBase) model.set(vx, bodyTop + 1, vz, 'roof');

    let crown = roofBase;
    let apex = bodyTop + 1;
    let travelled = 0;

    /* 层数上限取水平可达距离 + 1：腐蚀一定能在这么多层内把足迹收空，循环必然终止 */
    for (let layer = 1; layer <= horizontalReach + 1; layer++) {
        const inset = roofInsetAt(travelled, horizontalReach, edgeRun);
        for (let i = 0; i < inset; i++) crown = erode(crown);
        if (crown.length === 0) break;

        travelled += inset;
        apex = bodyTop + 1 + layer;
        for (const { vx, vz } of crown) model.set(vx, apex, vz, 'roof');
    }

    return apex;
};
