/* ================================================================
   命中测试（纯函数，全部在本地米坐标下计算）
   —— 命中半径以**像素**定义，由调用方按当前视图比例换算成米传进来，
      因此放大后能精确点到顶点，缩小后也不会「点到隔壁楼」。

      优先级：顶点 > 线段 > 面。选面时**反序遍历**（后画的压在上面），
      与绘制的压盖顺序一致 —— 否则点击建筑会被底下的地皮抢走。
================================================================ */

import type { EditorTarget, SegmentHit, ShapeMeters, VertexHit } from './editorTypes';
import type { MeterPoint } from './projection';

/** 顶点命中半径（像素） */
export const VERTEX_HIT_PIXELS = 9;
/** 线段命中半径（像素）：比顶点小，避免「想插点却选中了面」 */
export const SEGMENT_HIT_PIXELS = 6;

export interface MeterRect {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

/** 最近顶点 */
export function hitVertex(
    shapes: readonly ShapeMeters[],
    cursor: MeterPoint,
    toleranceMeters: number
): VertexHit | null {
    let best: VertexHit | null = null;
    let bestDistance = toleranceMeters;

    /* 反序：上层对象优先命中 */
    for (let s = shapes.length - 1; s >= 0; s -= 1) {
        const shape = shapes[s];
        shape.meters.forEach((point, index) => {
            const distance = Math.hypot(point.x - cursor.x, point.y - cursor.y);
            if (distance > bestDistance) return;
            bestDistance = distance;
            best = { target: shape.target, index };
        });
    }

    return best;
}

/** 最近的线段及其垂足 */
export function hitSegment(
    shapes: readonly ShapeMeters[],
    cursor: MeterPoint,
    toleranceMeters: number
): SegmentHit | null {
    let best: SegmentHit | null = null;
    let bestDistance = toleranceMeters;

    for (let s = shapes.length - 1; s >= 0; s -= 1) {
        const shape = shapes[s];
        const count = shape.meters.length;
        if (count < 2) continue;

        for (let index = 0; index < count; index += 1) {
            const a = shape.meters[index];
            const b = shape.meters[(index + 1) % count];

            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const lengthSq = dx * dx + dy * dy;
            const t =
                lengthSq === 0
                    ? 0
                    : Math.max(0, Math.min(1, ((cursor.x - a.x) * dx + (cursor.y - a.y) * dy) / lengthSq));
            const foot = { x: a.x + t * dx, y: a.y + t * dy };
            const distance = Math.hypot(cursor.x - foot.x, cursor.y - foot.y);

            if (distance > bestDistance) continue;
            bestDistance = distance;
            best = { target: shape.target, index, point: foot };
        }
    }

    return best;
}

/** 点是否在多边形内（射线法） */
export function pointInShape(point: MeterPoint, meters: readonly MeterPoint[]): boolean {
    let inside = false;
    for (let i = 0, j = meters.length - 1; i < meters.length; j = i++) {
        const a = meters[i];
        const b = meters[j];
        if (
            a.y > point.y !== b.y > point.y &&
            point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
        ) {
            inside = !inside;
        }
    }
    return inside;
}

/** 命中的面（最上面那个）；点不到任何面时返回 null。
 *  注意：调用方需自行按图层可见性过滤 shapes。 */
export function hitShape(
    shapes: readonly ShapeMeters[],
    cursor: MeterPoint
): EditorTarget | null {
    for (let s = shapes.length - 1; s >= 0; s -= 1) {
        if (pointInShape(cursor, shapes[s].meters)) return shapes[s].target;
    }
    return null;
}

/** 命中间重叠的所有面（按绘制顺序从上层到下层排序）；未命中时返回空数组。
 *  注意：调用方需自行按图层可见性过滤 shapes。 */
export function hitAllShapes(
    shapes: readonly ShapeMeters[],
    cursor: MeterPoint
): EditorTarget[] {
    const hits: EditorTarget[] = [];
    /* 反序遍历：后绘制（上层）的先入结果，与绘制压盖顺序一致 */
    for (let s = shapes.length - 1; s >= 0; s -= 1) {
        if (pointInShape(cursor, shapes[s].meters)) {
            hits.push(shapes[s].target);
        }
    }
    return hits;
}

/* ----------------------------------------------------------------
   框选
---------------------------------------------------------------- */

function pointInRect(point: MeterPoint, rect: MeterRect): boolean {
    return point.x >= rect.minX && point.x <= rect.maxX && point.y >= rect.minY && point.y <= rect.maxY;
}

/** 线段相交（标准跨立试验） */
function segmentsIntersect(a: MeterPoint, b: MeterPoint, c: MeterPoint, d: MeterPoint): boolean {
    const cross = (o: MeterPoint, p: MeterPoint, q: MeterPoint) =>
        (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);

    const d1 = cross(c, d, a);
    const d2 = cross(c, d, b);
    const d3 = cross(a, b, c);
    const d4 = cross(a, b, d);

    return d1 * d2 < 0 && d3 * d4 < 0;
}

function shapeIntersectsRect(meters: readonly MeterPoint[], rect: MeterRect): boolean {
    const count = meters.length;
    if (count === 0) return false;

    /* 1) 有顶点落在框里 */
    if (meters.some((point) => pointInRect(point, rect))) return true;
    if (count < 2) return false;

    const corners: MeterPoint[] = [
        { x: rect.minX, y: rect.minY },
        { x: rect.maxX, y: rect.minY },
        { x: rect.maxX, y: rect.maxY },
        { x: rect.minX, y: rect.maxY }
    ];

    /* 2) 有边穿过框边（两边各有一个端点在框外，且真正相交） */
    for (let i = 0; i < count; i += 1) {
        const a = meters[i];
        const b = meters[(i + 1) % count];
        for (let c = 0; c < corners.length; c += 1) {
            const p = corners[c];
            const q = corners[(c + 1) % corners.length];
            if (segmentsIntersect(a, b, p, q)) return true;
        }
    }

    /* 3) 框整个落在图形内部：此时既没有顶点在框里、也没有边穿过框边，
          但「相交」显然成立（大地皮包住小选框就是这个情形），必须单独判一次 */
    return pointInShape(
        { x: (rect.minX + rect.maxX) / 2, y: (rect.minY + rect.maxY) / 2 },
        meters
    );
}

/**
 * 框选命中的对象。
 * `window = true`（左→右拖）：**完全包含**才选中 —— 用于「只挑这块区域里的要素」；
 * `window = false`（右→左拖）：**相交**即选中 —— 用于「把擦边的也带上」。
 * 这条方向约定是 ArcGIS 的既有习惯，照搬以免用惯 ArcMap 的人踩坑。
 */
export function shapesInMarquee(
    shapes: readonly ShapeMeters[],
    rect: MeterRect,
    window: boolean
): EditorTarget[] {
    const hits: EditorTarget[] = [];

    for (const shape of shapes) {
        const matched = window
            ? shape.meters.length > 0 && shape.meters.every((point) => pointInRect(point, rect))
            : shapeIntersectsRect(shape.meters, rect);
        if (matched) hits.push(shape.target);
    }

    return hits;
}
