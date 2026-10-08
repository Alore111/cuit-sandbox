import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
    EVENT_CATEGORY_LABEL,
    EVENT_STATUS_LABEL,
    resolveEventColor,
    type CampusEvent,
} from '../../contract/campusLive';
import { useCampusLiveStore } from '../../store/campusLiveStore';
import { useUiStore } from '../../store/uiStore';
import { eventProjection, type EventAnchor } from '../eventProjection';
import {
    layoutCallouts,
    EVENT_LAYOUT,
    type CalloutLayoutInput,
} from '../eventLayout';
import styles from '../styles/eventCallout.module.css';

/* 【性能 & 可读性优化】距离相关的可读性近似：
 * 原 SCALE_FAR=0.72 导致远处卡片标题 11.5px × 0.72 = 8.3px，
 * 小于中文正文建议下限 12px，在高 DPR 屏上也几乎看不清。
 * 调整：近处稍微放大到 1.08，远处只收缩到 0.86（最小约 10px，配合基准字号放大仍可读）。
 */
const SCALE_NEAR = 1.08;
const SCALE_FAR = 0.86;
const OPACITY_NEAR = 1.0;
/* 远处透明度从 0.42 → 0.6：让淡的铭牌不要直接"淡出视野"，宁可小一点但看得见 */
const OPACITY_FAR = 0.6;

/* 点击容差：超过该像素位移视为"拖拽环视"，不触发详情 */
const CLICK_SLOP_PX = 6;

const dateFormat = new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
});

function fmtWindow(iso?: string): string {
    if (!iso) return '时间待定';
    return dateFormat.format(new Date(iso));
}

function StatusDot({ status }: { status: string }) {
    return <span className={styles.dot} data-status={status} aria-hidden="true" />;
}

/** severity → 数字权重（排序用，大的优先占锚点附近好位置） */
function severityWeight(sev?: string): number {
    switch (sev) {
        case 'critical': return 40;
        case 'urgent': return 30;
        case 'warning': return 20;
        case 'special': return 15;
        case 'info': return 10;
        default: return 5;
    }
}

/** 同一 locationId 或距离 <clusterMergeThresholdPx 的事件 → 折叠成"+N"卡 */
interface ClusterSummary {
    clusterKey: string;
    members: CampusEvent[];
    cx: number;
    cy: number;
}

export function EventCalloutLayer() {
    const snapshot = useCampusLiveStore((state) => state.snapshot);
    const show = useCampusLiveStore((state) => state.showEvents);
    const filters = useCampusLiveStore((state) => state.eventCategoryFilter);
    const selectedId = useCampusLiveStore((state) => state.selectedEventId);
    const hoveredId = useCampusLiveStore((state) => state.hoveredEventId);
    const detailId = useCampusLiveStore((state) => state.detailEventId);
    const selectEvent = useCampusLiveStore((state) => state.selectEvent);
    const setHovered = useCampusLiveStore((state) => state.setHoveredEvent);
    const openDetail = useCampusLiveStore((state) => state.openDetail);
    /* 移动端独立 UI：关闭 hover 交互、并由移动端自己的底部抽屉承接详情 */
    const isMobile = useUiStore((state) => state.isMobile);

    const layerRef = useRef<HTMLDivElement>(null);
    /** Leader Line SVG：fixed inset:0，直接 DOM 操作画线，不走 React 每帧重渲染 */
    const leaderLineSvgRef = useRef<SVGSVGElement>(null);
    /** 合并卡片 Ref 池（合并卡通过 React 渲染） */
    const clusterCalloutRefs = useRef(new Map<string, HTMLButtonElement>());
    /** 展开后的"列表卡" Ref 池（每个展开簇一张，锚定地图投影点，位置由 applyFrame 写 CSS 变量） */
    const clusterListRefs = useRef(new Map<string, HTMLDivElement>());
    // 注意：React 18 Strict Mode 下 ref callback 会在 mount→unmount→remount 中走 delete→set，
    // 与 projectEvents 的 schedule() requestAnimationFrame 之间存在竞态：applyFrame 先跑，
    // ref callback 还没重设，anchors 全找不到 → 不设置 --tx/--ty，铭牌全部堆在左上角。
    // 因此这里用 calloutRefs 做"快速路径"，找不到时再退一步用 layer.querySelector(data-id)。
    const calloutRefs = useRef(new Map<string, HTMLButtonElement>());
    const downXY = useRef<{ id: string; x: number; y: number } | null>(null);

    /* ---------------- 聚类合并展开状态（用户点 +N 徽标切换） ---------------- */
    const [expandedClusterIds, setExpandedClusterIds] = useState<Set<string>>(new Set());
    const toggleCluster = (clusterId: string) => {
        setExpandedClusterIds((prev) => {
            const next = new Set(prev);
            if (next.has(clusterId)) next.delete(clusterId);
            else next.add(clusterId);
            return next;
        });
    };

    const events = useMemo(
        () =>
            show
                ? (snapshot?.events ?? []).filter(
                      (event) => filters.length === 0 || filters.includes(event.category),
                  )
                : [],
        [snapshot, filters, show],
    );

    /** 按 id 查 event 对象（applyFrame 组装输入时查 severity / locationId 用） */
    const eventById = useMemo(() => {
        const m = new Map<string, CampusEvent>();
        events.forEach((e) => m.set(e.id, e));
        return m;
    }, [events]);

    /**
     * 聚类合并：相同 locationId 强制归一簇；
     * 不指定 locationId 则按 events 当前顺序归类（避免做坐标聚类前置导致与 anchors 时序错位——anchors 由投影直接发布带 screenXY，这里只按 locationId 粗粒度分簇即可）。
     * 簇内成员数 ≥ 3 且 expandedClusterIds 不包含 → 折叠为"+N"卡。
     */
    const clusters = useMemo<ClusterSummary[]>(() => {
        const byLoc = new Map<string, CampusEvent[]>();
        for (const e of events) {
            const k = e.locationId ?? `noloc_${e.id}`;
            if (!byLoc.has(k)) byLoc.set(k, []);
            byLoc.get(k)!.push(e);
        }
        const result: ClusterSummary[] = [];
        byLoc.forEach((arr, clusterKey) => {
            if (arr.length < EVENT_LAYOUT.clusterMergeMinSize) return;
            // cx/cy 占位（合并卡最终锚点由 applyFrame 内"成员几何中心"计算），
            // 这里给个 0，applyFrame 里实际会按成员 screen 坐标取几何中心）
            result.push({ clusterKey, members: arr, cx: 0, cy: 0 });
        });
        return result;
    }, [events]);

    /** clusterId → 需要隐藏在地图上的成员 id。
     *  折叠（未展开）簇 → 全部成员隐藏进 +N 卡；
     *  展开簇 → 全部成员隐藏进"列表卡"，点击某项仅打开详情（不再单独弹出铭牌）。 */
    const foldedMemberIds = useMemo(() => {
        const set = new Set<string>();
        clusters.forEach((c) => {
            c.members.forEach((m) => set.add(m.id));
        });
        return set;
    }, [clusters]);

    /* 详情抽屉已提取为独立组件 EventDetailDrawer，此处不再处理详情逻辑 */

    /* ref：让 useLayoutEffect 闭包内读到最新值（无需重建 effect，避免清理/重建副作用）*/
    const expandedClusterIdsRef = useRef(expandedClusterIds);
    expandedClusterIdsRef.current = expandedClusterIds;
    /** 主 effect 暴露的"重投影调度器"：展开/收起聚簇或 filter 变化时，需要强制重跑一次 applyFrame，
     * 否则成员卡的 --o 仍是折叠时的 0，点击 +N 后只会让聚类卡消失、成员卡却不出现。 */
    const repaintRef = useRef<(() => void) | null>(null);
    const eventByIdRef = useRef(eventById);
    eventByIdRef.current = eventById;
    const clustersRef = useRef(clusters);
    clustersRef.current = clusters;
    const foldedMemberIdsRef = useRef(foldedMemberIds);
    foldedMemberIdsRef.current = foldedMemberIds;
    const pinnedIdsRef = useRef<{ selected: string | null; hovered: string | null; detail: string | null }>({
        selected: selectedId, hovered: hoveredId, detail: detailId,
    });
    pinnedIdsRef.current = { selected: selectedId, hovered: hoveredId, detail: detailId };
    const setHoveredRef = useRef(setHovered);
    setHoveredRef.current = setHovered;
    const openDetailRef = useRef(openDetail);
    openDetailRef.current = openDetail;

    /* ---------------- 投影同步：直接写 DOM，不走 React 60fps 重渲染 ---------------- */
    useLayoutEffect(() => {
        if (!show || !layerRef.current) return;
        const layer = layerRef.current;
        let anchors: readonly EventAnchor[] = [];
        const lineNs = 'http://www.w3.org/2000/svg';
        /** Leader Line DOM 池：key=eventId 或 clusterId，避免每帧增删 DOM 引起 GC */
        const lineEls = new Map<string, SVGLineElement>();

        let layerRect = { left: 0, top: 0, width: 0, height: 0 };
        function refreshLayerRect(): void {
            const r = layer.getBoundingClientRect();
            layerRect = { left: r.left, top: r.top, width: r.width, height: r.height };
            if (leaderLineSvgRef.current) {
                const svg = leaderLineSvgRef.current;
                svg.setAttribute('width', String(r.width));
                svg.setAttribute('height', String(r.height));
                svg.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
            }
        }
        refreshLayerRect();

        let dirty = false;
        function applyFrame() {
            dirty = false;
            const rect = layerRect;
            const viewH = Math.max(1, rect.height);
            const layerW = Math.max(1, rect.width);
            const scaleSpan = SCALE_NEAR - SCALE_FAR;
            const opacitySpan = OPACITY_NEAR - OPACITY_FAR;
            const invViewH = 1 / viewH;

            /* ====================== 步骤 1：把 anchors 转成 screenXY Map，方便合并卡取成员几何中心 ====================== */
            const anchorById = new Map<string, EventAnchor>();
            for (const a of anchors) anchorById.set(a.id, a);

            /* ====================== 步骤 2：组装 CalloutLayoutInput[] ====================== */
            const { selected: selId, hovered: hovId, detail: detId } = pinnedIdsRef.current;
            const evMap = eventByIdRef.current;
            const foldedSet = foldedMemberIdsRef.current;
            const inputs: CalloutLayoutInput[] = [];

            // 2a) 普通事件（未被折叠 → 参与避让）
            for (const a of anchors) {
                if (!a.visible) continue;
                if (foldedSet.has(a.id)) continue; // 被折叠 → 不参与碰撞
                const ev = evMap.get(a.id);
                const pinned = a.id === selId || a.id === hovId || a.id === detId;
                inputs.push({
                    id: a.id,
                    originX: a.x - rect.left,
                    originY: a.y - rect.top,
                    width: EVENT_LAYOUT.cardWidth,
                    height: EVENT_LAYOUT.cardHeight,
                    pinned,
                    interactPriority: pinned ? 100 : 0,
                    clusterKey: ev?.locationId,
                    severityWeight: ev ? severityWeight(ev.severity) : 5,
                    visible: true,
                });
            }
            // 2b) 合并卡（折叠态 → 以成员几何中心做输入；展开态 → 不输出合并卡）
            for (const c of clustersRef.current) {
                if (expandedClusterIdsRef.current.has(c.clusterKey)) continue;
                // 成员里至少有 N 个（clusterMergeMinSize）可见锚点才显示合并卡
                const visibleAnchors = c.members
                    .map((m) => anchorById.get(m.id))
                    .filter((x): x is EventAnchor => !!x && x.visible);
                if (visibleAnchors.length < EVENT_LAYOUT.clusterMergeMinSize) continue;
                const cx = visibleAnchors.reduce((s, a) => s + (a.x - rect.left), 0) / visibleAnchors.length;
                const cy = visibleAnchors.reduce((s, a) => s + (a.y - rect.top), 0) / visibleAnchors.length;
                const maxSev = c.members.reduce((m, e) => Math.max(m, severityWeight(e.severity)), 0);
                // pinned：合并卡包含任一 pinned 成员 → 合并卡整体 pinned
                const pinned = c.members.some((m) => m.id === selId || m.id === hovId || m.id === detId);
                inputs.push({
                    id: `cluster_${c.clusterKey}`,
                    originX: cx, originY: cy,
                    width: EVENT_LAYOUT.cardWidth,
                    height: EVENT_LAYOUT.cardHeight,
                    pinned,
                    interactPriority: pinned ? 100 : 0,
                    clusterKey: c.clusterKey,
                    severityWeight: maxSev,
                    visible: true,
                });
            }

            /* ====================== 步骤 3：布局计算 ====================== */
            const layoutMap = layoutCallouts(inputs, layerW, viewH, expandedClusterIdsRef.current);
            const liveLineIds = new Set<string>();

            /* ====================== 步骤 4：写普通铭牌位置/缩放/透明度 ====================== */
            for (const anchor of anchors) {
                let el = calloutRefs.current.get(anchor.id) ?? null;
                if (!el) {
                    el = layer.querySelector<HTMLButtonElement>(`[data-event-id="${CSS.escape(anchor.id)}"]`);
                    if (el) calloutRefs.current.set(anchor.id, el);
                }
                const lo = layoutMap.get(anchor.id);
                if (!el) continue;
                // 若该成员被折叠，或者锚点不可见 → 不显示
                const isFolded = foldedSet.has(anchor.id);
                if (!anchor.visible || isFolded) {
                    el.style.setProperty('--o', '0');
                    el.style.pointerEvents = 'none';
                    continue;
                }
                if (!lo) {
                    el.style.setProperty('--o', '0');
                    el.style.pointerEvents = 'none';
                    continue;
                }
                el.style.pointerEvents = '';
                const tx = lo.anchorX;
                const ty = lo.anchorY;
                el.style.setProperty('--tx', `${Math.round(tx * 10) * 0.1}px`);
                el.style.setProperty('--ty', `${Math.round(ty * 10) * 0.1}px`);
                const nearW = Math.max(0, Math.min(1, ty * invViewH));
                const scale = SCALE_FAR + scaleSpan * nearW;
                const depthOpacity = OPACITY_FAR + opacitySpan * nearW;
                /* 【用户口径】hovered/selected/detail 这三张"钉住"的卡：
                 * 直接跳透明度惩罚 + 远近淡入淡出，强制满不透明。
                 * 其余卡按"透视淡 × (1 - 重叠惩罚)"。
                 * 另外 CSS 类 .callout:hover / :focus-within 会再盖一层 opacity:1，
                 * 双重保证 hover 永远清晰。 */
                const isPinned =
                    anchor.id === selId || anchor.id === hovId || anchor.id === detId;
                /* 【用户口径】不透明度兜底控制：
                 *   - pinned（hover/selected/detail）→ 强制满不透明 1
                 *   - 普通卡 → 深度淡 ×（1 - 重叠惩罚）
                 *   - 额外：在 CSS 层 .callout:hover / :focus-within 又做了一次 opacity:1 !important 兜底，
                 *     真正鼠标悬停时不管 JS 写了啥都必然实色显示。*/
                const finalOpacity = isPinned
                    ? 1
                    : Math.max(0, depthOpacity * (1 - lo.opacityPenalty));
                el.style.setProperty('--s', `${Math.round(scale * 1000) * 0.001}`);
                el.style.setProperty('--o', `${Math.round(finalOpacity * 100) * 0.01}`);
                /* 【用户口径】hover/selected/detail 卡：
                 * 行内 style.opacity 直接写 '1' !important，
                 * 压过 applyFrame 自己写入的 --o / CSS 规则中的 opacity 自定义属性引用。
                 * （getComputedStyle 实验：行内 !important > 类选择器 > 普通 inline，必然生效）*/
                if (isPinned) {
                    el.style.setProperty('opacity', '1', 'important');
                } else {
                    if (el.style.getPropertyPriority('opacity') === 'important') {
                        el.style.removeProperty('opacity');
                    } else if (el.style.opacity) {
                        el.style.removeProperty('opacity');
                    }
                }
                /* :hover / :focus-within 强制不透明（兜底）：
                 * 「JS 感知到的 hovId」= 当前 pointerentered 的那张。
                 * 而「真正 CSS :hover」有可能是用户鼠标暂时没动、但 setHovered(null) 还没发（例如鼠标移出 canvas），
                 * 两者略有差异，所以用双保险：CSS 写 !important，JS 在应用时也对 hovId 写 !important 行内。*/

                // Leader Line：偏移超阈值且 SVG 已挂载 → 画线（从卡片底部中心 → 原始锚点）
                // 【用户口径】stroke 颜色 alpha 提至 0.95，粗细改 1.8，虚线更密（4,1.6），保证看得见。
                if (lo.showLeader && leaderLineSvgRef.current) {
                    liveLineIds.add(anchor.id);
                    let line = lineEls.get(anchor.id);
                    const lineStartY = ty + EVENT_LAYOUT.cardOffsetY;
                    const x1 = Math.round(tx);
                    const y1 = Math.round(lineStartY);
                    const x2 = Math.round(lo.originX);
                    const y2 = Math.round(lo.originY);
                    if (!line) {
                        line = document.createElementNS(lineNs, 'line');
                        line.setAttribute('stroke', 'var(--callout-leader-stroke, rgba(120, 132, 160, 0.95))');
                        line.setAttribute('stroke-width', '1.8');
                        line.setAttribute('stroke-linecap', 'round');
                        line.setAttribute('stroke-dasharray', '4 1.6');
                        line.setAttribute('pointer-events', 'none');
                        lineEls.set(anchor.id, line);
                        leaderLineSvgRef.current.appendChild(line);
                    }
                    line.setAttribute('x1', String(x1));
                    line.setAttribute('y1', String(y1));
                    line.setAttribute('x2', String(x2));
                    line.setAttribute('y2', String(y2));
                    line.style.display = '';
                }
            }

            /* ====================== 步骤 5：写合并卡位置/缩放/透明度 + Leader Line ====================== */
            for (const c of clustersRef.current) {
                const mergedId = `cluster_${c.clusterKey}`;
                const lo = layoutMap.get(mergedId);
                let btn = clusterCalloutRefs.current.get(mergedId) ?? null;
                if (!btn) {
                    btn = layer.querySelector<HTMLButtonElement>(`[data-cluster-id="${CSS.escape(c.clusterKey)}"]`);
                    if (btn) clusterCalloutRefs.current.set(mergedId, btn);
                }
                if (!btn) continue;
                const isExpanded = expandedClusterIdsRef.current.has(c.clusterKey);
                if (isExpanded || !lo) {
                    btn.style.setProperty('--o', '0');
                    btn.style.pointerEvents = 'none';
                    continue;
                }
                btn.style.pointerEvents = '';
                const tx = lo.anchorX;
                const ty = lo.anchorY;
                btn.style.setProperty('--tx', `${Math.round(tx * 10) * 0.1}px`);
                btn.style.setProperty('--ty', `${Math.round(ty * 10) * 0.1}px`);
                const nearW = Math.max(0, Math.min(1, ty * invViewH));
                const scale = SCALE_FAR + scaleSpan * nearW;
                const depthOpacity = OPACITY_FAR + opacitySpan * nearW;
                /* 合并卡 hover 同样强制不透明（CSS hover 类已兜底；此处额外 pinned 保护被 include 的 sel/hov/det） */
                const pinned = c.members.some((m) => m.id === selId || m.id === hovId || m.id === detId);
                const finalOpacity = pinned
                    ? 1
                    : Math.max(0, depthOpacity * (1 - lo.opacityPenalty));
                btn.style.setProperty('--s', `${Math.round(scale * 1000) * 0.001}`);
                btn.style.setProperty('--o', `${Math.round(finalOpacity * 100) * 0.01}`);
                if (pinned) {
                    btn.style.setProperty('opacity', '1', 'important');
                } else {
                    if (btn.style.getPropertyPriority('opacity') === 'important' || btn.style.opacity) {
                        btn.style.removeProperty('opacity');
                    }
                }
                // Leader Line
                if (lo.showLeader && leaderLineSvgRef.current) {
                    liveLineIds.add(mergedId);
                    let line = lineEls.get(mergedId);
                    const lineStartY = ty + EVENT_LAYOUT.cardOffsetY;
                    const x1 = Math.round(tx);
                    const y1 = Math.round(lineStartY);
                    const x2 = Math.round(lo.originX);
                    const y2 = Math.round(lo.originY);
                    if (!line) {
                        line = document.createElementNS(lineNs, 'line');
                        line.setAttribute('stroke', 'var(--callout-leader-stroke, rgba(120, 132, 160, 0.95))');
                        line.setAttribute('stroke-width', '1.8');
                        line.setAttribute('stroke-linecap', 'round');
                        line.setAttribute('stroke-dasharray', '4 1.6');
                        line.setAttribute('pointer-events', 'none');
                        lineEls.set(mergedId, line);
                        leaderLineSvgRef.current.appendChild(line);
                    }
                    line.setAttribute('x1', String(x1));
                    line.setAttribute('y1', String(y1));
                    line.setAttribute('x2', String(x2));
                    line.setAttribute('y2', String(y2));
                    line.style.display = '';
                }
            }

            /* ====================== 步骤 5b：为展开簇的"列表卡"写锚点位置 ======================
             * 列表卡锚定聚类几何中心（成员锚点均值），随相机移动；
             * 位置写 CSS 变量 --tx/--ty，缩放/透明度不复用 callout 的透视规则（列表卡整体可读）。 */
            for (const c of clustersRef.current) {
                if (!expandedClusterIdsRef.current.has(c.clusterKey)) continue;
                const card = clusterListRefs.current.get(c.clusterKey) ?? null;
                if (!card) continue;
                // 几何中心：取该簇所有可见成员锚点均值；全不可见则取簇内首成员
                const pts = c.members
                    .map((m) => anchorById.get(m.id))
                    .filter((x): x is EventAnchor => !!x && x.visible);
                const cx = pts.length
                    ? pts.reduce((s, a) => s + (a.x - rect.left), 0) / pts.length
                    : Math.round(rect.width / 2);
                const cy = pts.length
                    ? pts.reduce((s, a) => s + (a.y - rect.top), 0) / pts.length
                    : Math.round(rect.height / 2);
                card.style.setProperty('--tx', `${Math.round(cx * 10) * 0.1}px`);
                card.style.setProperty('--ty', `${Math.round(cy * 10) * 0.1}px`);
                card.style.opacity = '1';
            }

            /* ====================== 步骤 6：本轮未出现的 line 统一 display:none ====================== */
            lineEls.forEach((lineEl, k) => {
                if (!liveLineIds.has(k)) lineEl.style.display = 'none';
            });
        }

        const schedule = () => {
            if (dirty) return;
            dirty = true;
            queueMicrotask(applyFrame);
        };
        // 对外暴露，供 react 状态（展开/收起聚簇、筛选等）变化时强制重投影
        repaintRef.current = schedule;

        const ro = new ResizeObserver(() => {
            refreshLayerRect();
            schedule();
        });
        ro.observe(layer);
        window.addEventListener('resize', () => {
            refreshLayerRect();
            schedule();
        });
        const onScroll = () => refreshLayerRect();
        window.addEventListener('scroll', onScroll, true);
        const unsub = eventProjection.subscribe((next) => {
            anchors = next;
            schedule();
        });
        return () => {
            unsub();
            ro.disconnect();
            window.removeEventListener('resize', schedule);
            window.removeEventListener('scroll', onScroll, true);
            if (repaintRef.current === schedule) repaintRef.current = null;
        };
    }, [show, !!snapshot]);

    /* 聚簇展开/收起只改 React 状态，主 effect 的依赖不包含它、不会自动重投影：
     * 在展开集合变化时显式触发一次 applyFrame，刷新列表卡的位置与可见性。 */
    useEffect(() => {
        repaintRef.current?.();
    }, [expandedClusterIds]);

    /* 点"聚类列表卡以外"的任意地方（地图空白、其他活动、其他聚类卡）→ 收起所有展开的列表。
     * capture 阶段监听 pointerdown：目标不在任意已展开列表卡内即收起。
     * 头部向下，之后目标卡的 onClick 会负责打开它自己，形成"打开一块、收起其他"。 */
    useEffect(() => {
        const onPointerDown = (e: PointerEvent) => {
            const target = e.target as Element | null;
            if (!target) return;
            // 点在已展开的列表卡内部（点行/滚动/×）→ 不干预，由卡内交互自理
            if (target.closest('[data-cluster-list-id]')) return;
            setExpandedClusterIds(new Set());
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => document.removeEventListener('pointerdown', onPointerDown, true);
    }, []);

    if (!show || !snapshot) return null;

    return (
        <>
            {/* 铭牌层：fixed 全屏，不阻挡 canvas 的 pointer 事件 */}
            <div
                ref={layerRef}
                className={styles.layer}
                aria-label="地图事件标签"
                data-detail-open={detailId ? 'true' : 'false'}
            >
                {events.map((event) => {
                    const catColor = resolveEventColor(event.category, 'category');
                    const active = selectedId === event.id || hoveredId === event.id;
                    const focused = detailId === event.id;
                    const muted = !!detailId && detailId !== event.id;
                    return (
                        <button
                            key={event.id}
                            type="button"
                            data-event-id={event.id}
                            ref={(el) => {
                                if (el) calloutRefs.current.set(event.id, el);
                                else calloutRefs.current.delete(event.id);
                            }}
                            className={[
                                styles.callout,
                                active ? styles.isActive : '',
                                focused ? styles.isFocused : '',
                                muted ? styles.isMuted : '',
                            ].join(' ')}
                            style={{ '--callout-accent': catColor } as CSSProperties}
                            aria-label={`${event.title} · ${EVENT_CATEGORY_LABEL[event.category] ?? event.category} · 点击查看详情`}
                            aria-expanded={active}
                            onPointerDown={(e) => {
                                downXY.current = { id: event.id, x: e.clientX, y: e.clientY };
                            }}
                            onClick={(e) => {
                                const down = downXY.current;
                                if (down && down.id === event.id) {
                                    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
                                    if (moved > CLICK_SLOP_PX) return;
                                }
                                downXY.current = null;
                                // 打开详情时 3D 层会自动把镜头推到事件锚点
                                openDetail(detailId === event.id ? null : event.id);
                            }}
                            onPointerEnter={() => {
                                if (isMobile) return;
                                setHovered(event.id);
                                selectEvent(event.id);
                            }}
                            onPointerLeave={() => {
                                if (isMobile) return;
                                setHovered(null);
                            }}
                            onFocus={() => {
                                if (isMobile) return;
                                setHovered(event.id);
                            }}
                            onBlur={(e) => {
                                if (!e.currentTarget.contains(e.relatedTarget as Node)) setHovered(null);
                            }}
                        >
                            <span className={styles.calloutHead}>
                                <StatusDot status={event.status} />
                                <span className={styles.cat}>{EVENT_CATEGORY_LABEL[event.category]}</span>
                                <span className={styles.title}>{event.title}</span>
                                <span className={styles.status}>{EVENT_STATUS_LABEL[event.status]}</span>
                            </span>
                            <span className={styles.calloutExtra} aria-hidden={!active}>
                                <span className={styles.extraInner}>
                                    <span className={styles.metaRow}>
                                        <span className={styles.k}>时间</span>
                                        <span className={styles.v}>{fmtWindow(event.startTime)}</span>
                                    </span>
                                    {event.locationName && (
                                        <span className={styles.metaRow}>
                                            <span className={styles.k}>地点</span>
                                            <span className={styles.v}>{event.locationName}</span>
                                        </span>
                                    )}
                                    {event.participantCount != null && (
                                        <span className={styles.metaRow}>
                                            <span className={styles.k}>参与</span>
                                            <span className={styles.v}>{event.participantCount} 人</span>
                                        </span>
                                    )}
                                    {event.description && (
                                        <span className={styles.quote}>
                                            {event.description.length > 56
                                                ? event.description.slice(0, 56) + '…'
                                                : event.description}
                                        </span>
                                    )}
                                    <span className={styles.foot}>点击 · 展开完整详情</span>
                                </span>
                            </span>
                        </button>
                    );
                })}

                {/* ========== 合并折叠卡片：React 渲染，点击 +N 展开/收起成员卡 ========== */}
                {clusters.map((c) => {
                    if (c.members.length < EVENT_LAYOUT.clusterMergeMinSize) return null;
                    const expanded = expandedClusterIds.has(c.clusterKey);
                    if (expanded) return null;
                    // 合并卡使用成员中最高严重等级的颜色 + 第一个状态 dot
                    const topSev = c.members.reduce(
                        (best, e) => (severityWeight(e.severity) > severityWeight(best.severity) ? e : best),
                        c.members[0],
                    );
                    const catColor = resolveEventColor(topSev.category, 'category');
                    const active = hoveredId != null && c.members.some((m) => m.id === hoveredId);
                    return (
                        <button
                            key={`cluster_${c.clusterKey}`}
                            type="button"
                            data-cluster-id={c.clusterKey}
                            ref={(el) => {
                                const mergedId = `cluster_${c.clusterKey}`;
                                if (el) clusterCalloutRefs.current.set(mergedId, el);
                                else clusterCalloutRefs.current.delete(mergedId);
                            }}
                            className={[styles.callout, styles.isCluster, active ? styles.isActive : ''].join(' ')}
                            style={{ '--callout-accent': catColor } as CSSProperties}
                            aria-label={`${c.members.length} 个事件在同一位置：${c.members.map((m) => m.title).join('、')} · 点击展开列表`}
                            onClick={(e) => {
                                e.stopPropagation();
                                toggleCluster(c.clusterKey);
                            }}
                        >
                            {/* 统一说明性名牌：左侧大号 +X 数量徽标，右侧"N 个活动在此"说明文字 */}
                            <span className={styles.clusterHero}>
                                <span className={styles.clusterCount} aria-hidden="true">
                                    +{c.members.length}
                                </span>
                                <span className={styles.clusterDesc}>
                                    <span className={styles.clusterDescMain}>
                                        {c.members.length} 个活动在此
                                    </span>
                                    <span className={styles.clusterDescSub}>
                                        {c.members[0].title}…
                                    </span>
                                </span>
                            </span>
                        </button>
                    );
                })}

                {/* ========== 展开簇的"列表卡"：锚定聚类位置，列出成员，点击某项仅打开详情 ========== */}
                {clusters.map((c) => {
                    if (!expandedClusterIds.has(c.clusterKey)) return null;
                    const topSev = c.members.reduce(
                        (best, e) => (severityWeight(e.severity) > severityWeight(best.severity) ? e : best),
                        c.members[0],
                    );
                    return (
                        <div
                            key={`list_${c.clusterKey}`}
                            ref={(el) => {
                                if (el) clusterListRefs.current.set(c.clusterKey, el);
                                else clusterListRefs.current.delete(c.clusterKey);
                            }}
                            data-cluster-list-id={c.clusterKey}
                            className={styles.clusterList}
                            style={{ '--callout-accent': resolveEventColor(topSev.category, 'category') } as CSSProperties}
                            onClick={(e) => e.stopPropagation()}
                        >
                            <header className={styles.clusterListHead}>
                                <StatusDot status={topSev.status} />
                                <span className={styles.clusterListTitle}>
                                    {topSev.title}
                                    <span className={styles.clusterListCount}>等 {c.members.length} 项</span>
                                </span>
                                <button
                                    type="button"
                                    className={styles.clusterListClose}
                                    aria-label="收起列表"
                                    onClick={() => toggleCluster(c.clusterKey)}
                                >
                                    ×
                                </button>
                            </header>
                            <ul className={styles.clusterListBody}>
                                {c.members.map((m) => (
                                    <li key={m.id} className={styles.clusterListItem}>
                                        <button
                                            type="button"
                                            className={styles.clusterListItemBtn}
                                            style={{ '--callout-accent': resolveEventColor(m.category, 'category') } as CSSProperties}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                // 点击列表项 → 只触发查看详情，并收起列表卡
                                                setExpandedClusterIds((prev) => {
                                                    const next = new Set(prev);
                                                    next.delete(c.clusterKey);
                                                    return next;
                                                });
                                                // 打开详情时 3D 层会自动把镜头推到事件锚点
                                                openDetail(detailId === m.id ? null : m.id);
                                            }}
                                        >
                                            <StatusDot status={m.status} />
                                            <span className={styles.clusterListText}>
                                                <span className={styles.clusterListName}>{m.title}</span>
                                                <span className={styles.clusterListStatus}>
                                                    {EVENT_CATEGORY_LABEL[m.category] ?? m.category} · {EVENT_STATUS_LABEL[m.status]}
                                                </span>
                                            </span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    );
                })}
            </div>

            {/* Leader Line SVG：指引线铺在 layer 下方（z-index 低），不拦截事件 */}
            <svg
                ref={leaderLineSvgRef}
                className={styles.leaderLines}
                aria-hidden="true"
            />

            {/* 详情抽屉已提取为独立组件 EventDetailDrawer，在 App 层渲染 */}
        </>
    );
}
