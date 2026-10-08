/* ================================================================
   事件详情抽屉（独立组件）
   —— 从 EventCalloutLayer 中提取，作为顶层浮层渲染。
      z-index 高于搜索栏（搜索栏 z-index: 100），确保详情面板始终在最上层。
   ================================================================ */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
    EVENT_CATEGORY_LABEL,
    EVENT_STATUS_LABEL,
    EVENT_SEVERITY_LABEL,
    resolveEventColor,
    unifiedToLegacyEvents,
    type CampusEvent,
    type UnifiedCampusEvent,
} from '../../contract/campusLive';
import { useCampusLiveStore } from '../../store/campusLiveStore';
import { campusLiveApi } from '../../api/campusLiveApi';
import styles from '../styles/eventDetailDrawer.module.css';

const dateFormat = new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
});

function StatusDot({ status }: { status: string }) {
    return <span className={styles.dot} data-status={status} aria-hidden="true" />;
}

/**
 * 事件详情抽屉（PC 端）
 * —— 从右侧滑入的全屏抽屉，展示事件完整信息。
 */
export function EventDetailDrawer() {
    const detailId = useCampusLiveStore((state) => state.detailEventId);
    const openDetail = useCampusLiveStore((state) => state.openDetail);

    /* 从快照中查找事件 */
    const snapshot = useCampusLiveStore((state) => state.snapshot);
    const detailEvent = useMemo<CampusEvent | null>(() => {
        if (!detailId) return null;
        const all = snapshot?.events ?? [];
        return all.find((e) => e.id === detailId) ?? null;
    }, [detailId, snapshot]);

    /* 详情接口拉取状态 */
    const [detailLoading, setDetailLoading] = useState(false);
    const [detailError, setDetailError] = useState<string | null>(null);
    const [detailPatch, setDetailPatch] = useState<Partial<CampusEvent> | null>(null);

    /** 最终展示的事件：列表项 + 详情补丁 */
    const mergedDetailEvent: CampusEvent | null = useMemo(() => {
        if (!detailEvent) return null;
        if (!detailPatch) return detailEvent;
        const next: CampusEvent = { ...detailEvent };
        (Object.keys(detailPatch) as Array<keyof CampusEvent>).forEach((k) => {
            const v = detailPatch[k];
            if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v;
        });
        return next;
    }, [detailEvent, detailPatch]);

    /** 关闭/切换时清空状态 */
    useEffect(() => {
        setDetailLoading(false);
        setDetailError(null);
        setDetailPatch(null);
        const currentId = detailId;
        if (!currentId) return;

        let cancelled = false;

        async function loadDetail() {
            if (cancelled) return;
            setDetailLoading(true);
            try {
                const event = await campusLiveApi.fetchUnifiedEventDetail(currentId!);
                if (cancelled) return;
                if (event) {
                    const fullArr = unifiedToLegacyEvents([event as UnifiedCampusEvent]);
                    const full = fullArr[0];
                    const patch: Partial<CampusEvent> = {};
                    (Object.keys(full) as Array<keyof CampusEvent>).forEach((k) => {
                        const v = full[k];
                        if (v !== undefined && v !== null && v !== '') {
                            (patch as unknown as Record<string, unknown>)[k] = v;
                        }
                    });
                    if (Object.keys(patch).length > 0) setDetailPatch(patch);
                }
                setDetailError(null);
            } catch (e) {
                if (cancelled) return;
                const msg = e instanceof Error ? e.message : String(e);
                console.warn('[EventDetailDrawer] 拉取事件详情失败：', msg);
                setDetailError(msg);
                setDetailPatch(null);
            } finally {
                if (!cancelled) setDetailLoading(false);
            }
        }

        loadDetail();
        return () => { cancelled = true; };
    }, [detailId]);

    const isOpen = !!detailId;

    return (
        <div
            className={[styles.detailRoot, isOpen ? styles.isOpen : ''].join(' ')}
            aria-hidden={!isOpen}
        >
            <div
                className={styles.detailScrim}
                onClick={() => openDetail(null)}
                aria-label="关闭详情"
            />
            {mergedDetailEvent && (
                <section
                    className={styles.detailPanel}
                    style={{
                        '--callout-accent': resolveEventColor(mergedDetailEvent.category, 'category'),
                    } as CSSProperties}
                    aria-labelledby={`event-detail-title-${mergedDetailEvent.id}`}
                    role="dialog"
                    aria-modal="true"
                >
                    <div className={styles.detailAccent} aria-hidden="true" />
                    <header className={styles.detailHead}>
                        <div className={styles.detailCode}>
                            <StatusDot status={mergedDetailEvent.status} />
                            <span>{EVENT_CATEGORY_LABEL[mergedDetailEvent.category]}</span>
                            <span className={styles.detailCodeSep}>·</span>
                            <span>{EVENT_STATUS_LABEL[mergedDetailEvent.status]}</span>
                            <span className={styles.detailCodeSep}>·</span>
                            <span>#{String(mergedDetailEvent.id).slice(0, 6).toUpperCase()}</span>
                            {detailLoading && (
                                <>
                                    <span className={styles.detailCodeSep}>·</span>
                                    <span style={{ color: 'var(--callout-accent)' }}>加载详情中…</span>
                                </>
                            )}
                        </div>
                        <button
                            type="button"
                            className={styles.detailClose}
                            onClick={() => openDetail(null)}
                            aria-label="关闭详情"
                        >
                            ×
                        </button>
                    </header>
                    <div className={styles.detailContent}>
                        <div className={styles.detailBody}>
                            <h2
                                id={`event-detail-title-${mergedDetailEvent.id}`}
                                className={styles.detailTitle}
                            >
                                {mergedDetailEvent.title}
                            </h2>
                            <dl className={styles.detailGrid}>
                                <dt>时间</dt>
                                <dd>
                                    {mergedDetailEvent.startTime
                                        ? dateFormat.format(new Date(mergedDetailEvent.startTime))
                                        : '待定'}
                                    {mergedDetailEvent.endTime
                                        ? `  —  ${dateFormat.format(new Date(mergedDetailEvent.endTime))}`
                                        : ''}
                                </dd>
                                {mergedDetailEvent.locationName && (
                                    <>
                                        <dt>地点</dt>
                                        <dd>{mergedDetailEvent.locationName}</dd>
                                    </>
                                )}
                                {mergedDetailEvent.geoText && (
                                    <>
                                        <dt>位置</dt>
                                        <dd>{mergedDetailEvent.geoText}</dd>
                                    </>
                                )}
                                {mergedDetailEvent.organizer && (
                                    <>
                                        <dt>主办</dt>
                                        <dd>{mergedDetailEvent.organizer}</dd>
                                    </>
                                )}
                                {mergedDetailEvent.participantCount != null && (
                                    <>
                                        <dt>参与</dt>
                                        <dd>{mergedDetailEvent.participantCount} 人</dd>
                                    </>
                                )}
                                <dt>等级</dt>
                                <dd>{EVENT_SEVERITY_LABEL[mergedDetailEvent.severity]}</dd>
                            </dl>
                            {mergedDetailEvent.description && (
                                <p className={styles.detailDesc}>{mergedDetailEvent.description}</p>
                            )}
                            {mergedDetailEvent.tags && mergedDetailEvent.tags.length > 0 && (
                                <div className={styles.detailTags}>
                                    {mergedDetailEvent.tags.map((tag, idx) => (
                                        <span key={idx} className={styles.miniTag}>
                                            {tag}
                                        </span>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* 底部状态条 + 操作按钮 */}
                        <footer className={styles.detailFooter}>
                            {detailError && (
                                <div className={styles.detailError}>
                                    ⚠ 详情接口请求失败，仅展示列表简要信息：
                                    <br />
                                    <span className={styles.detailErrorMsg}>{detailError}</span>
                                </div>
                            )}
                            {mergedDetailEvent.jumpUrl && (
                                <button
                                    type="button"
                                    className={styles.jumpBtn}
                                    onClick={() => {
                                        try {
                                            window.open(mergedDetailEvent.jumpUrl!, '_blank', 'noopener,noreferrer');
                                        } catch (e) {
                                            const msg = e instanceof Error ? e.message : String(e);
                                            alert(`跳转失败：${msg}`);
                                        }
                                    }}
                                >
                                    ↗  跳转到原页面
                                </button>
                            )}
                        </footer>
                    </div>
                </section>
            )}
        </div>
    );
}
