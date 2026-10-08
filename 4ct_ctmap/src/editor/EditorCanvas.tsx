/* ================================================================
   编辑画布（ArcMap 式的二维编辑面）
   —— 【口径】「浏览视图」与「编辑手势」分成两套工具：
        · 视图（缩放 / 平移）在**任何**工具下都能用（滚轮、中键、空格或 Alt 拖）；
        · 数据改动只在「选择 / 编辑顶点 / 新建要素」下发生，并落进撤销栈。
      视图状态留在本组件里（不往父级提）：平移缩放是逐帧的，提上去会把
      整页（含两千行的图层树）跟着重渲染；需要外部驱动时走 ref 暴露的命令。

      两条实现口径沿用一期：
      1) 拖动一律「相对手势开始时的快照」计算，不叠加到上一次结果上 ——
         指针事件可能在同一帧连发多次（React 还没重渲染），叠加会丢步；
      2) 拖动过程中不记撤销栈，只在 pointerup 记一次 —— 否则撤销一次只退一个像素。
================================================================ */

import {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useMemo,
    useRef,
    useState,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent
} from 'react';
import type { EditorDocument } from '../services/editorService';
import type { LonLat } from '../contract';
import type {
    BaseMapMeta,
    EditorTarget,
    LayerVisibility,
    SketchState,
    ToolMode
} from './editorTypes';
import { TARGET_KIND_LABELS, sameTarget, targetKey } from './editorTypes';
import {
    buildShapes,
    insertVertexAfter,
    mergeTargets,
    removeTargets,
    removeVertexAt,
    withOutline
} from './editorModel';
import type { EditorProjection, MeterPoint } from './projection';
import { drawScene, readScenePalette, type Marquee } from './drawScene';
import {
    SEGMENT_HIT_PIXELS,
    VERTEX_HIT_PIXELS,
    hitAllShapes,
    hitSegment,
    hitShape,
    hitVertex,
    shapesInMarquee,
    type MeterRect
} from './hitTest';
import { findSnap, snapTolerance, type SnapExclusion, type SnapResult } from './snapping';
import {
    WHEEL_ZOOM_STEP,
    fitPoints,
    panBy,
    toMeters,
    zoomAt,
    zoomByFactor,
    type ViewTransform,
    type Viewport
} from './viewTransform';
import styles from './editor.module.css';

/** 双击落最后一点时，第二次按下会落在同一位置：距离小于这个值（度，约 1 cm）就只留一个 */
const SKETCH_DUPLICATE_EPSILON = 1e-7;
/** 方向键微调步长（米）：细调一格，Shift 加速十倍，Ctrl 减速十倍 */
const NUDGE_METERS = 1;
const NUDGE_METERS_COARSE = 10;
const NUDGE_METERS_FINE = 0.1;
/** 顶点是否真的被挪动的判定阈值（米）：小于它就不算一次可撤销的改动 */
const MOVE_EPSILON_METERS = 0.001;

/** 这次编辑的载荷 */
export interface EditEvent {
    next: EditorDocument;
    /** 需要记入撤销栈的「改动前文档」；null = 拖动中途，不记栈 */
    before: EditorDocument | null;
}

export interface EditorCanvasHandle {
    fitAll: () => void;
    /** 缩放至指定对象（不传则用当前选中集） */
    fitTargets: (targets?: readonly EditorTarget[]) => void;
    zoomIn: () => void;
    zoomOut: () => void;
}

export interface EditorCanvasProps {
    document: EditorDocument;
    projection: EditorProjection;
    /** 主题名参与调色板记忆（切主题要重读 CSS 令牌） */
    theme: string;
    tool: ToolMode;
    snapping: boolean;
    visibility: LayerVisibility;
    basemap: { image: HTMLImageElement | null; meta: BaseMapMeta };
    selection: readonly EditorTarget[];
    activeTarget: EditorTarget | null;
    sketch: SketchState | null;
    onEdit: (event: EditEvent) => void;
    onSelectionChange: (selection: EditorTarget[]) => void;
    onActiveTargetChange: (target: EditorTarget | null) => void;
    onSketchChange: (sketch: SketchState | null) => void;
    /** 草图达到 3 点以上、用户确认完成时回调：由上层把草图变成真正的条目 */
    onSketchFinish: (sketch: SketchState) => void;
    onToolChange: (tool: ToolMode) => void;
    /** 「从地图选取坐标」模式：为 true 时光标变十字，点击画布回传该点经纬度并结束 */
    picking: boolean;
    onPickCoordinate: (lonlat: LonLat) => void;
    /** 拾取模式中按 Esc 取消 */
    onPickCancel: () => void;
}

type DragState =
    | { mode: 'pan'; lastPx: number; lastPy: number }
    | {
          mode: 'vertex';
          target: EditorTarget;
          index: number;
          snapshot: EditorDocument;
          /** 手势开始时的轮廓（已含「拖线段插入」插进去的那个点） */
          base: MeterPoint[];
          moved: boolean;
      }
    | {
          mode: 'shape';
          snapshot: EditorDocument;
          start: MeterPoint;
          bases: { target: EditorTarget; meters: MeterPoint[] }[];
          moved: boolean;
      }
    | { mode: 'marquee'; x0: number; y0: number; additive: boolean }
    | {
          mode: 'pick';
          /** pointerdown 时命中的所有面（上→下），用于 pointerup 判断是否弹选择菜单 */
          hits: EditorTarget[];
          start: MeterPoint;
          additive: boolean;
      }
    | null;

interface ContextMenuState {
    x: number;
    y: number;
    items: { label: string; action: () => void; disabled?: boolean }[];
}

/** 草图加点：与前一点重合就不加（双击的第二次按下会落在同一点） */
function appendSketchPoint(outline: readonly [number, number][], point: [number, number]) {
    const last = outline[outline.length - 1];
    if (
        last &&
        Math.abs(last[0] - point[0]) < SKETCH_DUPLICATE_EPSILON &&
        Math.abs(last[1] - point[1]) < SKETCH_DUPLICATE_EPSILON
    ) {
        return [...outline];
    }
    return [...outline, point];
}

/** 完成草图前再去一次重尾 */
function dropDuplicateTail(outline: readonly [number, number][]) {
    if (outline.length < 2) return [...outline];
    const last = outline[outline.length - 1];
    const prev = outline[outline.length - 2];
    if (
        Math.abs(last[0] - prev[0]) < SKETCH_DUPLICATE_EPSILON &&
        Math.abs(last[1] - prev[1]) < SKETCH_DUPLICATE_EPSILON
    ) {
        return outline.slice(0, -1).map((point) => [...point] as [number, number]);
    }
    return outline.map((point) => [...point] as [number, number]);
}

export const EditorCanvas = forwardRef<EditorCanvasHandle, EditorCanvasProps>(
    function EditorCanvas(props, ref) {
        const {
            document,
            projection,
            theme,
            tool,
            snapping,
            visibility,
            basemap,
            selection,
            activeTarget,
            sketch,
            onEdit,
            onSelectionChange,
            onActiveTargetChange,
            onSketchChange,
            onSketchFinish,
            onToolChange,
            picking,
            onPickCoordinate,
            onPickCancel
        } = props;

        const wrapRef = useRef<HTMLDivElement>(null);
        const canvasRef = useRef<HTMLCanvasElement>(null);
        const dragRef = useRef<DragState>(null);
        /** 最新的文档：pointerup 时读它判断「这次拖动到底改没改」 */
        const documentRef = useRef(document);
        /** 最新的视图：指针事件里要用，但不该因为它变化而重挂监听 */
        const viewRef = useRef<ViewTransform>({ cx: 0, cy: 0, scale: 1 });

        const [size, setSize] = useState<Viewport>({ width: 0, height: 0 });
        const [view, setView] = useState<ViewTransform>({ cx: 0, cy: 0, scale: 1 });
        const [selectedVertex, setSelectedVertex] = useState<number | null>(null);
        const [readout, setReadout] = useState<{ cursor: MeterPoint | null; snap: SnapResult | null }>({
            cursor: null,
            snap: null
        });
        const [marquee, setMarquee] = useState<Marquee | null>(null);
        const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
        /** 指向菜单 DOM（<ul>），用于判断 capture 阶段的 pointerdown 是否来自菜单内部 */
        const contextMenuRef = useRef<HTMLUListElement | null>(null);
        /** 空格或 Alt 按住 = 临时切到浏览（ArcMap 的临时工具切换） */
        const [tempPan, setTempPan] = useState(false);

        /* theme 只作为依赖触发器：切换主题要重读 CSS 令牌 */
        const palette = useMemo(readScenePalette, [theme]);

        const viewport = size;

        /* 轮廓的经纬度与本地米两份表示：绘制 / 命中 / 捕捉共用，避免各算一遍 */
        const shapes = useMemo(() => buildShapes(document), [document]);
        const shapesMeters = useMemo(
            () =>
                shapes.map((shape) => ({
                    target: shape.target,
                    label: shape.label,
                    meters: shape.outline.map(projection.toMeters)
                })),
            [shapes, projection]
        );

        /* 按图层可见性过滤：命中测试、捕捉、框选都只看可见图层，
           防止隐藏图层的对象「看不到却能点中」。绘制仍走原 shapesMeters，
           由 drawScene 内部按 visibility 决定是否画。 */
        const visibleShapesMeters = useMemo(
            () =>
                shapesMeters.filter((shape) => {
                    switch (shape.target.kind) {
                        case 'building':
                            return visibility.buildings;
                        case 'parcel':
                            return visibility.parcels;
                        case 'island':
                            return visibility.island;
                        default:
                            return true;
                    }
                }),
            [shapesMeters, visibility]
        );

        useEffect(() => {
            documentRef.current = document;
        }, [document]);

        useEffect(() => {
            viewRef.current = view;
        }, [view]);

        /* ---------- 尺寸 ---------- */
        useEffect(() => {
            const wrap = wrapRef.current;
            if (!wrap) return;
            const sync = () => setSize({ width: wrap.clientWidth, height: wrap.clientHeight });
            sync();
            const observer = new ResizeObserver(sync);
            observer.observe(wrap);
            return () => observer.disconnect();
        }, []);

        /* ---------- 首次进入 / 换数据源时适配整座岛 ---------- */
        const fittedForRef = useRef<EditorProjection | null>(null);
        useEffect(() => {
            if (viewport.width === 0 || viewport.height === 0) return;
            if (fittedForRef.current === projection) return;

            fittedForRef.current = projection;
            setView(fitPoints(shapesMeters.flatMap((shape) => shape.meters), viewport));
        }, [projection, shapesMeters, viewport]);

        /* ---------- 对外命令 ---------- */
        const fitTargets = useCallback(
            (targets?: readonly EditorTarget[]) => {
                const keys = new Set((targets ?? selection).map(targetKey));
                const picked = shapesMeters
                    .filter((shape) => keys.has(targetKey(shape.target)))
                    .flatMap((shape) => shape.meters);

                /* 没选中就退化成全图 —— 按钮永远有反馈，不会「点了没反应」 */
                const points =
                    picked.length > 0 ? picked : shapesMeters.flatMap((shape) => shape.meters);
                setView(fitPoints(points, viewport));
            },
            [selection, shapesMeters, viewport]
        );

        useImperativeHandle(
            ref,
            () => ({
                fitAll: () =>
                    setView(fitPoints(shapesMeters.flatMap((shape) => shape.meters), viewport)),
                fitTargets,
                zoomIn: () => setView((current) => zoomByFactor(current, WHEEL_ZOOM_STEP * 2)),
                zoomOut: () => setView((current) => zoomByFactor(current, 1 / (WHEEL_ZOOM_STEP * 2)))
            }),
            [shapesMeters, viewport, fitTargets]
        );

        /* ---------- 绘制 ---------- */
        useEffect(() => {
            const canvas = canvasRef.current;
            if (!canvas || viewport.width === 0 || viewport.height === 0) return;

            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const pixelWidth = Math.round(viewport.width * dpr);
            const pixelHeight = Math.round(viewport.height * dpr);
            /* 只在真实尺寸变化时才重设 canvas.width/height：每次重设都会清空并重建后备存储 */
            if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
                canvas.width = pixelWidth;
                canvas.height = pixelHeight;
            }

            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

            drawScene({
                ctx,
                viewport,
                view,
                projection,
                palette,
                shapes: shapesMeters,
                visibility,
                basemap,
                selection,
                activeTarget,
                selectedVertex,
                sketch:
                    tool === 'create' && sketch
                        ? {
                              meters: sketch.outline.map(projection.toMeters),
                              cursor: readout.cursor,
                              snapped: readout.snap !== null
                          }
                        : null,
                snap: readout.snap,
                marquee
            });
        }, [
            viewport,
            view,
            projection,
            palette,
            shapesMeters,
            visibility,
            basemap,
            selection,
            activeTarget,
            selectedVertex,
            sketch,
            tool,
            readout,
            marquee
        ]);

        /* 当前编辑对象的两份表示（顶点编辑只需要它，不必每次全量过滤）。
           放在捕捉定义之前：捕捉的候选集要按「当前编辑对象」收窄 */
        const activeShape = useMemo(
            () =>
                activeTarget
                    ? shapesMeters.find((shape) => sameTarget(shape.target, activeTarget))
                    : undefined,
            [activeTarget, shapesMeters]
        );

        const activeOutline = useMemo(
            () =>
                activeTarget
                    ? shapes.find((shape) => sameTarget(shape.target, activeTarget))?.outline
                    : undefined,
            [activeTarget, shapes]
        );

        /* ---------- 读数与捕捉 ---------- */
        const updateReadout = useCallback(
            (next: { cursor: MeterPoint | null; snap: SnapResult | null }) => {
                setReadout((current) => {
                    const sameCursor =
                        (current.cursor === null && next.cursor === null) ||
                        (current.cursor !== null &&
                            next.cursor !== null &&
                            Math.abs(current.cursor.x - next.cursor.x) < 0.01 &&
                            Math.abs(current.cursor.y - next.cursor.y) < 0.01);
                    const sameSnap =
                        (current.snap === null && next.snap === null) ||
                        (current.snap !== null &&
                            next.snap !== null &&
                            current.snap.kind === next.snap.kind &&
                            targetKey(current.snap.target) === targetKey(next.snap.target) &&
                            current.snap.index === next.snap.index);
                    return sameCursor && sameSnap ? current : next;
                });
            },
            []
        );

        /**
         * 捕捉：把光标位置吸到最近的顶点 / 线段上（顶点优先）。
         * 只在会「落点」的工具下生效 —— 选择/浏览工具不落点，跟着吸只会干扰读数。
         *
         * scope 决定候选集：
         *  - 'active'：只吸当前编辑对象。用于**顶点工具的悬停预览** ——
         *    按下去能抓到的只有当前编辑对象的顶点与线段，预览必须与它一致，
         *    否则会出现「符号指着某个顶点，按下去却什么也没抓到」。
         *  - 'all'：吸所有对象。用于拖动顶点与画草图 —— 这正是「把相邻地皮的边对齐」的用法。
         */
        const resolveSnap = useCallback(
            (
                cursor: MeterPoint,
                exclusion: SnapExclusion | null,
                scope: 'active' | 'all'
            ): SnapResult | null => {
                if (!snapping || (tool !== 'vertex' && tool !== 'create')) return null;
                const scale = viewRef.current.scale;
                if (scale <= 0) return null;

                /* 捕捉也只看可见图层：隐藏图层的边和顶点不应该吸附到 */
                const candidates =
                    scope === 'active' && activeShape ? [activeShape] : visibleShapesMeters;
                /* 顶点工具要「抓」得住，所以容差与命中半径一致；新建要素只是落点 */
                const tolerance = snapTolerance(scale, tool === 'vertex' ? 'grab' : 'place');
                return findSnap(cursor, candidates, tolerance, exclusion);
            },
            [snapping, visibleShapesMeters, tool, activeShape]
        );

        /** 悬停时的候选集：顶点工具只看当前编辑对象，新建要素时看全部 */
        const hoverScope: 'active' | 'all' = tool === 'vertex' ? 'active' : 'all';

        /* ---------- 指针：按下 ---------- */
        const cursorFromEvent = (event: { clientX: number; clientY: number }) => {
            const rect = canvasRef.current?.getBoundingClientRect();
            const px = rect ? event.clientX - rect.left : 0;
            const py = rect ? event.clientY - rect.top : 0;
            return { px, py, cursor: toMeters(viewRef.current, viewport, px, py) };
        };

        /** 完成草图：不足三点不成面，因此这里不给出「半成品」；上层负责把它变成条目 */
        const finishSketch = (): void => {
            if (!sketch) return;
            const outline = dropDuplicateTail(sketch.outline);
            if (outline.length < 3) return;
            onSketchFinish({ ...sketch, outline });
        };

        const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
            setContextMenu(null);
            const { px, py, cursor } = cursorFromEvent(event);

            /* 「从地图选取坐标」模式：单击即取点，不进入任何编辑手势。
               只认左键，其余按键（中键平移等）仍交给下面的常规流程。 */
            if (picking && event.button === 0) {
                event.preventDefault();
                event.stopPropagation();
                onPickCoordinate(projection.toLonLat(cursor));
                return;
            }

            /* 中键 / 空格或 Alt / 浏览工具：一律平移视图 */
            if (event.button === 1 || tempPan || tool === 'pan') {
                dragRef.current = { mode: 'pan', lastPx: px, lastPy: py };
                return;
            }

            if (tool === 'create') {
                if (!sketch) return;
                const snap = resolveSnap(cursor, null, 'all');
                onSketchChange({
                    ...sketch,
                    outline: appendSketchPoint(
                        sketch.outline,
                        projection.toLonLat(snap ? snap.point : cursor)
                    )
                });
                return;
            }

            if (tool === 'vertex') {
                const scale = viewRef.current.scale;
                const vertexTolerance = scale > 0 ? VERTEX_HIT_PIXELS / scale : 0;
                const segmentTolerance = scale > 0 ? SEGMENT_HIT_PIXELS / scale : 0;
                const activeOnly = activeShape ? [activeShape] : [];

                /* 先认当前编辑对象的顶点，再认它的线段（拖线段 = 在此插点并立刻拖动） */
                const vertexHit = hitVertex(activeOnly, cursor, vertexTolerance);
                if (vertexHit && activeTarget && activeShape) {
                    setSelectedVertex(vertexHit.index);
                    dragRef.current = {
                        mode: 'vertex',
                        target: activeTarget,
                        index: vertexHit.index,
                        snapshot: document,
                        base: activeShape.meters,
                        moved: false
                    };
                    return;
                }

                const segmentHit = hitSegment(activeOnly, cursor, segmentTolerance);
                if (segmentHit && activeTarget && activeOutline) {
                    const inserted = insertVertexAfter(activeOutline, segmentHit.index);
                    setSelectedVertex(segmentHit.index + 1);
                    dragRef.current = {
                        mode: 'vertex',
                        target: activeTarget,
                        index: segmentHit.index + 1,
                        snapshot: document,
                        base: inserted.map(projection.toMeters),
                        moved: false
                    };
                    return;
                }

                /* 点到别的对象上：切 activeTarget。命中多个时走 pick 模式在 pointerup 弹菜单 */
                const allHits = hitAllShapes(visibleShapesMeters, cursor);
                if (allHits.length > 0) {
                    /* 如果命中里包含当前 activeTarget，说明用户想在当前对象上点空白
                       退出顶点编辑，此时直接清选中顶点不做切换 —— 但只有一个命中才走快捷路径 */
                    if (
                        allHits.length === 1 &&
                        activeTarget &&
                        sameTarget(allHits[0], activeTarget)
                    ) {
                        setSelectedVertex(null);
                        return;
                    }
                    /* 其余情况都走 pick 模式，在 pointerup 统一处理（单命中直接切，多命中弹菜单） */
                    dragRef.current = {
                        mode: 'pick',
                        hits: allHits,
                        start: cursor,
                        additive: event.shiftKey
                    };
                    return;
                }
                setSelectedVertex(null);
                return;
            }

            /* 选择工具：点要素选中 / 拖整体平移 / 拖空白框选；命中要素时先走 pick 模式，
               在 pointerup 时判断是否拖动过、是否需要弹重叠选择菜单 */
            const allHits = hitAllShapes(visibleShapesMeters, cursor);
            const additive = event.shiftKey;

            if (allHits.length > 0) {
                dragRef.current = {
                    mode: 'pick',
                    hits: allHits,
                    start: cursor,
                    additive
                };
                return;
            }

            if (!additive) {
                onSelectionChange([]);
                onActiveTargetChange(null);
            }
            setSelectedVertex(null);
            dragRef.current = { mode: 'marquee', x0: px, y0: py, additive };
        };

        /* ---------- 指针：移动与抬手 ---------- */
        useEffect(() => {
            const canvas = canvasRef.current;
            if (!canvas) return;

            /** 根据命中的对象构造「点中 → 整体平移」的升级阈值：
                只有选择工具下，命中对象并拖动超过阈值才开始整体平移，
                否则当作「点击」由 pointerup 处理选择或弹重叠菜单。
                vertex 工具下命中别的对象时永远当作点击，不升级为平移。 */
            const PICK_TO_DRAG_PIXELS = 3;

            const onMove = (event: PointerEvent) => {
                const rect = canvas.getBoundingClientRect();
                const px = event.clientX - rect.left;
                const py = event.clientY - rect.top;
                const cursor = toMeters(viewRef.current, viewport, px, py);
                const drag: Exclude<DragState, null> | null = dragRef.current;

                /* 指针在画布外就不更新读数：避免无意义的逐帧重绘 */
                const inside = px >= 0 && py >= 0 && px <= rect.width && py <= rect.height;

                if (!drag) {
                    updateReadout({
                        cursor: inside ? cursor : null,
                        snap: inside ? resolveSnap(cursor, null, hoverScope) : null
                    });
                    return;
                }

                if (drag.mode === 'pan') {
                    setView((current) => panBy(current, px - drag.lastPx, py - drag.lastPy));
                    dragRef.current = { ...drag, lastPx: px, lastPy: py };
                    return;
                }

                if (drag.mode === 'marquee') {
                    setMarquee({
                        x0: drag.x0,
                        y0: drag.y0,
                        x1: px,
                        y1: py,
                        /* 左→右 = 完全包含，右→左 = 相交（ArcGIS 的方向约定） */
                        window: px >= drag.x0
                    });
                    return;
                }

                if (drag.mode === 'pick') {
                    const scale = viewRef.current.scale;
                    const dxPx = Math.abs(cursor.x - drag.start.x) * scale;
                    const dyPx = Math.abs(cursor.y - drag.start.y) * scale;

                    /* 选择工具下：拖过阈值 → 升级成整体平移；vertex 工具不升级 */
                    if (
                        tool === 'select' &&
                        (dxPx > PICK_TO_DRAG_PIXELS || dyPx > PICK_TO_DRAG_PIXELS)
                    ) {
                        const shapeHit = drag.hits[0];
                        if (shapeHit) {
                            /* 命中多个时以最上层为基准开始平移；重叠选择菜单就不再弹 */
                            const alreadySelected = selection.some((item) => sameTarget(item, shapeHit));
                            const nextSelection: EditorTarget[] = drag.additive
                                ? alreadySelected
                                    ? [...selection]
                                    : [...selection, shapeHit]
                                : [shapeHit];

                            onSelectionChange(nextSelection);
                            onActiveTargetChange(shapeHit);
                            setSelectedVertex(null);

                            const bases = shapesMeters
                                .filter((shape) =>
                                    nextSelection.some((item) => sameTarget(item, shape.target))
                                )
                                .map((shape) => ({ target: shape.target, meters: [...shape.meters] }));

                            const shapeDrag: Extract<DragState, { mode: 'shape' }> = {
                                mode: 'shape',
                                snapshot: document,
                                start: drag.start,
                                bases,
                                moved: true
                            };
                            dragRef.current = shapeDrag;

                            /* 立即执行一次平移，保证按下与移动的距离不会丢 */
                            const dx = cursor.x - shapeDrag.start.x;
                            const dy = cursor.y - shapeDrag.start.y;
                            if (
                                Math.abs(dx) > MOVE_EPSILON_METERS ||
                                Math.abs(dy) > MOVE_EPSILON_METERS
                            ) {
                                let next = shapeDrag.snapshot;
                                for (const base of shapeDrag.bases) {
                                    next = withOutline(
                                        next,
                                        base.target,
                                        base.meters.map((point) =>
                                            projection.toLonLat({
                                                x: point.x + dx,
                                                y: point.y + dy
                                            })
                                        )
                                    );
                                }
                                onEdit({ next, before: null });
                            }
                        }
                    } else {
                        /* 还没到阈值：继续维持 pick，只更新读数 */
                        updateReadout({
                            cursor: inside ? cursor : null,
                            snap: null
                        });
                    }
                    return;
                }

                if (drag.mode === 'vertex') {
                    const snap = resolveSnap(
                        cursor,
                        { target: drag.target, vertexIndex: drag.index },
                        'all'
                    );
                    const position = snap ? snap.point : cursor;
                    const origin = drag.base[drag.index];

                    /* 位置没真的变就不写数据：否则会凭空多出一份「改了但没记栈」的新文档 */
                    if (
                        Math.abs(position.x - origin.x) <= MOVE_EPSILON_METERS &&
                        Math.abs(position.y - origin.y) <= MOVE_EPSILON_METERS
                    ) {
                        updateReadout({ cursor: position, snap });
                        return;
                    }

                    const nextMeters = drag.base.map((point, index) =>
                        index === drag.index ? position : point
                    );
                    /* 同步到 dragRef 的 moved 标记，避免 onUp 引用到旧对象 */
                    dragRef.current = { ...drag, moved: true, base: nextMeters };

                    onEdit({
                        next: withOutline(
                            drag.snapshot,
                            drag.target,
                            nextMeters.map(projection.toLonLat)
                        ),
                        before: null
                    });
                    updateReadout({ cursor: position, snap });
                    return;
                }

                if (drag.mode === 'shape') {
                    /* 整体平移 */
                    const dx = cursor.x - drag.start.x;
                    const dy = cursor.y - drag.start.y;

                    if (Math.abs(dx) <= MOVE_EPSILON_METERS && Math.abs(dy) <= MOVE_EPSILON_METERS) return;

                    let next = drag.snapshot;
                    for (const base of drag.bases) {
                        next = withOutline(
                            next,
                            base.target,
                            base.meters.map((point) =>
                                projection.toLonLat({ x: point.x + dx, y: point.y + dy })
                            )
                        );
                    }

                    dragRef.current = { ...drag, moved: true };
                    onEdit({ next, before: null });
                }
            };

            const onUp = (event: PointerEvent) => {
                const drag = dragRef.current;
                dragRef.current = null;
                if (!drag) return;

                if (drag.mode === 'pick') {
                    /* 点击命中的处理：
                       1) 命中 0 个 → 什么都不做（pointerdown 时已经清空过了）
                       2) 命中 1 个 → 直接选中 / 切 activeTarget
                       3) 命中 >1 个 → 弹重叠选择菜单，让用户挑要哪个 */
                    const rect = canvas.getBoundingClientRect();
                    const px = event.clientX - rect.left;
                    const py = event.clientY - rect.top;

                    if (drag.hits.length === 0) return;

                    if (drag.hits.length === 1) {
                        const shapeHit = drag.hits[0];

                        if (tool === 'select') {
                            const alreadySelected = selection.some((item) => sameTarget(item, shapeHit));
                            const nextSelection: EditorTarget[] = drag.additive
                                ? alreadySelected
                                    ? selection.filter((item) => !sameTarget(item, shapeHit))
                                    : [...selection, shapeHit]
                                : alreadySelected
                                  ? [...selection]
                                  : [shapeHit];
                            onSelectionChange(nextSelection);
                            onActiveTargetChange(shapeHit);
                            setSelectedVertex(null);
                        } else if (tool === 'vertex') {
                            /* vertex 工具下命中别的对象：切 activeTarget */
                            onActiveTargetChange(shapeHit);
                            onSelectionChange([shapeHit]);
                            setSelectedVertex(null);
                        }
                        return;
                    }

                    /* 多个命中 → 弹重叠选择菜单（复用右键菜单样式） */
                    const items: ContextMenuState['items'] = drag.hits.map((hit) => {
                        const shape = shapesMeters.find((s) => sameTarget(s.target, hit));
                        const label = shape?.label ?? TARGET_KIND_LABELS[hit.kind];
                        const kindLabel = TARGET_KIND_LABELS[hit.kind];
                        return {
                            label: `${kindLabel}：${label}`,
                            action: () => {
                                if (tool === 'select') {
                                    const alreadySelected = selection.some((item) => sameTarget(item, hit));
                                    const nextSelection: EditorTarget[] = drag.additive
                                        ? alreadySelected
                                            ? selection.filter((item) => !sameTarget(item, hit))
                                            : [...selection, hit]
                                        : alreadySelected
                                          ? [...selection]
                                          : [hit];
                                    onSelectionChange(nextSelection);
                                    onActiveTargetChange(hit);
                                } else if (tool === 'vertex') {
                                        onActiveTargetChange(hit);
                                        onSelectionChange([hit]);
                                    }
                                setSelectedVertex(null);
                                setContextMenu(null);
                            }
                        };
                    });

                    setContextMenu({ x: px, y: py, items });
                    return;
                }

                if (drag.mode === 'marquee') {
                    setMarquee(null);
                    const rect = canvas.getBoundingClientRect();
                    const start = toMeters(viewRef.current, viewport, drag.x0, drag.y0);
                    const end = toMeters(
                        viewRef.current,
                        viewport,
                        event.clientX - rect.left,
                        event.clientY - rect.top
                    );
                    const scale = viewRef.current.scale;

                    /* 拖得太小当点击处理，避免「手抖一下就把选择清空了」 */
                    if (
                        Math.abs(end.x - start.x) * scale < 3 &&
                        Math.abs(end.y - start.y) * scale < 3
                    ) {
                        return;
                    }

                    const bounds: MeterRect = {
                        minX: Math.min(start.x, end.x),
                        minY: Math.min(start.y, end.y),
                        maxX: Math.max(start.x, end.x),
                        maxY: Math.max(start.y, end.y)
                    };
                    /* 选择规则看**最终**拖动方向（左→右 完全包含 / 右→左 相交），
                       因此这里从抬手位置判定，而不是读拖动中途的临时值 */
                    const windowMode = event.clientX - rect.left >= drag.x0;
                    /* 框选也只看可见图层：隐藏的不要被框进去 */
                    const hits = shapesInMarquee(visibleShapesMeters, bounds, windowMode);
                    const merged: EditorTarget[] = drag.additive ? mergeTargets(selection, hits) : hits;
                    onSelectionChange(merged);
                    return;
                }

                if (drag.mode !== 'vertex' && drag.mode !== 'shape') return;

                /* 手势结束才记一次撤销栈；没真的动过就不记 */
                if (!drag.moved) return;
                onEdit({ next: documentRef.current, before: drag.snapshot });
            };

            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
            window.addEventListener('pointercancel', onUp);
            return () => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                window.removeEventListener('pointercancel', onUp);
            };
        }, [
            viewport,
            projection,
            shapesMeters,
            visibleShapesMeters,
            document,
            selection,
            tool,
            hoverScope,
            resolveSnap,
            updateReadout,
            onEdit,
            onSelectionChange,
            onActiveTargetChange
        ]);

        /* ---------- 滚轮缩放 ---------- */
        useEffect(() => {
            const canvas = canvasRef.current;
            if (!canvas) return;

            const onWheel = (event: WheelEvent) => {
                event.preventDefault();
                const rect = canvas.getBoundingClientRect();
                const factor = event.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP;
                setView((current) =>
                    zoomAt(current, viewport, event.clientX - rect.left, event.clientY - rect.top, factor)
                );
            };

            /* passive: false —— 否则 preventDefault 无效，页面会跟着滚 */
            canvas.addEventListener('wheel', onWheel, { passive: false });
            return () => canvas.removeEventListener('wheel', onWheel);
        }, [viewport]);

        /* ---------- 临时平移（空格 / Alt） ---------- */
        useEffect(() => {
            const onKeyDown = (event: KeyboardEvent) => {
                if (event.code !== 'Space' && !event.altKey) return;
                if (event.code === 'Space') event.preventDefault();
                setTempPan(true);
            };
            const onKeyUp = () => setTempPan(false);

            window.addEventListener('keydown', onKeyDown);
            window.addEventListener('keyup', onKeyUp);
            return () => {
                window.removeEventListener('keydown', onKeyDown);
                window.removeEventListener('keyup', onKeyUp);
            };
        }, []);

        /* ---------- 双击：进入顶点编辑 / 完成草图 ---------- */
        const onDoubleClick = (event: ReactMouseEvent<HTMLCanvasElement>) => {
            const { cursor } = cursorFromEvent(event);

            if (tool === 'create' && sketch) {
                finishSketch();
                return;
            }

            /* 双击也只认可见图层；重叠时取最上层的那个（双击本来就是最快捷的「选并进入编辑」） */
            const shapeHit = hitShape(visibleShapesMeters, cursor);
            if (!shapeHit) return;

            onActiveTargetChange(shapeHit);
            onSelectionChange([shapeHit]);
            setSelectedVertex(null);
            /* 双击即进入编辑草图 —— ArcMap 的 Edit 工具就是这个动作 */
            if (tool !== 'vertex') onToolChange('vertex');
        };

        /* ---------- 右键菜单 ---------- */
        const closeContextMenu = useCallback(
            (event?: Event) => {
                /* 如果是来自菜单内部 DOM 的 pointerdown（菜单项点击），不关闭，
                   避免 capture 阶段先把菜单卸载导致 onClick 永远触发不到 */
                if (event && contextMenu) {
                    const target = event.target as Node | null;
                    if (target && contextMenuRef.current?.contains(target)) return;
                }
                setContextMenu(null);
            },
            [contextMenu]
        );

        const openContextMenu = (event: ReactMouseEvent<HTMLCanvasElement>) => {
            event.preventDefault();
            const { px, py, cursor } = cursorFromEvent(event);
            const scale = viewRef.current.scale;
            const activeOnly = activeShape ? [activeShape] : [];
            const vertexHit =
                scale > 0 ? hitVertex(activeOnly, cursor, VERTEX_HIT_PIXELS / scale) : null;
            const segmentHit =
                scale > 0 ? hitSegment(activeOnly, cursor, SEGMENT_HIT_PIXELS / scale) : null;
            /* 右键也只看可见图层，隐藏图层的对象不应该出现在右键菜单操作里 */
            const shapeHit = hitShape(visibleShapesMeters, cursor);

            const items: ContextMenuState['items'] = [];

            if (tool === 'create' && sketch) {
                items.push(
                    {
                        label: `完成草图（${sketch.outline.length} 点）`,
                        action: () => {
                            finishSketch();
                            closeContextMenu();
                        },
                        disabled: sketch.outline.length < 3
                    },
                    {
                        label: '退掉最后一个点',
                        action: () => {
                            onSketchChange({ ...sketch, outline: sketch.outline.slice(0, -1) });
                            closeContextMenu();
                        },
                        disabled: sketch.outline.length === 0
                    },
                    {
                        label: '放弃草图',
                        action: () => {
                            onSketchChange(null);
                            closeContextMenu();
                        }
                    }
                );
            } else {
                if (vertexHit && activeTarget) {
                    items.push({
                        label: `删除该点（第 ${vertexHit.index + 1} 点）`,
                        action: () => {
                            if (!activeOutline) return;
                            onEdit({
                                next: withOutline(
                                    document,
                                    activeTarget,
                                    removeVertexAt(activeOutline, vertexHit.index)
                                ),
                                before: document
                            });
                            setSelectedVertex(null);
                            closeContextMenu();
                        },
                        /* 三点以下不成面 */
                        disabled: (activeOutline?.length ?? 0) <= 3
                    });
                }

                if (segmentHit && activeTarget && activeOutline) {
                    items.push({
                        label: '在此插入点',
                        action: () => {
                            onEdit({
                                next: withOutline(
                                    document,
                                    activeTarget,
                                    insertVertexAfter(activeOutline, segmentHit.index)
                                ),
                                before: document
                            });
                            setSelectedVertex(segmentHit.index + 1);
                            closeContextMenu();
                        }
                    });
                }

                if (shapeHit) {
                    const label =
                        shapesMeters.find((shape) => sameTarget(shape.target, shapeHit))?.label ?? '';
                    items.push({
                        label: `缩放至${TARGET_KIND_LABELS[shapeHit.kind]}：${label}`,
                        action: () => {
                            fitTargets([shapeHit]);
                            closeContextMenu();
                        }
                    });
                }

                const deletable = selection.filter((item) => item.kind !== 'island');
                if (deletable.length > 0) {
                    items.push({
                        label: `删除选中（${deletable.length} 项）`,
                        action: () => {
                            onEdit({
                                next: removeTargets(document, deletable),
                                before: document
                            });
                            onSelectionChange([]);
                            onActiveTargetChange(null);
                            closeContextMenu();
                        }
                    });
                }

                items.push(
                    {
                        label: '缩放至全图',
                        action: () => {
                            setView(
                                fitPoints(shapesMeters.flatMap((shape) => shape.meters), viewport)
                            );
                            closeContextMenu();
                        }
                    },
                    {
                        label: '清除选择',
                        action: () => {
                            onSelectionChange([]);
                            closeContextMenu();
                        }
                    }
                );
            }

            setContextMenu({ x: px, y: py, items });
        };

        useEffect(() => {
            if (!contextMenu) return;
            window.addEventListener('pointerdown', closeContextMenu, { capture: true });
            return () => window.removeEventListener('pointerdown', closeContextMenu, { capture: true });
        }, [contextMenu, closeContextMenu]);

        /* ---------- 键盘：画布相关的快捷键 ---------- */
        useEffect(() => {
            const onKeyDown = (event: KeyboardEvent) => {
                /* 输入框里打字不触发编辑器快捷键 */
                const target = event.target as HTMLElement | null;
                if (
                    target &&
                    (target.tagName === 'INPUT' ||
                        target.tagName === 'SELECT' ||
                        target.tagName === 'TEXTAREA')
                ) {
                    return;
                }

                if (event.key === 'Escape') {
                    /* 拾取坐标模式下：Esc 只负责取消拾取，不碰选择/草图 */
                    if (picking) {
                        onPickCancel();
                        return;
                    }
                    if (sketch) {
                        onSketchChange(null);
                        return;
                    }
                    if (contextMenu) {
                        closeContextMenu();
                        return;
                    }
                    if (tool === 'vertex' && selectedVertex !== null) {
                        setSelectedVertex(null);
                        return;
                    }
                    if (tool === 'vertex' && activeTarget) {
                        onActiveTargetChange(null);
                        return;
                    }
                    onSelectionChange([]);
                    return;
                }

                if (event.key === 'F2' || (event.key === 'Enter' && tool === 'create')) {
                    if (tool === 'create' && sketch) {
                        event.preventDefault();
                        finishSketch();
                    }
                    return;
                }

                if (event.key === 'Backspace' && tool === 'create' && sketch) {
                    event.preventDefault();
                    onSketchChange({ ...sketch, outline: sketch.outline.slice(0, -1) });
                    return;
                }

                if (event.key === 'Delete' || event.key === 'Backspace') {
                    if (tool === 'vertex' && activeTarget && selectedVertex !== null && activeOutline) {
                        event.preventDefault();
                        onEdit({
                            next: withOutline(
                                document,
                                activeTarget,
                                removeVertexAt(activeOutline, selectedVertex)
                            ),
                            before: document
                        });
                        setSelectedVertex(null);
                        return;
                    }

                    const deletable = selection.filter((item) => item.kind !== 'island');
                    if (deletable.length === 0) return;
                    event.preventDefault();
                    onEdit({
                        next: removeTargets(document, deletable),
                        before: document
                    });
                    onSelectionChange([]);
                    onActiveTargetChange(null);
                    return;
                }

                /* 方向键微调选中的顶点 */
                const nudge =
                    event.key === 'ArrowLeft'
                        ? { x: -1, y: 0 }
                        : event.key === 'ArrowRight'
                          ? { x: 1, y: 0 }
                          : event.key === 'ArrowUp'
                            ? { x: 0, y: 1 }
                            : event.key === 'ArrowDown'
                              ? { x: 0, y: -1 }
                              : null;

                if (!nudge) return;
                if (tool !== 'vertex' || !activeTarget || selectedVertex === null || !activeOutline) {
                    return;
                }

                event.preventDefault();
                const step = event.shiftKey
                    ? NUDGE_METERS_COARSE
                    : event.ctrlKey
                      ? NUDGE_METERS_FINE
                      : NUDGE_METERS;
                const moved = projection.toMeters(activeOutline[selectedVertex]);
                const outline = activeOutline.map((point, index) =>
                    index === selectedVertex
                        ? projection.toLonLat({
                              x: moved.x + nudge.x * step,
                              y: moved.y + nudge.y * step
                          })
                        : point
                );

                onEdit({
                    next: withOutline(document, activeTarget, outline),
                    before: document
                });
            };

            window.addEventListener('keydown', onKeyDown);
            return () => window.removeEventListener('keydown', onKeyDown);
        }, [
            activeOutline,
            activeTarget,
            closeContextMenu,
            contextMenu,
            document,
            onActiveTargetChange,
            onEdit,
            onPickCancel,
            onSelectionChange,
            onSketchChange,
            onSketchFinish,
            picking,
            projection,
            selectedVertex,
            selection,
            sketch,
            tool
        ]);

        /* ---------- 渲染 ---------- */
        const hint = picking
            ? '正在选取坐标：在地图上点击一处，即可把该点坐标填入地点词典（Esc 取消）'
            : tempPan
              ? '临时平移中（松开空格 / Alt 回到当前工具）'
              : tool === 'create'
              ? sketch
                  ? `草图 ${sketch.outline.length} 点 · 双击 / F2 / Enter 完成`
                  : '在画布上逐点点击落下第一个顶点'
              : tool === 'vertex'
                ? activeTarget
                  ? `编辑顶点：${
                        shapesMeters.find((shape) => sameTarget(shape.target, activeTarget))
                            ?.label ?? ''
                    }`
                  : '点击一个对象进入顶点编辑（或双击）'
                : tool === 'select'
                  ? selection.length === 0
                      ? '点击一个对象开始编辑'
                      : `已选中 ${selection.length} 项`
                  : '浏览：拖拽平移 · 滚轮缩放';

        const shownPoint = readout.snap ? readout.snap.point : readout.cursor;
        const cursorLonLat = shownPoint ? projection.toLonLat(shownPoint) : null;

        return (
            <div className={styles.canvasWrap} ref={wrapRef}>
                <canvas
                    ref={canvasRef}
                    className={`${styles.canvas} ${
                        picking ? styles.canvasPick : tempPan || tool === 'pan' ? styles.canvasPan : ''
                    }`}
                    onPointerDown={onPointerDown}
                    onDoubleClick={onDoubleClick}
                    onContextMenu={openContextMenu}
                />

                <div className={styles.canvasReadout}>
                    <span>
                        {shownPoint
                            ? `x ${shownPoint.x.toFixed(1)} m · y ${shownPoint.y.toFixed(1)} m`
                            : '光标在画布外'}
                    </span>
                    {cursorLonLat ? (
                        <span className={styles.readoutLonLat}>
                            {cursorLonLat[0].toFixed(6)}, {cursorLonLat[1].toFixed(6)}
                        </span>
                    ) : null}
                    {readout.snap ? (
                        <span className={styles.snapTag}>
                            捕捉 · {readout.snap.kind === 'vertex' ? '顶点' : '线段'}
                        </span>
                    ) : null}
                    <span className={styles.readoutScale}>1 m = {view.scale.toFixed(2)} px</span>
                </div>

                <p className={styles.canvasHint}>{hint}</p>

                {contextMenu ? (
                    <ul
                        ref={contextMenuRef}
                        className={styles.contextMenu}
                        style={{ left: contextMenu.x, top: contextMenu.y }}
                        onPointerDown={(event) => event.stopPropagation()}
                    >
                        {contextMenu.items.map((item) => (
                            <li key={item.label}>
                                <button
                                    type="button"
                                    className={styles.contextItem}
                                    disabled={item.disabled}
                                    onClick={item.action}
                                >
                                    {item.label}
                                </button>
                            </li>
                        ))}
                    </ul>
                ) : null}
            </div>
        );
    }
);
