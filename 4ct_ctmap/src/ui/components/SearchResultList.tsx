/* ================================================================
   搜索结果列表（共享组件）
   —— APP 与 PC 端共用，展示地点 + 事件的搜索结果。
      地点优先，按匹配度排序；点击触发回调。
   ================================================================ */

import type { CSSProperties } from 'react';
import type { SearchResultItem } from '../../contract';
import {
    EVENT_CATEGORY_LABEL,
    EVENT_STATUS_LABEL,
    resolveEventColor,
} from '../../contract/campusLive';
import styles from '../styles/search.module.css';

interface SearchResultListProps {
    items: SearchResultItem[];
    /** 点击地点 */
    onPlaceClick?: (item: SearchResultItem) => void;
    /** 点击事件 */
    onEventClick?: (item: SearchResultItem) => void;
    /** 搜索词（用于空态提示） */
    query?: string;
    /** 是否正在加载 */
    loading?: boolean;
}

/** 搜索结果列表 */
export function SearchResultList({
    items,
    onPlaceClick,
    onEventClick,
    query,
    loading,
}: SearchResultListProps) {
    // 按类型分组：地点在前，事件在后
    const placeItems = items.filter((i) => i.type === 'place');
    const eventItems = items.filter((i) => i.type === 'event');

    if (loading) {
        return (
            <div className={styles.loading}>
                <span className={styles.loadingDot} aria-hidden="true" />
                搜索中…
            </div>
        );
    }

    if (items.length === 0 && query) {
        return (
            <div className={styles.empty}>
                <span className={styles.emptyIcon} aria-hidden="true">◌</span>
                没有匹配「{query}」的结果
            </div>
        );
    }

    return (
        <div className={styles.resultList}>
            {/* 地点分组 */}
            {placeItems.length > 0 && (
                <>
                    <div className={styles.sectionHead}>
                        <span className={styles.sectionTitle}>地点</span>
                        <span className={styles.sectionCount}>{placeItems.length}</span>
                    </div>
                    <div className={styles.listStack}>
                        {placeItems.map((item, idx) => (
                            <PlaceRow
                                key={`place-${idx}-${item.name}`}
                                item={item}
                                onClick={() => onPlaceClick?.(item)}
                            />
                        ))}
                    </div>
                </>
            )}

            {/* 事件分组 */}
            {eventItems.length > 0 && (
                <>
                    <div className={styles.sectionHead}>
                        <span className={styles.sectionTitle}>活动</span>
                        <span className={styles.sectionCount}>{eventItems.length}</span>
                    </div>
                    <div className={styles.listStack}>
                        {eventItems.map((item, idx) => (
                            <EventRow
                                key={`event-${idx}-${item.eventData?.id}`}
                                item={item}
                                onClick={() => onEventClick?.(item)}
                            />
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}

/** 地点行 */
function PlaceRow({ item, onClick }: { item: SearchResultItem; onClick: () => void }) {
    const subType = item.placeData?.subType;
    const typeLabel = subType === 'building' ? '建筑'
        : subType === 'parcel' ? '地皮'
        : '地点';
    const tag = item.placeData?.typeLabel || typeLabel;

    return (
        <button
            type="button"
            className={styles.placeRow}
            style={{ '--row-accent': 'var(--amber)' } as CSSProperties}
            onClick={onClick}
        >
            <span className={styles.rowAccent} aria-hidden="true" />
            <span className={styles.rowBody}>
                <span className={styles.rowTitle}>{item.name}</span>
                <span className={styles.rowMeta}>
                    <span className={styles.rowTag}>{tag}</span>
                    {item.placeData?.buildingIds && (
                        <span>{item.placeData.buildingIds.length} 栋建筑</span>
                    )}
                </span>
            </span>
        </button>
    );
}

/** 事件行 */
function EventRow({ item, onClick }: { item: SearchResultItem; onClick: () => void }) {
    const ev = item.eventData;
    if (!ev) return null;

    const accent = resolveEventColor(ev.category as Parameters<typeof resolveEventColor>[0], 'category');
    const categoryLabel = EVENT_CATEGORY_LABEL[ev.category as keyof typeof EVENT_CATEGORY_LABEL] || ev.category;
    const statusLabel = EVENT_STATUS_LABEL[ev.status as keyof typeof EVENT_STATUS_LABEL] || ev.status;

    return (
        <button
            type="button"
            className={styles.eventRow}
            style={{ '--row-accent': accent } as CSSProperties}
            onClick={onClick}
        >
            <span className={styles.rowAccent} aria-hidden="true" />
            <span className={styles.rowBody}>
                <span className={styles.rowTitle}>{ev.title}</span>
                <span className={styles.rowMeta}>
                    <span className={styles.rowDot} aria-hidden="true" />
                    <span>{statusLabel}</span>
                    {ev.locationName && <span>{ev.locationName}</span>}
                    <span className={styles.rowTag}>{categoryLabel}</span>
                    {ev.startTime && <span>{formatTime(ev.startTime)}</span>}
                </span>
                {ev.description && <span className={styles.rowDesc}>{ev.description}</span>}
            </span>
        </button>
    );
}

/** 简化时间格式化（ISO → "MM/DD HH:mm"） */
function formatTime(iso: string): string {
    try {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return iso;
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const h = String(d.getHours()).padStart(2, '0');
        const min = String(d.getMinutes()).padStart(2, '0');
        return `${m}/${day} ${h}:${min}`;
    } catch {
        return iso;
    }
}
