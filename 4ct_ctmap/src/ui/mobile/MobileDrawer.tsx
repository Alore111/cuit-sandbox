import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useUiStore } from '../../store/uiStore';
import styles from './mobile.module.css';

/** 抽屉磁吸档位的可见比例。0 = 全收起（仅露一条手把），其余按屏占比。 */
export type SnapLevel = 'strip' | 'q1' | 'q2' | 'q3';

/* 收起态只露出手把区的可见高度（css px）。需与 mobile.module.css 的 .grabZone 高度匹配（padding 10+14、bar 5、gap 8、标题行 ~17）。 */
const STRIP_PX = 64;

/** 拖动结束时调用，把可见高度同步到地图取景（越展开地图上移越多，保持中心不躲进抽屉） */
function syncMapInset(visibleHeightPx: number): void {
    useUiStore.getState().setBottomInset(visibleHeightPx);
}

/**
 * 计算四个磁吸档位相对视口顶部的 Y。
 * @param vh 视口逻辑高度
 */
function computeSnapTops(vh: number): Array<{ key: SnapLevel; top: number }> {
    return [
        { key: 'strip', top: vh - STRIP_PX },
        { key: 'q1', top: Math.round(vh * 0.75) },
        { key: 'q2', top: Math.round(vh * 0.5) },
        { key: 'q3', top: Math.round(vh * 0.25) },
    ];
}

function findClosest(top: number, tops: Array<{ key: SnapLevel; top: number }>): SnapLevel {
    let best = tops[0];
    let bestDist = Infinity;
    for (const t of tops) {
        const d = Math.abs(top - t.top);
        if (d < bestDist) {
            bestDist = d;
            best = t;
        }
    }
    return best.key;
}

const initSnapTops = (vh: number) => computeSnapTops(vh || 700);

interface MobileDrawerProps {
    /** 当前内容视图：详情态时抽屉自动升到 3/4 屏 */
    view: string; // 'home'
    /** 外部触发的展开请求（如搜索框聚焦时）：值变化即升到 3/4 屏 */
    expandSeq?: number;
    /** 需被抽屉承载的全部正文（首页/详情都由调用方渲染） */
    children: ReactNode;
}

/**
 * 移动端单一底部抽屉：可拖拽 + 磁吸四档（收起/1/4/1/2/3/4）。
 *  - 拖动跟手（pointer capture），松手按最近档位吸附，快速上滑/下滑会跨档；
 *  - 把手下方有可点的小档位指示，点一下逐级展开/收起，兼顾按键直达；
 *  - 抽屉每次位置变化都把可见高度同步给地图（setBottomInset），
 *    地图随之升高，中心始终留在可视区中央。
 */
export function MobileDrawer({ view, expandSeq, children }: MobileDrawerProps) {
    const [vh, setVh] = useState(() => window.innerHeight || 700);
    const [snapTops, setSnapTops] = useState<Array<{ key: SnapLevel; top: number }>>(() =>
        initSnapTops(window.innerHeight || 700)
    );

    /** 当前「吸附」档位 */
    const [level, setLevel] = useState<SnapLevel>('strip');
    /** 当前生效的抽屉顶 Y（渲染用）；dragging 时由 dragTop 接管 */
    const [top, setTop] = useState<number>(() => (window.innerHeight || 700) - STRIP_PX);
    const [mode, setMode] = useState<'idle' | 'dragging' | 'settling'>('idle');

    // 实时 top 供指针计算用（不存 React state，避免每个 move 都触发渲染）
    const topRef2 = useRef(top);
    const modeRef = useRef(mode);
    topRef2.current = top;
    modeRef.current = mode;
    // 实时档位供 resize 保持档位用（Android 软键盘弹起会触发 resize，必须读最新档位而非闭包旧值）
    const levelRef = useRef(level);
    levelRef.current = level;

    /* 首帧把当前（收起）可见高度同步给地图，避免地图一开始按满幅取景再跳一次 */
    useEffect(() => {
        syncMapInset(vh - topRef2.current);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /* ---------------- 尺寸监听 ---------------- */
    useEffect(() => {
        const onResize = () => {
            const next = window.innerHeight || 700;
            setVh(next);
            const tops = computeSnapTops(next);
            setSnapTops(tops);
            // 缩放后按当前档位重新落位（读 ref 拿最新档位，否则 Android 键盘弹起会误回落到 strip）
            const t = tops.find((s) => s.key === levelRef.current)?.top ?? tops[0].top;
            setTop(t);
            topRef2.current = t;
            syncMapInset(next - t);
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
        // level 依赖仅为 resize 时保持档位，这里用 ref 读取最新
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /* ---------------- 磁吸吸附 ---------------- */
    const snapTo = useCallback(
        (target: SnapLevel) => {
            const t = snapTops.find((s) => s.key === target)?.top ?? snapTops[0].top;
            setLevel(target);
            setMode('settling');
            setTop(t);
            topRef2.current = t;
            syncMapInset(vh - t);
            // transition 结束后恢复 idle
            window.setTimeout(() => {
                if (modeRef.current === 'settling') setMode('idle');
            }, 430);
            return t;
        },
        [snapTops, vh]
    );
    // snapTo 供 view-effect 使用（避免依赖 snapTops 重建）
    const snapToRef = useRef(snapTo);
    snapToRef.current = snapTo;

    /* ---------------- 拖拽 ---------------- */
    const drag = useRef<{ startY: number; startTop: number; lastY: number; lastT: number; moved: boolean } | null>(null);

    const onGrabDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (modeRef.current === 'settling') return;
        drag.current = { startY: e.clientY, startTop: topRef2.current, lastY: e.clientY, lastT: 0, moved: false };
        setMode('dragging');
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    };

    const onGrabMove = (e: ReactPointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        if (!d) return;
        const dy = e.clientY - d.startY;
        const nextTop = d.startTop + dy;
        const clamped = Math.max(snapTops[snapTops.length - 1].top, Math.min(vh, nextTop));
        d.lastT = e.clientY - d.lastY;
        d.lastY = e.clientY;
        if (Math.abs(dy) > 6) d.moved = true;
        setTop(clamped);
        topRef2.current = clamped;
        syncMapInset(vh - clamped);
    };

    const onGrabUp = () => {
        const d = drag.current;
        if (!d) return;
        drag.current = null;
        // 轻点（几乎没位移）：按地图 App 习惯 —— 收起→半屏，展开→收起
        if (!d.moved) {
            snapTo(level === 'strip' ? 'q2' : 'strip');
            return;
        }
        const currentTop = topRef2.current;
        const velocity = d.lastT; // 最后两帧的位移（px），向下为正
        // 速度跨档：向下滑（收起）或向上滑（展开）
        let next: SnapLevel = findClosest(currentTop, snapTops);
        if (Math.abs(velocity) > 20) {
            const idx = snapTops.findIndex((s) => s.key === next);
            const bump = velocity > 0 ? 1 : -1; // 下行→更收，上行→更展
            next = snapTops[Math.max(0, Math.min(snapTops.length - 1, idx + bump))].key;
        }
        snapTo(next);
    };

    /* 内容进入详情态 → 自动升到 3/4 屏（用 snapToRef 拿最新吸附函数，避免过期闭包） */
    useEffect(() => {
        if (view !== 'home') {
            snapToRef.current('q1');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [view]);

    /* 外部展开请求（如搜索框聚焦）→ 每次 seq 变化都升到 3/4 屏。
     * 详情态下抽屉本就是 q3，重复吸附无害。 */
    useEffect(() => {
        if (!expandSeq) return;
        snapToRef.current('q3');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [expandSeq]);

    const dotCount = level === 'strip' ? 0 : level === 'q1' ? 1 : level === 'q2' ? 2 : 3;
    const isExpanded = level !== 'strip';

    /* 手把标题随内容切换：首页=校园实况，详情页=对应详情名 */
    const grabLabel = !isExpanded
        ? '上滑查看校园实况'
        : view === 'event'
          ? '活动详情'
          : view === 'building'
            ? '建筑信息'
            : '校园实况';

    return (
        <div
            className={[
                styles.drawer,
                mode === 'dragging' ? styles.isDragging : '',
                mode === 'settling' ? styles.isSettling : '',
            ].join(' ')}
            style={{ ['--drawer-top' as string]: `${top}px` }}
        >
            <span className={styles.drawerGlow} aria-hidden="true" />
            {/* 手把区：拖动改高度，轻点收起/半屏切换 */}
            <div className={styles.grabZone} onPointerDown={onGrabDown} onPointerMove={onGrabMove} onPointerUp={onGrabUp}>
                <span className={styles.grabBar} aria-hidden="true" />
                <div className={styles.grabRow}>
                    <span className={styles.grabTitle}>
                        <span className={styles.grabDot} aria-hidden="true" />
                        <span className={styles.grabLabel}>{grabLabel}</span>
                    </span>
                    {/* 档位指示：纯展示，越高亮代表抽屉展开越高 */}
                    <span className={styles.snapDots} aria-hidden="true">
                        <span className={[styles.snapDot, dotCount >= 1 ? styles.on : ''].join(' ')} />
                        <span className={[styles.snapDot, dotCount >= 2 ? styles.on : ''].join(' ')} />
                        <span className={[styles.snapDot, dotCount >= 3 ? styles.on : ''].join(' ')} />
                    </span>
                </div>
            </div>
            {/* 正文：仅展开时展示（收起时不渲染，露出整块地图） */}
            {isExpanded && <div className={styles.drawerBody}>{children}</div>}
        </div>
    );
}