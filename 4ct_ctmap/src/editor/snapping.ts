/* ================================================================
   捕捉（snapping）
   —— 【口径】默认开启、可一键关；捕捉目标 = 其他对象的顶点与线段，
      以及正在编辑对象**自身除被拖顶点之外**的顶点与线段。
      （自身也要捕：把相邻地皮的公共边对齐，靠的就是捕到自己的邻点。）

      优先级与 ArcMap 一致：**顶点优先于线段** —— 顶点是人的明确意图，
      线段只是「挨着」，同时命中时应当吸到顶点。

      【为什么容差要分两类】
      顶点工具的「悬停捕捉符号」必须和「按下去能抓到什么」用完全相同的半径，
      否则会出现「符号指着某个顶点、按下去却什么也没抓到」，甚至误切到下面的对象。
      因此 grab 类容差直接复用 hitTest 的命中半径；
      而新建要素时只是落点、没有抓取动作，用统一且略宽松的半径更顺手。
================================================================ */

import { SEGMENT_HIT_PIXELS, VERTEX_HIT_PIXELS } from './hitTest';
import type { EditorTarget, ShapeMeters } from './editorTypes';
import type { MeterPoint } from './projection';

/** 落点（新建要素）时的捕捉半径（像素），与 ArcMap 的 10 px 一致 */
export const SNAP_PIXEL_TOLERANCE = 10;

export type SnapKind = 'vertex' | 'edge';

/** 顶点与线段各自一个容差（米），由调用方按当前视图比例换算 */
export interface SnapTolerance {
    vertex: number;
    edge: number;
}

export interface SnapResult {
    kind: SnapKind;
    /** 吸附后的位置（线段捕捉时是垂足） */
    point: MeterPoint;
    target: EditorTarget;
    /** 顶点捕捉：顶点序号；线段捕捉：线段起点序号 */
    index: number;
}

/** 被拖动/被排除的那个顶点：它自身与它两侧的线段都不参与捕捉 */
export interface SnapExclusion {
    target: EditorTarget;
    vertexIndex: number;
}

function sameTarget(a: EditorTarget, b: EditorTarget): boolean {
    if (a.kind !== b.kind) return false;
    return a.kind === 'island' || b.kind === 'island' ? true : a.id === (b as { id: string }).id;
}

/** 该线段是否碰到被排除的顶点（被拖顶点两侧的线段必须排除，否则会把点吸回原位） */
function segmentTouchesExclusion(
    shape: ShapeMeters,
    index: number,
    exclusion: SnapExclusion | null
): boolean {
    if (!exclusion || !sameTarget(shape.target, exclusion.target)) return false;

    const count = shape.meters.length;
    const next = (index + 1) % count;
    return index === exclusion.vertexIndex || next === exclusion.vertexIndex;
}

function isExcludedVertex(
    shape: ShapeMeters,
    index: number,
    exclusion: SnapExclusion | null
): boolean {
    return (
        exclusion !== null &&
        sameTarget(shape.target, exclusion.target) &&
        index === exclusion.vertexIndex
    );
}

/** 点到线段的最短距离与垂足 */
function projectOnSegment(
    point: MeterPoint,
    a: MeterPoint,
    b: MeterPoint
): { distance: number; foot: MeterPoint } {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;

    if (lengthSq === 0) {
        return { distance: Math.hypot(point.x - a.x, point.y - a.y), foot: a };
    }

    /* 参数 t 夹到 [0, 1]：线段之外的部分不算，否则会吸到线段的延长线上 */
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
    const foot = { x: a.x + t * dx, y: a.y + t * dy };
    return { distance: Math.hypot(point.x - foot.x, point.y - foot.y), foot };
}

/**
 * 在候选里找最近的捕捉点。
 * 顶点与线段各用各的容差，且顶点优先 —— 见文件头对容差口径的说明。
 */
export function findSnap(
    cursor: MeterPoint,
    shapes: readonly ShapeMeters[],
    tolerance: SnapTolerance,
    exclusion: SnapExclusion | null = null
): SnapResult | null {
    let bestVertex: SnapResult | null = null;
    let bestVertexDistance = tolerance.vertex;

    for (const shape of shapes) {
        shape.meters.forEach((point, index) => {
            if (isExcludedVertex(shape, index, exclusion)) return;
            const distance = Math.hypot(point.x - cursor.x, point.y - cursor.y);
            if (distance > bestVertexDistance) return;

            bestVertexDistance = distance;
            bestVertex = { kind: 'vertex', point, target: shape.target, index };
        });
    }

    if (bestVertex) return bestVertex;

    let bestEdge: SnapResult | null = null;
    let bestEdgeDistance = tolerance.edge;

    for (const shape of shapes) {
        const count = shape.meters.length;
        if (count < 2) continue;

        for (let index = 0; index < count; index += 1) {
            if (segmentTouchesExclusion(shape, index, exclusion)) continue;

            const a = shape.meters[index];
            const b = shape.meters[(index + 1) % count];
            const { distance, foot } = projectOnSegment(cursor, a, b);
            if (distance > bestEdgeDistance) continue;

            bestEdgeDistance = distance;
            bestEdge = { kind: 'edge', point: foot, target: shape.target, index };
        }
    }

    return bestEdge;
}

/**
 * 把像素容差换算成米。
 * `grab` = 顶点工具（要能抓到），复用命中半径，保证捕捉符号不说谎；
 * `place` = 新建要素（只是落点），统一用 SNAP_PIXEL_TOLERANCE。
 */
export function snapTolerance(scale: number, kind: 'grab' | 'place'): SnapTolerance {
    if (kind === 'place') {
        const meters = SNAP_PIXEL_TOLERANCE / scale;
        return { vertex: meters, edge: meters };
    }
    return {
        vertex: VERTEX_HIT_PIXELS / scale,
        edge: SEGMENT_HIT_PIXELS / scale
    };
}
