/** 塔楼：台基 + 细高墙体 + 逐层收分冠部 + 尖顶宝顶，校园里最强的识别物（钟楼） */

import { addPlinth, bodyLayersFor, type MassingBuilder } from './context';
import { boundsOf, perimeterCells, type GridCell } from '../rasterize';

export const buildTower: MassingBuilder = (context) => {
    const { model, cells } = context;
    const plinthY = addPlinth(model, cells, context.groundY);
    const bodyBase = plinthY + 1;
    const bodyTop = bodyBase + bodyLayersFor(context.totalVoxels) - 1;

    for (const { vx, vz } of cells) {
        for (let y = bodyBase; y <= bodyTop; y++) model.set(vx, y, vz, 'wall');
    }

    /* 塔身通高开窗，形成竖向节奏 */
    const rim = perimeterCells(cells);
    for (let y = bodyBase + 1; y <= bodyTop - 1; y++) {
        if (y % 2 !== 0) continue;
        for (const { vx, vz } of rim) {
            model.set(vx, y, vz, y % 6 === 0 ? 'glassLit' : 'glass');
        }
    }

    /* 冠部：逐层收进 */
    let crown: GridCell[] = cells;
    let y = bodyTop + 1;
    while (crown.length > 1) {
        const { minVx, maxVx, minVz, maxVz } = boundsOf(crown);
        crown = crown.filter((cell) => cell.vx > minVx && cell.vx < maxVx && cell.vz > minVz && cell.vz < maxVz);
        if (crown.length === 0) break;
        for (const { vx, vz } of crown) model.set(vx, y, vz, 'roof');
        y++;
    }

    /* 尖顶与宝顶 */
    const cx = Math.round(cells.reduce((sum, cell) => sum + cell.vx, 0) / cells.length);
    const cz = Math.round(cells.reduce((sum, cell) => sum + cell.vz, 0) / cells.length);
    model.column(cx, cz, y, y + 2, 'metal');
    model.set(cx, y + 3, cz, 'gold');

    return y + 3;
};
