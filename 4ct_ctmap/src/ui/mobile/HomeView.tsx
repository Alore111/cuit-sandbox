import { type CSSProperties } from 'react';
import { useMapStore } from '../../store/mapStore';
import { useCampusLiveStore } from '../../store/campusLiveStore';
import {
    EVENT_CATEGORY_LABEL,
    EVENT_STATUS_LABEL,
    resolveEventColor,
} from '../../contract/campusLive';
import type { Building, CampusEvent } from '../../contract';
import { fmtDuration, fmtTime } from './format';
import styles from './mobile.module.css';

/* 稳定的空数组常量：zustand 选择器必须返回稳定引用，
 * 否则 `?? []` / `.filter()` 每次都产生新数组，会触发 getSnapshot 无限循环。 */
const EMPTY_EVENTS: CampusEvent[] = [];

/**
 * 首页视图：校园实况概览 + 活动列表。
 * 搜索功能已移至 MobileLayout 顶部搜索框，聚焦时展开为独立搜索页面。
 */
export function HomeView({
    onOpenEvent,
    onOpenBuilding,
}: {
    onOpenEvent: (id: string) => void;
    onOpenBuilding: (id: string) => void;
}) {
    const events = useCampusLiveStore((state) => state.snapshot?.events ?? EMPTY_EVENTS);
    const summary = useCampusLiveStore((state) => state.snapshot?.heatSummary ?? null);
    // 保留 buildings 引用供未来扩展（如推荐建筑列表）
    const _buildings = useMapStore((state) => state.dataset?.buildings);
    void _buildings;
    void onOpenBuilding;

    const avgHeat = summary ? summary.campusAvgHeat.toFixed(1) : '—';

    return (
        <div className={styles.home}>
            <div className={styles.scroll}>
                {/* 校园实况概览 */}
                {summary && (
                    <div className={styles.liveCard}>
                        <span className={styles.liveCardValue}>{avgHeat}</span>
                        <span className={styles.liveCardText}>
                            <span className={styles.liveCardTitle}>校园实时热度</span>
                            <span className={styles.liveCardSub}>
                                {summary.totalHotSpots} 个热点 · 极热 {summary.criticalCount} · 高热{' '}
                                {summary.highCount}
                            </span>
                        </span>
                    </div>
                )}

                {/* 活动列表 */}
                <div className={styles.sectionHead}>
                    <span className={styles.sectionTitle}>校园活动</span>
                    <span className={styles.sectionCount}>{events.length}</span>
                </div>
                <div className={styles.listStack}>
                    {events.length === 0 ? (
                        <div className={styles.empty}>
                            <span className={styles.emptyIcon} aria-hidden="true">◌</span>
                            暂无校园活动
                        </div>
                    ) : (
                        events.map((e) => (
                            <EventCard key={e.id} event={e} onPress={onOpenEvent} />
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}

function EventCard({
    event,
    onPress,
}: {
    event: CampusEvent;
    onPress: (id: string) => void;
}) {
    const accent = resolveEventColor(event.category, 'category');
    return (
        <button
            type="button"
            className={[styles.eventRow, styles.expandRow].join(' ')}
            style={{ '--row-accent': accent } as CSSProperties}
            onClick={() => onPress(event.id)}
        >
            <span className={styles.eventRowAccent} aria-hidden="true" />
            <span className={styles.eventRowBody}>
                <span className={styles.eventRowTitle}>{event.title}</span>
                <span className={styles.eventRowMeta}>
                    <span className={styles.eventRowDot} aria-hidden="true" />
                    <span>{EVENT_STATUS_LABEL[event.status]}</span>
                    {event.locationName && <span>{event.locationName}</span>}
                    <span className={styles.eventRowTag}>{EVENT_CATEGORY_LABEL[event.category]}</span>
                    {event.startTime && <span>{fmtTime(event.startTime)}</span>}
                    {event.startTime && event.endTime && (
                        <span>{fmtDuration(event.startTime, event.endTime)}</span>
                    )}
                </span>
                {event.description && <span className={styles.eventRowDesc}>{event.description}</span>}
            </span>
        </button>
    );
}
