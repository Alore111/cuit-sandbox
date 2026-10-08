import type { CSSProperties } from 'react';
import { Fragment, useMemo } from 'react';
import { useMapStore } from '../../store/mapStore';
import { useCampusLiveStore } from '../../store/campusLiveStore';
import { useSelectionStore } from '../../store/selectionStore';
import {
    EVENT_STATUS_LABEL,
    EVENT_SEVERITY_LABEL,
    EVENT_CATEGORY_LABEL,
    resolveEventColor,
} from '../../contract/campusLive';
import type { CampusEvent } from '../../contract';
import { fmtRange } from './format';
import styles from './mobile.module.css';

/* 稳定空数组：zustand 选择器必须返回稳定引用，避免 getSnapshot 无限循环 */
const EMPTY_EVENTS: CampusEvent[] = [];

/* ================================================================
   抽屉内的两个详情面板：活动 / 建筑。
   共用同一骨架（返回 + kicker + 标题 + 信息网格 + 正文 + 操作），
   保证两种详情在移动端的观感与交互完全一致。
================================================================ */

interface PanelShellProps {
    onBack: () => void;
    kicker: string;
    accent: string;
    title: string;
    children: React.ReactNode;
}

function PanelShell({ onBack, kicker, accent, title, children }: PanelShellProps) {
    return (
        <div
            className={styles.detailPanel}
            style={{ ['--panel-accent' as string]: accent } as CSSProperties}
        >
            <div className={styles.detailHead}>
                <button type="button" className={styles.backBtn} aria-label="返回" onClick={onBack}>
                    ‹
                </button>
                <span className={styles.detailKicker}>{kicker}</span>
            </div>
            <div className={styles.detailBody}>
                <h2 className={styles.detailTitle}>{title}</h2>
                {children}
            </div>
        </div>
    );
}

/* ---------------- 活动详情 ---------------- */
export function EventDetailPanel({ id, onBack }: { id: string; onBack: () => void }) {
    const event = useCampusLiveStore((s) => s.snapshot?.events.find((e) => e.id === id) ?? null);
    if (!event) {
        return (
            <PanelShell onBack={onBack} kicker="活动详情" accent="var(--amber)" title="活动已下线">
                <div className={styles.empty}>
                    <span className={styles.emptyIcon} aria-hidden="true">◌</span>
                    该活动已从最新实况中移除
                </div>
            </PanelShell>
        );
    }

    const accent = resolveEventColor(event.category, 'category');
    const rows: Array<[string, string]> = [
        ['状态', EVENT_STATUS_LABEL[event.status]],
        ['等级', EVENT_SEVERITY_LABEL[event.severity]],
    ];
    if (event.startTime) rows.push(['时间', fmtRange(event.startTime, event.endTime)]);
    if (event.locationName) rows.push(['地点', event.locationName]);
    if (event.geoText) rows.push(['位置', event.geoText]);
    if (event.organizer) rows.push(['主办', event.organizer]);
    if (event.participantCount != null) rows.push(['参与', `${event.participantCount} 人`]);

    return (
        <PanelShell
            onBack={onBack}
            kicker={`${EVENT_CATEGORY_LABEL[event.category]} · ${EVENT_STATUS_LABEL[event.status]}`}
            accent={accent}
            title={event.title}
        >
            <dl className={styles.detailGrid}>
                {rows.map(([k, v]) => (
                    <Fragment key={k}>
                        <dt>{k}</dt>
                        <dd>{v}</dd>
                    </Fragment>
                ))}
            </dl>
            {event.description && <p className={styles.detailDesc}>{event.description}</p>}
            {event.tags && event.tags.length > 0 && (
                <div className={styles.detailTags}>
                    {event.tags.map((t, i) => (
                        <span key={i} className={styles.miniTag}>
                            {t}
                        </span>
                    ))}
                </div>
            )}
            {event.jumpUrl && (
                <button
                    type="button"
                    className={styles.detailJump}
                    onClick={() => window.open(event.jumpUrl!, '_blank', 'noopener,noreferrer')}
                >
                    ↗ 跳转到原页面
                </button>
            )}
        </PanelShell>
    );
}

/* ---------------- 建筑详情 ---------------- */
export function BuildingDetailPanel({ id, onBack }: { id: string; onBack: () => void }) {
    const building = useMapStore((s) =>
        s.dataset ? s.dataset.buildings.find((b) => b.id === id) ?? null : null
    );
    // 选择器只取稳定引用（events 数组本身），过滤放到 useMemo 里，
    // 避免在 selector 中 .filter() 每次生成新数组导致无限重渲染。
    const allEvents = useCampusLiveStore((s) => (s.snapshot ? s.snapshot.events : null));
    const relatedEvents = useMemo(
        () => (allEvents ?? EMPTY_EVENTS).filter((e) => e.locationId === id),
        [allEvents, id]
    );
    const select = useSelectionStore((s) => s.select);

    if (!building) {
        return (
            <PanelShell onBack={onBack} kicker="建筑信息" accent="var(--amber)" title="未找到该建筑">
                <div className={styles.empty}>
                    <span className={styles.emptyIcon} aria-hidden="true">◌</span>
                    数据集中没有这栋建筑
                </div>
            </PanelShell>
        );
    }

    const rows: Array<[string, string]> = [
        ['类型', building.typeLabel],
        ['层数', `${building.floors} 层`],
        ['层高', `${building.floorHeight} m`],
        ['高度', `${building.heightMeters} m`],
        ['面积', `${Math.round(building.areaM2)} ㎡`],
        // ['来源', building.source === 'osm' ? 'OSM 抓取' : '人工录入'],
    ];

    return (
        <PanelShell onBack={onBack} kicker={building.typeLabel} accent="var(--amber)" title={building.name}>
            <dl className={styles.detailGrid}>
                {rows.map(([k, v]) => (
                    <Fragment key={k}>
                        <dt>{k}</dt>
                        <dd>{v}</dd>
                    </Fragment>
                ))}
            </dl>

            {/* 该建筑上的活动：点可继续下钻到活动详情 */}
            {relatedEvents.length > 0 && (
                <>
                    <div className={styles.sectionHead}>
                        <span className={styles.sectionTitle}>此处的活动</span>
                        <span className={styles.sectionCount}>{relatedEvents.length}</span>
                    </div>
                    <div className={styles.listStack}>
                        {relatedEvents.map((e) => (
                            <RelatedEventRow key={e.id} event={e} />
                        ))}
                    </div>
                </>
            )}

            {/* 重新定位：把镜头重新对准这栋楼（已选中时点按可复位构图） */}
            <button type="button" className={styles.detailJump} onClick={() => select(id)}>
                ⌖ 在地图上定位
            </button>
        </PanelShell>
    );
}

function RelatedEventRow({ event }: { event: CampusEvent }) {
    const openDetail = useCampusLiveStore((s) => s.openDetail);
    const accent = resolveEventColor(event.category, 'category');
    return (
        <button
            type="button"
            className={styles.eventRow}
            style={{ '--row-accent': accent } as CSSProperties}
            onClick={() => openDetail(event.id)}
        >
            <span className={styles.eventRowAccent} aria-hidden="true" />
            <span className={styles.eventRowBody}>
                <span className={styles.eventRowTitle}>{event.title}</span>
                <span className={styles.eventRowMeta}>
                    <span className={styles.eventRowDot} aria-hidden="true" />
                    <span>{EVENT_STATUS_LABEL[event.status]}</span>
                    <span className={styles.eventRowTag}>{EVENT_CATEGORY_LABEL[event.category]}</span>
                </span>
            </span>
        </button>
    );
}