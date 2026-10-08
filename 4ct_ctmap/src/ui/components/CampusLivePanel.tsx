import { useMemo, useState, type CSSProperties } from 'react';
import { useCampusLiveStore } from '../../store/campusLiveStore';
import { campusLiveService } from '../../services/campusLiveService';
import {
    HEAT_LEVEL_ORDER,
    HEAT_LEVEL_LABEL,
    EVENT_STATUS_LABEL,
    EVENT_SEVERITY_LABEL,
    EVENT_CATEGORY_LABEL,
    HEAT_LEVEL_THRESHOLDS,
    resolveEventColor,
} from '../../contract/campusLive';
import type { CampusEvent } from '../../contract';
import styles from '../styles/campusLive.module.css';

function fmtTime(iso?: string): string {
    if (!iso) return '—';
    const d = new Date(iso);
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${m}/${day} ${hh}:${mm}`;
}

function fmtDuration(start?: string, end?: string): string {
    if (!start || !end) return '—';
    const s = new Date(start);
    const e = new Date(end);
    const mins = Math.max(1, Math.round((e.getTime() - s.getTime()) / 60000));
    if (mins < 60) return `${mins} 分钟`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h}h ${m}m` : `${h} 小时`;
}

function fmtAgo(t?: number): string {
    if (!t) return '';
    const diff = Date.now() - t;
    if (diff < 0) return '即将';
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    return `${Math.floor(diff / 86_400_000)} 天前`;
}

/** Tab 键：统一为"热度榜 / 校园事件"，配置已迁至 /editor 编辑页，主页不再承载配置功能 */
type TabKey = 'heat' | 'events';

function HeatLegend() {
    return (
        <div className={styles.heatLegend}>
            {HEAT_LEVEL_ORDER.map((lvl) => {
                const cls = [styles.dot, styles[`dotHeat_${lvl}`]].join(' ');
                return (
                    <div key={lvl} className={styles.heatLegendItem}>
                        <span className={cls} />
                        <span className={styles.legendText}>
                            {HEAT_LEVEL_LABEL[lvl]}
                            <span className={styles.legendSub}>
                                {lvl === 'critical' ? '≥80' : lvl === 'high' ? '60–79' : lvl === 'medium' ? '35–59' : '<35'}
                            </span>
                        </span>
                    </div>
                );
            })}
        </div>
    );
}

function SeverityChip({ severity }: { severity: CampusEvent['severity'] }) {
    const color = resolveEventColor(severity, 'severity');
    return (
        <span
            className={[styles.tag, styles[`sev_${severity}`]].join(' ')}
            style={{ borderColor: `${color}55`, background: `${color}18`, color }}
        >
            {EVENT_SEVERITY_LABEL[severity]}
        </span>
    );
}

function StatusChip({ status }: { status: CampusEvent['status'] }) {
    if (!status) return null;
    const cls = [styles.tag, styles[`status_${status}`]].join(' ');
    return <span className={cls}>{EVENT_STATUS_LABEL[status]}</span>;
}

export function CampusLivePanel() {
    const [tab, setTab] = useState<TabKey>('events');

    const {
        snapshot,
        status,
        error,
        showHeat, setShowHeat,
        showEvents, setShowEvents,
        heatFilterLevel, setHeatFilterLevel,
        eventCategoryFilter, toggleEventCategory,
        selectedEventId,
        detailEventId, openDetail,
        hoveredEventId, setHoveredEvent,
        refresh,
    } = useCampusLiveStore();

    const dataset = useCampusLiveStore((s) => s._dataset ?? null);
    const events = useMemo(
        () =>
            snapshot
                ? snapshot.events.filter(
                      (e) => eventCategoryFilter.length === 0 || eventCategoryFilter.includes(e.category)
                  )
                : [],
        [snapshot, eventCategoryFilter]
    );

    const version = snapshot?.version ?? '…';
    const usingUnified = version.startsWith('unified-api');
    const isEmpty = snapshot ? snapshot.events.length === 0 : false;
    const dataSource = usingUnified
        ? '统一校园事件接口'
        : campusLiveService.isMock()
            ? (isEmpty ? '未配置接口' : '校园实况 API')
            : '校园实况 API';

    return (
        <div className={styles.livePanel}>
            {/* ——— 头部：呼吸灯、标题、徽章、数据源、总开关 ——— */}
            <div className={styles.liveHead}>
                <div className={styles.liveTitleRow}>
                    <span className={styles.livePulse} />
                    <h3 className={styles.liveTitle}>校园实况</h3>
                    {snapshot && (
                        <span className={[styles.badge, usingUnified ? styles.badgeReal : styles.badgeMock].join(' ')}>
                            {dataSource}
                        </span>
                    )}
                </div>
                <div className={styles.liveMetaRow}>
                    {snapshot && <span>快照 {fmtAgo(snapshot.snapshotAt)}</span>}
                    <span>{status === 'loading' ? '正在更新' : status === 'error' ? '加载失败' : '光晕越高，地点越热'}</span>
                    <button
                        className={styles.tag}
                        type="button"
                        style={{ marginLeft: 'auto', cursor: 'pointer' }}
                        onClick={() => dataset && void refresh(dataset)}
                        disabled={status === 'loading'}
                    >
                        {status === 'loading' ? '更新中…' : '⟳ 刷新'}
                    </button>
                </div>

                <div className={styles.liveToggleRow}>
                    <label>
                        <input type="checkbox" checked={showHeat} onChange={(e) => setShowHeat(e.target.checked)} />
                        <span>热力光晕</span>
                    </label>
                    <label>
                        <input type="checkbox" checked={showEvents} onChange={(e) => setShowEvents(e.target.checked)} />
                        <span>校园事件</span>
                    </label>
                </div>
            </div>
            {/* {error && <p className={styles.empty} role="alert">{error}</p>} */}

            {/* 未配置第三方接口的空态引导（主页不承载配置，引导去 /editor） */}
            {!error && isEmpty && (
                <div className={styles.empty} role="status">
                    尚未配置校园事件接口，当前无数据。
                    <a
                        href="/editor"
                        style={{ color: 'inherit', textDecoration: 'underline', cursor: 'pointer' }}
                    >
                        前往编辑页配置事件接口
                    </a>
                </div>
            )}

            {/* ——— 热度统计卡（4 格） ——— */}
            {snapshot?.heatSummary && (
                <div className={styles.heatStatRow}>
                    <div className={styles.heatStat}>
                        <div className={styles.heatStatNum}>{snapshot.heatSummary.totalHotSpots}</div>
                        <div className={styles.heatStatLabel}>热点总数</div>
                    </div>
                    <div className={styles.heatStat}>
                        <div className={[styles.heatStatNum, styles.numCritical].join(' ')}>{snapshot.heatSummary.criticalCount}</div>
                        <div className={styles.heatStatLabel}>极热</div>
                    </div>
                    <div className={styles.heatStat}>
                        <div className={[styles.heatStatNum, styles.numHigh].join(' ')}>{snapshot.heatSummary.highCount}</div>
                        <div className={styles.heatStatLabel}>高热</div>
                    </div>
                    <div className={styles.heatStat}>
                        <div className={styles.heatStatNum}>{snapshot.heatSummary.campusAvgHeat}</div>
                        <div className={styles.heatStatLabel}>平均热度</div>
                    </div>
                </div>
            )}

            {/* ——— 热度筛选 + 热度图例 ——— */}
            <div className={styles.heatFilterRow}>
                <div className={styles.filterLabel}>最低热度</div>
                {HEAT_LEVEL_ORDER.map((lvl) => {
                    const active = heatFilterLevel === lvl;
                    return (
                        <button
                            key={lvl}
                            className={[styles.chip, active ? styles.chipActive : '', styles[`chipHeat_${lvl}`]].join(' ')}
                            aria-pressed={active}
                            onClick={() => setHeatFilterLevel(lvl)}
                        >
                            {lvl === 'low' ? '全部' : `${HEAT_LEVEL_LABEL[lvl]}及以上`}
                        </button>
                    );
                })}
            </div>
            <HeatLegend />

            {/* ——— Tab 栏：热度榜 / 校园事件 ——— */}
            <div className={styles.tabBar}>
                {(['heat', 'events'] as TabKey[]).map((t) => {
                    const label =
                        t === 'heat' ? '热度榜' :
                        `校园事件 ${events.length ? `·${events.length}` : ''}`;
                    return (
                        <button
                            key={t}
                            className={[styles.tab, tab === t ? styles.tabActive : ''].join(' ')}
                            onClick={() => setTab(t)}
                        >
                            {label}
                        </button>
                    );
                })}
            </div>

            {/* ——— Tab：热度榜 ——— */}
            {tab === 'heat' && snapshot && (
                <div className={styles.list}>
                    {[...snapshot.heatList]
                        .filter((heat) => showHeat && HEAT_LEVEL_THRESHOLDS[heat.heatLevel] >= HEAT_LEVEL_THRESHOLDS[heatFilterLevel])
                        .sort((a, b) => b.heatValue - a.heatValue)
                        .slice(0, 30)
                        .map((h) => (
                            <div key={h.id} className={styles.heatRow}>
                                <span className={[styles.dot, styles[`dotHeat_${h.heatLevel}`]].join(' ')} />
                                <div className={styles.heatRowBody}>
                                    <div className={styles.heatRowTitle}>
                                        <span className={styles.heatRowName}>{h.geoText}</span>
                                        <span className={[styles.tag, styles[
                                            `sev_${h.heatLevel === 'critical' ? 'special'
                                                : h.heatLevel === 'high' ? 'urgent'
                                                : h.heatLevel === 'medium' ? 'warning'
                                                : 'info'}`
                                        ]].join(' ')}>
                                            {h.heatValue}
                                        </span>
                                    </div>
                                    <div className={styles.heatRowSub}>
                                        {h.peopleCount != null ? `${h.peopleCount} 人 · ` : ''}{HEAT_LEVEL_LABEL[h.heatLevel]} · {fmtAgo(h.updatedAt)}
                                    </div>
                                    <div className={styles.heatBarBg}>
                                        <div
                                            className={[styles.heatBarFill, styles[`fillHeat_${h.heatLevel}`]].join(' ')}
                                            style={{ width: `${h.heatValue}%` }}
                                        />
                                    </div>
                                </div>
                            </div>
                        ))}
                </div>
            )}

            {/* ——— Tab：校园事件 ——— */}
            {tab === 'events' && (
                <>
                    <div className={styles.filterRow}>
                        <div className={styles.filterLabel}>分类</div>
                        {(Object.keys(EVENT_CATEGORY_LABEL) as Array<keyof typeof EVENT_CATEGORY_LABEL>).map((cat) => {
                            const active = eventCategoryFilter.includes(cat);
                            const color = resolveEventColor(cat, 'category');
                            return (
                                <button
                                    key={cat}
                                    className={[styles.chip, active ? styles.chipActive : ''].join(' ')}
                                    style={active ? { borderColor: `${color}aa`, background: `${color}22`, color } : undefined}
                                    onClick={() => toggleEventCategory(cat)}
                                >
                                    {EVENT_CATEGORY_LABEL[cat]}
                                </button>
                            );
                        })}
                    </div>
                    <div className={styles.list}>
                        {showEvents && events.map((e) => {
                            const catColor = resolveEventColor(e.category, 'category');
                            const highlighted = selectedEventId === e.id || detailEventId === e.id;
                            return (
                                <div
                                    key={e.id}
                                    className={[styles.card, highlighted ? styles.cardSelected : '', hoveredEventId === e.id ? styles.cardHovered : ''].join(' ')}
                                    style={{ '--card-accent': catColor } as CSSProperties}
                                    onPointerEnter={() => setHoveredEvent(e.id)}
                                    onPointerLeave={() => setHoveredEvent(null)}
                                >
                                    <div className={styles.cardHead}>
                                        <span
                                            className={styles.catDot}
                                            style={{ background: catColor, boxShadow: `0 0 8px ${catColor}aa` }}
                                        />
                                        <div className={styles.cardHeadText}>
                                            <button className={styles.eventSelect} aria-pressed={highlighted}
                                                onFocus={() => setHoveredEvent(e.id)} onBlur={() => setHoveredEvent(null)}
                                                onClick={() => openDetail(detailEventId === e.id ? null : e.id)}>
                                                {e.title}
                                            </button>
                                            <div className={styles.cardSub}>
                                                {e.locationName && `${e.locationName} · `}{fmtDuration(e.startTime, e.endTime)}
                                            </div>
                                        </div>
                                        <StatusChip status={e.status} />
                                    </div>
                                    {e.description && <div className={styles.cardDesc}>{e.description}</div>}
                                    <div className={styles.cardFoot}>
                                        <SeverityChip severity={e.severity} />
                                        <span
                                            className={styles.tag}
                                            style={{ borderColor: `${catColor}55`, background: `${catColor}18`, color: catColor }}
                                        >
                                            {EVENT_CATEGORY_LABEL[e.category]}
                                        </span>
                                        {e.participantCount != null ? (
                                            <span className={styles.tag}>参与 {e.participantCount}</span>
                                        ) : null}
                                        <span className={styles.tag}>{fmtTime(e.startTime)}</span>
                                        {e.organizer && <span className={styles.tag}>{e.organizer}</span>}
                                    </div>
                                    {!e.position && <span className={styles.cardSub}>无坐标，未在地图标注</span>}
                                    {e.tags && e.tags.length > 0 && (
                                        <div className={styles.tagRow}>
                                            {e.tags.map((t, i) => (
                                                <span key={i} className={styles.miniTag}>{t}</span>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                        {!showEvents ? <div className={styles.empty}>校园事件已隐藏</div> : events.length === 0 && <div className={styles.empty}>暂无符合条件的校园事件</div>}
                    </div>
                </>
            )}
        </div>
    );
}
