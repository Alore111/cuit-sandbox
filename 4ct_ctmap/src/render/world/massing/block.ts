/** 板楼：台基 + 墙体 + 窗带 + 出檐屋面（校园里最常见的形制） */

import { addPlinth, bodyLayersFor, type MassingBuilder } from './context';
import { dilate, perimeterCells } from '../rasterize';

export const buildBlock: MassingBuilder = (context) => {
    const { model, cells, details, random } = context;
    const plinthY = addPlinth(model, cells, context.groundY);
    const bodyBase = plinthY + 1;
    const bodyTop = bodyBase + bodyLayersFor(context.totalVoxels) - 1;

    for (const { vx, vz } of cells) {
        for (let y = bodyBase; y <= bodyTop; y++) model.set(vx, y, vz, 'wall');
    }

    /* 窗带：贴外轮廓按间隔布一道，转角处自然形成体素立面的节奏 */
    const rim = perimeterCells(cells);
    for (let y = bodyBase + 1; y <= bodyTop - 1; y += details.windowBandInterval) {
        for (const { vx, vz } of rim) {
            model.set(vx, y, vz, random() > 0.68 ? 'glassLit' : 'glass');
        }
    }

    /* 屋面：膨胀一圈兼作出檐，只占一层，避免把楼高顶上去 */
    for (const { vx, vz } of dilate(cells)) model.set(vx, bodyTop + 1, vz, 'roof');

    return bodyTop + 1;
};
