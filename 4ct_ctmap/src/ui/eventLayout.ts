export const EVENT_LAYOUT = {
    cardWidth: 192,
    cardHeight: 76,
    detailHeight: 248,
    gap: 12,
    anchorClearance: 18,
    /* ============ 【锚点铭牌碰撞避让】新增常量 ============ */
    /** 铭牌相对锚点的偏移：当前 CSS 是 translate(-50%, -100% - 12px)，
     *  即卡片中心水平对齐锚点，卡片底部在锚点上方 12px 处。 */
    cardOffsetX: 0,
    cardOffsetY: -12,
    /** 水平/垂直方向尝试避让的步长（像素） */
    nudgeStepX: 8,
    nudgeStepY: 8,
    /** 每个方向最多尝试几轮（控制最差复杂度） */
    maxNudgeRounds: 14,
    /** 偏移距离超过该像素时，画一条指引线（Leader Line）回原锚点 */
    leaderLineThresholdPx: 28,
    /** 两个锚点之间距离小于该值 → 视为同簇，若簇内 >=3 张卡片则做合并折叠 */
    clusterMergeThresholdPx: 56,
    /** 同簇卡片数量达到该阈值 → 启用合并折叠卡片 */
    clusterMergeMinSize: 3,
    /** 兜底：实在塞不下 → 允许最大重叠面积占比，超过就降透明度 */
    overlapToleranceRatio: 0.2,
    /** 兜底透明度衰减系数：重叠度越高越透明（与 overlapRatio 相乘） */
    overlapOpacityPenalty: 0.5,
} as const;

export interface CardTarget {
    id: string;
    x: number;
    y: number;
    expanded: boolean;
}

export interface CardPlacement {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

/* ================================================================
 * 锚点式铭牌布局（3D 地图事件标签专用）
 *    - AABB 碰撞检测 + 四向贪心偏移（上→右→左→下）
 *    - hovered/selected/detailId 的卡片"钉住"不动，其他卡让路
 *    - 偏移超过阈值 → 记录 Leader Line 起点终点
 *    - 同聚点超 N 张卡 → 折叠为一张合并卡（展开显示完整列表）
 *    - 完全排不下 → 允许小比例重叠 + 透明度惩罚
 * ================================================================ */

/** 单张铭牌的布局结果（输出给 React 层消费）*/
export interface CalloutLayoutResult {
    id: string;
    /** 最终卡片左上角（相对 layer）的锚点 X（传给 --tx 时会再转成卡片中心）*/
    anchorX: number;
    anchorY: number;
    /** 原始锚点（画 Leader Line 用）；若与 anchorX/Y 重合就不画线 */
    originX: number;
    originY: number;
    /** 是否需要画 Leader Line（=偏移量超阈值）*/
    showLeader: boolean;
    /** 透明度惩罚（0=无惩罚，1=完全透明）兜底重叠时使用 */
    opacityPenalty: number;
    /** 非空表示：这是一张合并折叠卡片，代表 N 个事件 */
    cluster?: {
        clusterId: string;
        size: number;
        /** 被合并进来的事件 id 列表（点击展开时用） */
        memberIds: string[];
        /** 是否处于展开状态 */
        expanded: boolean;
    };
}

/** 输入给布局算法的单张铭牌需求 */
export interface CalloutLayoutInput {
    id: string;
    /** 事件原锚点（eventProjection 发布的 screen 坐标，相对 viewport）*/
    originX: number;
    originY: number;
    /** 卡片尺寸（用 DOM 实际测量，若量不到就用 EVENT_LAYOUT 常量）*/
    width?: number;
    height?: number;
    /** 是否"钉住"不参与避让（hovered / selected / detailId）*/
    pinned?: boolean;
    /** 用户正在交互的优先级（同 pinned 时决定谁先占坑）*/
    interactPriority?: number;
    /** 事件的聚类键（同 locationId 强制归为一簇；不填就按坐标聚类）*/
    clusterKey?: string;
    /** 事件的严重等级（数字越大越优先占锚点附近位置）*/
    severityWeight?: number;
    /** 当前这张铭牌是否可见（不可见就直接排到结果里，不参与碰撞）*/
    visible?: boolean;
}

/* ---------------- 工具：AABB ---------------- */
interface Box {
    x: number; // left
    y: number; // top
    w: number;
    h: number;
}

function boxesIntersect(a: Box, b: Box): boolean {
    return (
        a.x < b.x + b.w &&
        a.x + a.w > b.x &&
        a.y < b.y + b.h &&
        a.y + a.h > b.y
    );
}

function overlapArea(a: Box, b: Box): number {
    const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return ix * iy;
}

/** 把"锚点 + 尺寸"展开为卡片的屏幕 AABB */
function calloutBox(
    ax: number, ay: number, w: number, h: number, { gap }: { gap: number }
): Box {
    // CSS 里 transform: translate3d(calc(tx - 50%), calc(ty - 100% - 12px), 0)
    //   tx/ty = 锚点（ax, ay）
    //   卡片中心水平 = tx → 左边界 = tx - w/2
    //   卡片底部 = ty - 12px → 上边界 = ty - 12 - h
    return {
        x: ax - w / 2 - gap / 2,
        y: ay - (EVENT_LAYOUT.cardOffsetY + h) - gap / 2,
        w: w + gap,
        h: h + gap,
    };
}

/* ---------------- 工具：聚类（DBSCAN 简化版，半径阈值内即同簇）---------------- */
interface ClusterItem {
    id: string;
    key: string; // = clusterKey ?? `${x},${y}` 规整化到阈值网格
    x: number;
    y: number;
}
function buildClusters<T extends ClusterItem>(items: T[], r: number): Map<string, T[]> {
    const clusters = new Map<string, T[]>();
    // 强制 clusterKey 相同的先归为一簇（即相同 locationId）
    const byForcedKey = new Map<string, T[]>();
    items.forEach((it) => {
        const rawKey = it.key;
        if (!byForcedKey.has(rawKey)) byForcedKey.set(rawKey, []);
        byForcedKey.get(rawKey)!.push(it);
    });
    // 对未指定强制 clusterKey 的按坐标做网格聚类（grid-based，便宜）
    byForcedKey.forEach((group) => {
        const bucket = new Map<string, T[]>();
        group.forEach((g) => {
            const bx = Math.floor(g.x / r);
            const by = Math.floor(g.y / r);
            const k = `${bx}_${by}`;
            if (!bucket.has(k)) bucket.set(k, []);
            bucket.get(k)!.push(g);
        });
        bucket.forEach((arr, k) => {
            clusters.set(k, arr);
        });
    });
    return clusters;
}

/** 主入口：计算每一张铭牌的最终坐标、指引线参数与合并折叠状态。
 *  返回的 Map 以 event id 为键；合并卡片会多出一个虚拟 id（`cluster_${clusterKey}`）。
 *  - layerWidth / layerHeight：用于把卡片限制在可见区域内
 *  - expandedClusterIds：哪些合并卡片处于"展开全部"状态，展开时就不做折叠、各自参与避让
 */
/** layoutCallouts 内部使用的规范化输入：所有字段都是非空必选，避免 TS 推断 undefined */
interface NormalizedCalloutInput {
    id: string;
    originX: number;
    originY: number;
    width: number;
    height: number;
    pinned: boolean;
    interactPriority: number;
    clusterKey?: string;
    severityWeight: number;
    visible: true;
    /** 合并卡专用：成员事件 id 列表 */
    memberIds?: string[];
}

export function layoutCallouts(
    inputs: CalloutLayoutInput[],
    layerWidth: number,
    layerHeight: number,
    expandedClusterIds: Set<string>
): Map<string, CalloutLayoutResult> {
    const {
        cardWidth, cardHeight, gap,
        nudgeStepX, nudgeStepY, maxNudgeRounds,
        leaderLineThresholdPx,
        clusterMergeThresholdPx, clusterMergeMinSize,
        overlapToleranceRatio, overlapOpacityPenalty,
    } = EVENT_LAYOUT;
    const result = new Map<string, CalloutLayoutResult>();

    // 1) 预处理：过滤不可见 → 构造带默认尺寸/权重的输入
    const visibleInputs: NormalizedCalloutInput[] = inputs
        .filter((i) => i.visible !== false)
        .map((i) => ({
            id: i.id,
            originX: i.originX,
            originY: i.originY,
            width: i.width ?? cardWidth,
            height: i.height ?? cardHeight,
            pinned: !!i.pinned,
            interactPriority: i.interactPriority ?? 0,
            clusterKey: i.clusterKey,
            severityWeight: i.severityWeight ?? 0,
            visible: true as const,
        }));

    if (visibleInputs.length === 0) return result;

    // 2) 聚类：同簇 >=3 且不在 expandedClusterIds 中 → 折叠为一张卡
    const clusterGrid = Math.max(8, Math.floor(clusterMergeThresholdPx * 0.8));
    const clusterItems: ClusterItem[] = visibleInputs.map((i) => ({
        id: i.id,
        key: i.clusterKey ?? `${Math.floor(i.originX / clusterGrid)}_${Math.floor(i.originY / clusterGrid)}`,
        x: i.originX,
        y: i.originY,
    }));
    const clusters = buildClusters(clusterItems, clusterGrid);

    // 折叠映射：eventId → 若被折叠则对应的合并卡 id
    const foldedInto = new Map<string, string>();
    // 合并卡片的输入项（虚拟 input）
    const mergedInputs: NormalizedCalloutInput[] = [];

    clusters.forEach((members, clusterKey) => {
        // 有任意一张 pinned/展开 → 该簇不合并
        const anyPinned = members.some((m) => visibleInputs.find((v) => v.id === m.id)?.pinned);
        const expanded = expandedClusterIds.has(clusterKey);
        if (members.length >= clusterMergeMinSize && !anyPinned && !expanded) {
            const cx = members.reduce((s, m) => s + m.x, 0) / members.length;
            const cy = members.reduce((s, m) => s + m.y, 0) / members.length;
            const mergedId = `cluster_${clusterKey}`;
            members.forEach((m) => foldedInto.set(m.id, mergedId));
            const maxSev = Math.max(
                ...members.map((m) => visibleInputs.find((v) => v.id === m.id)?.severityWeight ?? 0)
            );
            const memberIds = members.map((m) => m.id);
            mergedInputs.push({
                id: mergedId,
                originX: cx,
                originY: cy,
                width: cardWidth,
                height: cardHeight,
                pinned: false,
                interactPriority: 0,
                clusterKey,
                severityWeight: maxSev,
                visible: true,
                memberIds,
            });
        }
    });

    // 3) 生成"真正需要参与碰撞排布"的卡片列表：
    const layoutList: NormalizedCalloutInput[] = visibleInputs
        .filter((v) => !foldedInto.has(v.id))
        .concat(mergedInputs);

    // 4) 排序：钉住 > 严重等级高 > 交互优先级高（先排先占坑，位置最稳）
    layoutList.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        if ((a.severityWeight ?? 0) !== (b.severityWeight ?? 0)) {
            return (b.severityWeight ?? 0) - (a.severityWeight ?? 0);
        }
        return (b.interactPriority ?? 0) - (a.interactPriority ?? 0);
    });

    // 5) 贪心排布 + 偏移避让
    const placed: Box[] = [];

    for (const item of layoutList) {
        const w = item.width;
        const h = item.height;
        let ax = item.originX;
        let ay = item.originY;

        if (!item.pinned) {
            let placeFound = false;
            const tryCandidate = (bx: number, by: number): boolean => {
                const test = calloutBox(bx, by, w, h, { gap });
                if (test.x < 0) return false;
                if (test.y < 0) return false;
                if (test.x + test.w > layerWidth) return false;
                if (test.y + test.h > layerHeight) return false;
                for (const p of placed) {
                    if (boxesIntersect(test, p)) return false;
                }
                return true;
            };

            if (tryCandidate(ax, ay)) {
                placeFound = true;
            } else {
                outer: for (let round = 1; round <= maxNudgeRounds; round++) {
                    const sx = nudgeStepX * round;
                    const sy = nudgeStepY * round;
                    const dirs: Array<[number, number]> = [
                        [0, -sy],
                        [sx, -sy * 0.4],
                        [sx, 0],
                        [sx, sy * 0.4],
                        [0, sy],
                        [-sx, sy * 0.4],
                        [-sx, 0],
                        [-sx, -sy * 0.4],
                    ];
                    for (const [dx, dy] of dirs) {
                        if (tryCandidate(ax + dx, ay + dy)) {
                            ax += dx;
                            ay += dy;
                            placeFound = true;
                            break outer;
                        }
                    }
                }
            }

            // 兜底：塞不下 → 留在原位置，按重叠度降透明度
            let overlapRatio = 0;
            if (!placeFound) {
                const finalBox = calloutBox(ax, ay, w, h, { gap });
                let overlap = 0;
                for (const p of placed) overlap = Math.max(overlap, overlapArea(finalBox, p));
                overlapRatio = overlap / Math.max(1, (finalBox.w * finalBox.h));
            }
            const penaltyRaw =
                overlapRatio > overlapToleranceRatio
                    ? Math.min(1, (overlapRatio - overlapToleranceRatio) / (1 - overlapToleranceRatio)) * overlapOpacityPenalty
                    : 0;

            const finalBox = calloutBox(ax, ay, w, h, { gap });
            placed.push(finalBox);

            const offsetDist = Math.hypot(ax - item.originX, ay - item.originY);
            const extras: Partial<CalloutLayoutResult> = {};
            if (item.memberIds && item.memberIds.length > 0) {
                extras.cluster = {
                    clusterId: item.clusterKey ?? item.id,
                    size: item.memberIds.length,
                    memberIds: item.memberIds,
                    expanded: expandedClusterIds.has(item.clusterKey ?? item.id),
                };
            }
            result.set(item.id, {
                id: item.id,
                anchorX: ax,
                anchorY: ay,
                originX: item.originX,
                originY: item.originY,
                showLeader: offsetDist > leaderLineThresholdPx,
                opacityPenalty: penaltyRaw,
                ...extras,
            });
        } else {
            // pinned 卡片：原位置落地，不偏移但作为障碍物占坑；不画 Leader Line
            const finalBox = calloutBox(ax, ay, w, h, { gap });
            placed.push(finalBox);
            result.set(item.id, {
                id: item.id,
                anchorX: ax,
                anchorY: ay,
                originX: item.originX,
                originY: item.originY,
                showLeader: false,
                opacityPenalty: 0,
            });
        }
    }

    // 7) 折叠成员 → opacityPenalty=1（自身不可见，靠合并卡）
    foldedInto.forEach((mergedId, memberId) => {
        const merged = result.get(mergedId);
        if (!merged) return;
        result.set(memberId, {
            id: memberId,
            anchorX: merged.anchorX,
            anchorY: merged.anchorY,
            originX: merged.originX,
            originY: merged.originY,
            showLeader: false,
            opacityPenalty: 1,
        });
    });

    return result;
}

/** 槽位按离锚点的距离分配，空间不足时明确切换到可滚动列表，不丢弃事件。 */
export function layoutEventCards(targets: CardTarget[], width: number, height: number) {
    const { cardWidth, cardHeight, detailHeight, gap } = EVENT_LAYOUT;
    const columns = Math.max(1, Math.floor((width + gap) / (cardWidth + gap)));
    const rows = Math.max(0, Math.floor((height + gap) / (cardHeight + gap)));
    const actualWidth = Math.min(cardWidth, width);
    const strideX = columns > 1 ? (width - actualWidth) / (columns - 1) : 0;
    const occupied = new Set<number>();
    const placements: CardPlacement[] = [];
    for (const target of [...targets].sort((a, b) => Number(b.expanded) - Number(a.expanded))) {
        const cardH = target.expanded ? detailHeight : cardHeight;
        const span = Math.ceil((cardH + gap) / (cardHeight + gap));
        let best: { row: number; column: number; distance: number } | null = null;
        for (let row = 0; row + span <= rows; row++) {
            for (let column = 0; column < columns; column++) {
                if (Array.from({ length: span }, (_, offset) => (row + offset) * columns + column)
                    .some((slot) => occupied.has(slot))) continue;
                const x = column * strideX;
                const y = row * (cardHeight + gap);
                const clearance = EVENT_LAYOUT.anchorClearance;
                const coveredAnchors = targets.filter((anchor) =>
                    anchor.x >= x - clearance && anchor.x <= x + actualWidth + clearance &&
                    anchor.y >= y - clearance && anchor.y <= y + cardH + clearance).length;
                const distance = (x + actualWidth / 2 - target.x) ** 2 +
                    (y + cardH / 2 - target.y) ** 2 + coveredAnchors * (width ** 2 + height ** 2);
                if (!best || distance < best.distance) best = { row, column, distance };
            }
        }
        if (!best) {
            let y = 0;
            return {
                dense: true,
                placements: targets.map((item) => {
                    const h = item.expanded ? detailHeight : cardHeight;
                    const placement = { id: item.id, x: 0, y, width: actualWidth, height: h };
                    y += h + gap;
                    return placement;
                }),
                contentHeight: targets.reduce((total, item) =>
                    total + (item.expanded ? detailHeight : cardHeight) + gap, 0),
            };
        }
        for (let offset = 0; offset < span; offset++) occupied.add((best.row + offset) * columns + best.column);
        placements.push({
            id: target.id,
            x: best.column * strideX,
            y: best.row * (cardHeight + gap),
            width: actualWidth,
            height: cardH,
        });
    }
    return { dense: false, placements, contentHeight: height };
}
