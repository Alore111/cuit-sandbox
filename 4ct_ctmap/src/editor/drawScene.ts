/* ================================================================
   画布绘制
   —— 只负责「把当前状态画出来」，不做任何交互判断；
      图层顺序固定：底图 → 网格 → 岛面 → 地皮 → 建筑 → 草图 → 顶点把手 →
      捕捉符号 → 框选矩形（后画的压在前面）。

      【口径】所有颜色取自 CSS 令牌（tokens.css 的 --edit-* 一组），
      因此昼夜主题切换时画布跟着换色，组件里不出现硬编码颜色。
================================================================ */

import type {
    BaseMapMeta,
    EditorTarget,
    LayerVisibility,
    ShapeMeters
} from './editorTypes';
import type { EditorProjection, MeterPoint } from './projection';
import type { SnapResult } from './snapping';
import type { ViewTransform, Viewport } from './viewTransform';
import { toScreen } from './viewTransform';
import { drawBaseMap } from './baseMap';

/** 背景网格间距（米） */
export const GRID_METERS = 20;
/** 网格线密到这个像素间距以下就不画了（否则糊成一片） */
const GRID_MIN_PIXEL_STEP = 6;
/** 顶点把手边长（像素） */
const VERTEX_HANDLE_SIZE = 7;
/** 底图常态透明度：压暗一点，让矢量轮廓压在影像上仍然读得出来 */
const BASEMAP_ALPHA = 0.82;

export interface ScenePalette {
    background: string;
    gridLine: string;
    building: string;
    buildingFill: string;
    parcel: string;
    parcelFill: string;
    island: string;
    islandFill: string;
    selection: string;
    selectionGlow: string;
    sketch: string;
    snap: string;
    vertex: string;
    marqueeFill: string;
    border: string;
}

export function readScenePalette(): ScenePalette {
    const tokens = getComputedStyle(document.documentElement);
    const token = (name: string, fallback: string) =>
        tokens.getPropertyValue(name).trim() || fallback;

    return {
        background: token('--bg', '#05070e'),
        gridLine: token('--panel-border-strong', 'rgba(255,176,32,0.42)'),
        building: token('--edit-building', '#6ea8ff'),
        buildingFill: token('--edit-building-fill', 'rgba(110,168,255,0.18)'),
        parcel: token('--edit-parcel', '#57c9a0'),
        parcelFill: token('--edit-parcel-fill', 'rgba(87,201,160,0.16)'),
        island: token('--edit-island', '#9aa6bd'),
        islandFill: token('--edit-island-fill', 'rgba(154,166,189,0.08)'),
        selection: token('--amber', '#ffb020'),
        selectionGlow: token('--amber-glow', 'rgba(255,176,32,0.14)'),
        sketch: token('--edit-sketch', '#ff8a3d'),
        snap: token('--edit-snap', '#c07cff'),
        vertex: token('--edit-vertex', '#05070e'),
        marqueeFill: token('--edit-marquee', 'rgba(255,176,32,0.1)'),
        border: token('--panel-border', 'rgba(255,176,32,0.18)')
    };
}

/** 框选矩形（屏幕像素） */
export interface Marquee {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    /** true = 完全包含（左→右拖），false = 相交（右→左拖）—— 与 ArcGIS 一致 */
    window: boolean;
}

export interface SketchDraw {
    /** 已落下的草图顶点（本地米） */
    meters: MeterPoint[];
    /** 光标位置（本地米），用于画「下一段」的橡皮筋线 */
    cursor: MeterPoint | null;
    /** 光标处是否会被捕捉吸走（吸走了就不画自由橡皮筋） */
    snapped: boolean;
}

export interface SceneDrawOptions {
    ctx: CanvasRenderingContext2D;
    viewport: Viewport;
    view: ViewTransform;
    projection: EditorProjection;
    palette: ScenePalette;
    shapes: ShapeMeters[];
    visibility: LayerVisibility;
    basemap: { image: HTMLImageElement | null; meta: BaseMapMeta };
    selection: readonly EditorTarget[];
    /** 编辑草图所属的对象（顶点把手只给它画） */
    activeTarget: EditorTarget | null;
    selectedVertex: number | null;
    sketch: SketchDraw | null;
    snap: SnapResult | null;
    marquee: Marquee | null;
}

/* ----------------------------------------------------------------
   小工具
---------------------------------------------------------------- */

function targetId(target: EditorTarget): string {
    return target.kind === 'island' ? 'island' : `${target.kind}:${target.id}`;
}

function layerVisible(target: EditorTarget, visibility: LayerVisibility): boolean {
    if (target.kind === 'island') return visibility.island;
    if (target.kind === 'parcel') return visibility.parcels;
    return visibility.buildings;
}

function layerColors(
    target: EditorTarget,
    palette: ScenePalette
): { stroke: string; fill: string } {
    if (target.kind === 'island') return { stroke: palette.island, fill: palette.islandFill };
    if (target.kind === 'parcel') return { stroke: palette.parcel, fill: palette.parcelFill };
    return { stroke: palette.building, fill: palette.buildingFill };
}

function tracePolygon(
    ctx: CanvasRenderingContext2D,
    meters: MeterPoint[],
    view: ViewTransform,
    viewport: Viewport
): void {
    meters.forEach((point, index) => {
        const screen = toScreen(view, viewport, point);
        if (index === 0) ctx.moveTo(screen.x, screen.y);
        else ctx.lineTo(screen.x, screen.y);
    });
    ctx.closePath();
}

/* ----------------------------------------------------------------
   各图层
---------------------------------------------------------------- */

function drawGrid(ctx: CanvasRenderingContext2D, options: SceneDrawOptions): void {
    const { view, viewport, palette } = options;
    const step = GRID_METERS * view.scale;
    if (step < GRID_MIN_PIXEL_STEP) return;

    ctx.save();
    ctx.strokeStyle = palette.gridLine;
    ctx.globalAlpha = 0.22;
    ctx.lineWidth = 1;

    const origin = toScreen(view, viewport, { x: 0, y: 0 });
    for (let x = origin.x % step; x < viewport.width; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, viewport.height);
        ctx.stroke();
    }
    for (let y = origin.y % step; y < viewport.height; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(viewport.width, y);
        ctx.stroke();
    }
    ctx.restore();
}

function drawShapes(ctx: CanvasRenderingContext2D, options: SceneDrawOptions): void {
    const { view, viewport, palette, shapes, selection, activeTarget, visibility } = options;
    const selectedKeys = new Set(selection.map(targetId));
    const activeKey = activeTarget ? targetId(activeTarget) : null;

    for (const shape of shapes) {
        if (!layerVisible(shape.target, visibility)) continue;
        if (shape.meters.length < 2) continue;

        const key = targetId(shape.target);
        const colors = layerColors(shape.target, palette);
        const isActive = key === activeKey;
        const isSelected = selectedKeys.has(key);

        ctx.beginPath();
        tracePolygon(ctx, shape.meters, view, viewport);

        ctx.fillStyle = colors.fill;
        ctx.fill();

        if (isActive) {
            ctx.strokeStyle = palette.selection;
            ctx.lineWidth = 2.4;
        } else if (isSelected) {
            ctx.strokeStyle = palette.selection;
            ctx.lineWidth = 1.6;
        } else {
            ctx.strokeStyle = colors.stroke;
            ctx.lineWidth = 1.2;
        }

        /* 岛面轮廓点数多、范围大，用虚线避免喧宾夺主 */
        if (shape.target.kind === 'island') ctx.setLineDash([6, 6]);
        ctx.stroke();
        ctx.setLineDash([]);
    }
}

function drawVertices(ctx: CanvasRenderingContext2D, options: SceneDrawOptions): void {
    const { view, viewport, palette, shapes, activeTarget, selectedVertex } = options;
    if (!activeTarget) return;

    const shape = shapes.find((item) => targetId(item.target) === targetId(activeTarget));
    if (!shape) return;

    const half = VERTEX_HANDLE_SIZE / 2;

    shape.meters.forEach((point, index) => {
        const screen = toScreen(view, viewport, point);
        const active = index === selectedVertex;

        ctx.fillStyle = active ? palette.selection : palette.vertex;
        ctx.strokeStyle = palette.selection;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.rect(
            screen.x - (active ? half + 1 : half),
            screen.y - (active ? half + 1 : half),
            (active ? half + 1 : half) * 2,
            (active ? half + 1 : half) * 2
        );
        ctx.fill();
        ctx.stroke();
    });
}

function drawSketch(ctx: CanvasRenderingContext2D, options: SceneDrawOptions): void {
    const { view, viewport, palette, sketch } = options;
    if (!sketch || sketch.meters.length === 0) return;

    const screens = sketch.meters.map((point) => toScreen(view, viewport, point));

    ctx.save();
    ctx.strokeStyle = palette.sketch;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    screens.forEach((screen, index) => {
        if (index === 0) ctx.moveTo(screen.x, screen.y);
        else ctx.lineTo(screen.x, screen.y);
    });
    /* 橡皮筋：只有当光标没有被捕捉吸走时才画，否则会画出一条与捕捉结果不符的线 */
    if (sketch.cursor && !sketch.snapped) {
        ctx.setLineDash([5, 5]);
        const cursor = toScreen(view, viewport, sketch.cursor);
        ctx.lineTo(cursor.x, cursor.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    /* 已落下的点 */
    for (const screen of screens) {
        ctx.fillStyle = palette.vertex;
        ctx.strokeStyle = palette.sketch;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.rect(screen.x - 3.5, screen.y - 3.5, 7, 7);
        ctx.fill();
        ctx.stroke();
    }
    ctx.restore();
}

/** 捕捉符号：顶点用方块、线段用三角 —— 与 ArcGIS 的符号语义一致 */
function drawSnapMarker(ctx: CanvasRenderingContext2D, options: SceneDrawOptions): void {
    const { view, viewport, palette, snap } = options;
    if (!snap) return;

    const screen = toScreen(view, viewport, snap.point);
    const size = 5;

    ctx.save();
    ctx.strokeStyle = palette.snap;
    ctx.fillStyle = palette.snap;
    ctx.lineWidth = 1.8;

    if (snap.kind === 'vertex') {
        ctx.beginPath();
        ctx.rect(screen.x - size, screen.y - size, size * 2, size * 2);
        ctx.stroke();
    } else {
        ctx.beginPath();
        ctx.moveTo(screen.x, screen.y - size);
        ctx.lineTo(screen.x + size, screen.y + size);
        ctx.lineTo(screen.x - size, screen.y + size);
        ctx.closePath();
        ctx.stroke();
    }

    /* 十字准星：把「吸到了哪儿」钉死在一个像素级的位置上 */
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(screen.x - size * 2.2, screen.y);
    ctx.lineTo(screen.x + size * 2.2, screen.y);
    ctx.moveTo(screen.x, screen.y - size * 2.2);
    ctx.lineTo(screen.x, screen.y + size * 2.2);
    ctx.stroke();
    ctx.restore();
}

function drawMarquee(ctx: CanvasRenderingContext2D, options: SceneDrawOptions): void {
    const { palette, marquee } = options;
    if (!marquee) return;

    const x = Math.min(marquee.x0, marquee.x1);
    const y = Math.min(marquee.y0, marquee.y1);
    const w = Math.abs(marquee.x1 - marquee.x0);
    const h = Math.abs(marquee.y1 - marquee.y0);

    ctx.save();
    ctx.fillStyle = palette.marqueeFill;
    ctx.fillRect(x, y, w, h);

    ctx.strokeStyle = palette.selection;
    ctx.lineWidth = 1.2;
    /* 实线 = 完全包含，虚线 = 相交：拖动方向不同，选择规则不同，边框样式必须跟着变 */
    ctx.setLineDash(marquee.window ? [] : [5, 4]);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
}

/* ----------------------------------------------------------------
   入口
---------------------------------------------------------------- */

export function drawScene(options: SceneDrawOptions): void {
    const { ctx, viewport, palette, visibility, basemap, projection, view } = options;

    /* 调用方已经把 dpr 变换设好，这里一律按 CSS 像素作图 */
    ctx.clearRect(0, 0, viewport.width, viewport.height);
    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, viewport.width, viewport.height);

    if (visibility.basemap && basemap.image) {
        ctx.save();
        ctx.globalAlpha = BASEMAP_ALPHA;
        drawBaseMap({
            ctx,
            image: basemap.image,
            meta: basemap.meta,
            projection,
            view,
            viewport
        });
        ctx.restore();
    }

    if (visibility.grid) drawGrid(ctx, options);

    drawShapes(ctx, options);
    drawSketch(ctx, options);
    drawVertices(ctx, options);
    drawSnapMarker(ctx, options);
    drawMarquee(ctx, options);
}
