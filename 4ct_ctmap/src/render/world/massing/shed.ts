/** 单层大空间：台基 + 矮墙 + 沿 z 从两侧向屋脊逐层收进的双坡屋面（食堂、观测站） */

import { addPlinth, bodyLayersFor, type MassingBuilder } from './context';
import { ROOF_OVERHANG, roofEdgeRunFor, roofInsetAt } from '../../constants';
import { boundsOf, dilate, perimeterCells } from '../rasterize';

export const buildShed: MassingBuilder = (context) => {
    const { model, cells, random } = context;
    const plinthY = addPlinth(model, cells, context.groundY);
    const bodyBase = plinthY + 1;
    const bodyTop = bodyBase + bodyLayersFor(context.totalVoxels) - 1;

    for (const { vx, vz } of cells) {
        for (let y = bodyBase; y <= bodyTop; y++) model.set(vx, y, vz, 'wall');
    }

    for (const { vx, vz } of perimeterCells(cells)) {
        model.set(vx, bodyBase + 1, vz, random() > 0.5 ? 'glassLit' : 'glass');
    }

    /* 屋面：檐口外扩出檐，沿 z 按剖面一路收到脊（檐口缓、屋脊陡，不留平屋脊） */
    let roofBase = cells;
    for (let i = 0; i < ROOF_OVERHANG; i++) roofBase = dilate(roofBase);

    const { minVz, maxVz } = boundsOf(roofBase);
    const depth = maxVz - minVz + 1;
    const halfSpan = Math.max(1, Math.ceil(depth / 2));
    const edgeRun = roofEdgeRunFor(halfSpan);

    let inset = 0;
    let layers = 0;

    /* 每层先画再决定是否继续收；收到只剩一条屋脊就停，层数上限保证循环一定终止 */
    for (let guard = 0; guard <= halfSpan; guard++) {
        const y = bodyTop + 1 + layers;
        for (const { vx, vz } of roofBase) {
            if (vz < minVz + inset || vz > maxVz - inset) continue;
            model.set(vx, y, vz, 'roof');
        }

        const nextInset = inset + roofInsetAt(inset, halfSpan, edgeRun);
        if (nextInset * 2 >= depth) break;

        inset = nextInset;
        layers += 1;
    }

    return bodyTop + 1 + layers;
};
