/* ================================================================
   多边形 → 体素格栅格化
   —— 判断在多边形自己的坐标空间里做：格心是否落在轮廓内，用射线法逐格判。
      建筑轮廓与地皮轮廓共用这一套，凡是「多边形占地」都走这里。

   【分帧】本模块的三个函数都跑在整块网格上（数十万格），是构建长任务的组成部分：
      一律按扫描行 / 批量让出主线程（slicer），让加载动画在这段时间里继续出帧。
      其余函数（裁剪、膨胀、腐蚀、求包围盒）都只走一遍传入的格集合，量级小一个数量级，
      保持同步。
================================================================ */

import type { LonLat } from '../../contract';
import { isInsidePolygon, toLocalPolygon, type GridSystem } from '../../utils/geo';
import { HOT_LOOP_SPAN, type Slicer } from '../scheduler';

export interface GridCell {
    vx: number;
    vz: number;
}

export interface CellBounds {
    minVx: number;
    maxVx: number;
    minVz: number;
    maxVz: number;
}

export function cellKey(vx: number, vz: number): string {
    return `${vx}|${vz}`;
}

/** 四邻域偏移：膨胀、腐蚀、找边界格都基于同一份定义 */
const NEIGHBOURS: readonly (readonly [number, number])[] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1]
];

/** 经纬度轮廓 → 体素格集合（未裁剪，可能超出网格范围） */
export async function rasterizeOutline(
    grid: GridSystem,
    outline: LonLat[],
    slicer: Slicer
): Promise<GridCell[]> {
    const polygon = toLocalPolygon(outline, grid.origin);

    /* 先求轮廓的体素包围盒。注意 vz 是「向南增大」：
       多边形最小的 y（最北）对应最大的 vz，所以四个边界必须各自取 min/max，
       不能拿「左上角」与「右下角」两次换算的结果当区间端点 —— 那样会得到空区间。 */
    const corners = polygon.map((point) => grid.localToVoxel(point));
    const vx0 = Math.floor(Math.min(...corners.map((c) => c.vx))) - 1;
    const vx1 = Math.ceil(Math.max(...corners.map((c) => c.vx))) + 1;
    const vz0 = Math.floor(Math.min(...corners.map((c) => c.vz))) - 1;
    const vz1 = Math.ceil(Math.max(...corners.map((c) => c.vz))) + 1;

    const cells: GridCell[] = [];
    for (let vz = vz0; vz <= vz1; vz++) {
        for (let vx = vx0; vx <= vx1; vx++) {
            const point = grid.voxelToLocal(vx, vz);
            if (isInsidePolygon(point.x, point.y, polygon)) cells.push({ vx, vz });
        }
        /* 一行就是一轮「轮廓点数 × 行宽」的射线测试，按行让出 */
        if (slicer.shouldYield()) await slicer.yield();
    }
    return cells;
}

/** 裁到网格范围内：网格是沙盘板的边界，板外的格子不存在 */
export function clipToGrid(cells: GridCell[], grid: GridSystem): GridCell[] {
    return cells.filter(
        ({ vx, vz }) => vx >= 0 && vz >= 0 && vx < grid.width && vz < grid.height
    );
}

/** 四邻域膨胀：把足迹向外扩一圈，得到出檐屋面 */
export function dilate(cells: GridCell[]): GridCell[] {
    const grown = new Map<string, GridCell>();
    for (const { vx, vz } of cells) {
        grown.set(cellKey(vx, vz), { vx, vz });
        for (const [dx, dz] of NEIGHBOURS) {
            grown.set(cellKey(vx + dx, vz + dz), { vx: vx + dx, vz: vz + dz });
        }
    }
    return [...grown.values()];
}

/**
 * 四邻域腐蚀：只保留四邻都在集合内的格，即整体向内收一圈。
 * 拱顶、冠部这类「逐层收进」的形制用它，形状才能跟着建筑轮廓走；
 * 若改成在包围盒里逐层收矩形，异形平面（圆角、L 形）的屋顶会长成一块方板。
 */
export function erode(cells: GridCell[]): GridCell[] {
    const occupied = new Set(cells.map((cell) => cellKey(cell.vx, cell.vz)));
    return cells.filter(({ vx, vz }) =>
        NEIGHBOURS.every(([dx, dz]) => occupied.has(cellKey(vx + dx, vz + dz)))
    );
}

/** 足迹的边界格（至少一侧邻格不在足迹内）：窗带、矮栏只贴在这些格上 */
export function perimeterCells(cells: GridCell[]): GridCell[] {
    const occupied = new Set(cells.map((cell) => cellKey(cell.vx, cell.vz)));
    return cells.filter(({ vx, vz }) =>
        NEIGHBOURS.some(([dx, dz]) => !occupied.has(cellKey(vx + dx, vz + dz)))
    );
}

export function boundsOf(cells: GridCell[]): CellBounds {
    const xs = cells.map((cell) => cell.vx);
    const zs = cells.map((cell) => cell.vz);
    return {
        minVx: Math.min(...xs),
        maxVx: Math.max(...xs),
        minVz: Math.min(...zs),
        maxVz: Math.max(...zs)
    };
}

/**
 * 岛面格掩码：1 = 格心落在岛面轮廓内。
 * 地表与岛体倒锥共用这一份 —— 两边各跑一次多边形测试既慢又可能出现边界口径不一致。
 */
export async function buildIslandMask(grid: GridSystem, slicer: Slicer): Promise<Uint8Array> {
    const { width, height } = grid;
    const mask = new Uint8Array(width * height);
    for (let vz = 0; vz < height; vz++) {
        for (let vx = 0; vx < width; vx++) {
            if (grid.isInsideIsland(vx, vz)) mask[vz * width + vx] = 1;
        }
        if (slicer.shouldYield()) await slicer.yield();
    }
    return mask;
}

/**
 * 到岛缘的距离（格）：以所有「岛外」格为源做一次四邻域 BFS。
 * 岛缘格为 1，岛外为 0；倒锥剖面按这个距离场逐层收进，
 * 于是「上段近乎垂直的岛壁、下段收成尖」只由一条剖面曲线控制。
 */
export async function distanceToIslandEdge(
    mask: Uint8Array,
    width: number,
    height: number,
    slicer: Slicer
): Promise<Uint16Array> {
    const total = width * height;
    const dist = new Uint16Array(total).fill(0xffff);
    const queue = new Int32Array(total);
    let head = 0;
    let tail = 0;

    for (let i = 0; i < total; i++) {
        if (mask[i] === 0) {
            dist[i] = 0;
            queue[tail++] = i;
        }
        if (slicer.shouldYield(HOT_LOOP_SPAN)) await slicer.yield();
    }

    while (head < tail) {
        const at = queue[head++];
        const vx = at % width;
        const vz = (at - vx) / width;
        const next = dist[at] + 1;

        for (const [dx, dz] of NEIGHBOURS) {
            const nx = vx + dx;
            const nz = vz + dz;
            if (nx < 0 || nz < 0 || nx >= width || nz >= height) continue;
            const neighbour = nz * width + nx;
            if (dist[neighbour] <= next) continue;
            dist[neighbour] = next;
            queue[tail++] = neighbour;
        }
        /* 出队一次只反问四个邻居，属热循环：隔 HOT_LOOP_SPAN 次再读时钟 */
        if (slicer.shouldYield(HOT_LOOP_SPAN)) await slicer.yield();
    }

    return dist;
}
