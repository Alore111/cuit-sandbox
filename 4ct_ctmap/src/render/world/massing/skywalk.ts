/* ================================================================
   天桥（高架桥面）
   —— 高度与其他建筑同一套口径（floors × floorHeight 折算成格数），竖向分布为：
        顶部 deckThickness 格   → 桥面，水平范围 = 足迹的完整平面范围
        地面 → 桥面之下         → 按柱距均布的立柱
        桥面之上 railHeight 格  → 矮栏（会超出名义总高，同塔楼尖顶的处理）
      桥面两端悬空，不生成坡道与台阶 —— 桥不落地、也不与地面连通。

   没有台基、没有出檐屋面，因此不走 context 里的 addPlinth/bodyLayersFor。
================================================================ */

import { metersToVoxels } from '../../constants';
import { boundsOf, perimeterCells } from '../rasterize';
import { requireMetersParam, type MassingBuilder } from './context';

export const buildSkywalk: MassingBuilder = (context) => {
    const { model, cells, groundY, totalVoxels, voxelMeters } = context;

    const deckThickness = metersToVoxels(
        requireMetersParam(context.params, 'deckThicknessMeters', context),
        voxelMeters
    );
    const pillarSpacing = metersToVoxels(
        requireMetersParam(context.params, 'pillarSpacingMeters', context),
        voxelMeters
    );
    const pillarSize = metersToVoxels(
        requireMetersParam(context.params, 'pillarSizeMeters', context),
        voxelMeters
    );
    const railHeight = metersToVoxels(
        requireMetersParam(context.params, 'railHeightMeters', context),
        voxelMeters
    );

    const deckTop = groundY + totalVoxels;
    const deckBottom = deckTop - deckThickness + 1;

    if (deckBottom <= groundY + 1) {
        throw new Error(
            `${context.label} 的名义高度只有 ${totalVoxels} 格，桥面（厚 ${deckThickness} 格）之下放不下立柱：` +
                '请调大该栋的 floors/floorHeight，或调小类型字典里的 deckThicknessMeters'
        );
    }

    /* 桥面 */
    for (const { vx, vz } of cells) {
        for (let y = deckBottom; y <= deckTop; y++) model.set(vx, y, vz, 'wall');
    }

    /* 立柱：沿走向（足迹长边方向）均布，两端各落一根 */
    const { minVx, maxVx, minVz, maxVz } = boundsOf(cells);
    const alongX = maxVx - minVx >= maxVz - minVz;
    const alongStart = alongX ? minVx : minVz;
    const alongEnd = alongX ? maxVx : maxVz;

    const positions: number[] = [];
    for (let along = alongStart; along <= alongEnd; along += pillarSpacing) positions.push(along);
    if (positions[positions.length - 1] !== alongEnd) positions.push(alongEnd);

    for (const along of positions) {
        /* 立柱跟着足迹在该处的实际宽度走：取该处真正存在的格子，避免柱脚戳到桥面之外 */
        const column = cells.filter((cell) => (alongX ? cell.vx : cell.vz) === along);
        if (column.length === 0) continue;

        const acrossValues = column.map((cell) => (alongX ? cell.vz : cell.vx));
        const minAcross = Math.min(...acrossValues);
        const maxAcross = Math.max(...acrossValues);
        const acrossFrom = Math.round((minAcross + maxAcross - (pillarSize - 1)) / 2);

        for (let i = 0; i < pillarSize; i++) {
            const across = Math.min(Math.max(acrossFrom + i, minAcross), maxAcross);
            const vx = alongX ? along : across;
            const vz = alongX ? across : along;
            for (let y = groundY + 1; y < deckBottom; y++) model.set(vx, y, vz, 'roof');
        }
    }

    /* 矮栏：桥面边缘格在桥面之上再占 railHeight 层 */
    const rim = perimeterCells(cells);
    for (let i = 0; i < railHeight; i++) {
        const y = deckTop + 1 + i;
        for (const { vx, vz } of rim) model.set(vx, y, vz, 'trim');
    }

    return deckTop + railHeight;
};
