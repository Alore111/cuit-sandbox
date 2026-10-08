/* ================================================================
   视图变换：屏幕像素 ↔ 本地米
   —— 【口径】「浏览视图」与「编辑手势」分开之后，视图是一个可以自由
      缩放/平移的独立状态；本文件是它唯一的算法出处。
      变换一律保持等比例（不做 x/y 独立缩放）：轮廓的夹角必须是真的。
================================================================ */

import type { MeterPoint } from './projection';

/** 画布尺寸（CSS 像素） */
export interface Viewport {
    width: number;
    height: number;
}

/** 视图：中心（本地米）+ 比例（像素/米） */
export interface ViewTransform {
    cx: number;
    cy: number;
    scale: number;
}

/** 缩放上下限（像素/米）：1 px ≈ 20 m 到 1 px ≈ 1.25 cm，覆盖「看整座岛」到「抠一个顶点」 */
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 80;

/** 自动适配时在包围盒外留的余量比例（相对包围盒尺寸） */
export const FIT_PADDING_RATIO = 0.08;
/** 自动适配的最小视野（米）：刚点出来的小方块也要有足够精度 */
export const MIN_FIT_SPAN_METERS = 60;

/** 每格滚轮的缩放系数（ArcMap 的滚轮是分级缩放，这里用固定比例更跟手） */
export const WHEEL_ZOOM_STEP = 1.18;

export function clampScale(scale: number): number {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** 把手感上的缩放范围收敛到合法区间 */
function normalize(view: ViewTransform): ViewTransform {
    const scale = clampScale(view.scale);
    return scale === view.scale ? view : { ...view, scale };
}

/** 屏幕像素 → 本地米 */
export function toMeters(
    view: ViewTransform,
    viewport: Viewport,
    px: number,
    py: number
): MeterPoint {
    return {
        x: (px - viewport.width / 2) / view.scale + view.cx,
        y: (viewport.height / 2 - py) / view.scale + view.cy
    };
}

/** 本地米 → 屏幕像素 */
export function toScreen(
    view: ViewTransform,
    viewport: Viewport,
    point: MeterPoint
): { x: number; y: number } {
    return {
        x: (point.x - view.cx) * view.scale + viewport.width / 2,
        y: viewport.height / 2 - (point.y - view.cy) * view.scale
    };
}

/**
 * 以某个屏幕点为锚点缩放（滚轮缩放的正确做法）：
 * 锚点下的地理坐标在缩放前后必须原地不动，否则放大时内容会「跑掉」。
 */
export function zoomAt(
    view: ViewTransform,
    viewport: Viewport,
    anchorPx: number,
    anchorPy: number,
    factor: number
): ViewTransform {
    const next = normalize({ ...view, scale: view.scale * factor });
    const before = toMeters(view, viewport, anchorPx, anchorPy);
    const after = toMeters(next, viewport, anchorPx, anchorPy);

    return { cx: next.cx + (before.x - after.x), cy: next.cy + (before.y - after.y), scale: next.scale };
}

/** 按屏幕像素位移平移视图 */
export function panBy(view: ViewTransform, dxPx: number, dyPx: number): ViewTransform {
    return {
        cx: view.cx - dxPx / view.scale,
        cy: view.cy + dyPx / view.scale,
        scale: view.scale
    };
}

/** 把一组本地米点适配到视口内（留 FIT_PADDING_RATIO 的余量） */
export function fitPoints(points: MeterPoint[], viewport: Viewport): ViewTransform {
    if (points.length === 0 || viewport.width === 0 || viewport.height === 0) {
        return { cx: 0, cy: 0, scale: 1 };
    }

    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    const spanX = Math.max(MIN_FIT_SPAN_METERS, (maxX - minX) * (1 + FIT_PADDING_RATIO * 2));
    const spanY = Math.max(MIN_FIT_SPAN_METERS, (maxY - minY) * (1 + FIT_PADDING_RATIO * 2));

    return {
        cx: (minX + maxX) / 2,
        cy: (minY + maxY) / 2,
        scale: clampScale(Math.min(viewport.width / spanX, viewport.height / spanY))
    };
}

/** 相对当前视图做一次缩放（工具栏的「放大 / 缩小」按钮，锚点是视口中心） */
export function zoomByFactor(view: ViewTransform, factor: number): ViewTransform {
    return normalize({ ...view, scale: view.scale * factor });
}
