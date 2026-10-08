/* ================================================================
   校园实况 Store（zustand）
   —— 管理 CampusLiveSnapshot 的加载、缓存、轮询。
      其他模块（UI/渲染层）只订阅这份状态。
================================================================ */

import { create } from 'zustand';
import type { CampusLiveSnapshot, MapDataset } from '../contract';
import { campusLiveService, CAMPUS_LIVE_REFRESH_MS } from '../services/campusLiveService';
import { useUiStore } from './uiStore';

export type LiveLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

interface CampusLiveState {
    snapshot: CampusLiveSnapshot | null;
    status: LiveLoadStatus;
    error: string | null;
    /** 自动轮询定时器 */
    _timer: ReturnType<typeof setInterval> | null;
    /** 最近一次 init/refresh 传的 dataset，刷新按钮不需要再从外部取 dataset */
    _dataset: MapDataset | null;
    /** 是否启用热力光柱显示 */
    showHeat: boolean;
    /** 是否显示事件标记（注意：铭牌/详情都用它） */
    showEvents: boolean;
    /** 仅看某等级以上的热度（low=全显示，medium=中+高+危急，…） */
    heatFilterLevel: 'low' | 'medium' | 'high' | 'critical';
    /** 当前筛选的事件分类（空数组=全选） */
    eventCategoryFilter: string[];
    hoveredEventId: string | null;
    selectedEventId: string | null;
    /** 详情抽屉打开的事件 id；null 表示关闭抽屉 */
    detailEventId: string | null;
    setHoveredEvent: (id: string | null) => void;
    selectEvent: (id: string | null) => void;
    /** 打开/关闭事件详情抽屉；传 null 关闭；会顺带同步 selectedEventId 以便高亮联动 */
    openDetail: (id: string | null) => void;
    _fetchInternal: (dataset: MapDataset) => Promise<void>;

    /* ---- actions ---- */
    /** 首次加载 + 启动轮询（传入 dataset 用于 Mock 生成位置锚点） */
    init: (dataset: MapDataset) => Promise<void>;
    /** 手动刷新一次（如果有缓存 dataset） */
    refresh: (dataset?: MapDataset) => Promise<void>;
    /** 开启/关闭自动轮询 */
    setAutoRefresh: (enabled: boolean, dataset?: MapDataset) => void;
    /** 切换热力光柱 */
    setShowHeat: (show: boolean) => void;
    /** 切换事件标记 */
    setShowEvents: (show: boolean) => void;
    /** 设置热度筛选等级 */
    setHeatFilterLevel: (lvl: CampusLiveState['heatFilterLevel']) => void;
    /** 切换事件分类（存在则移除，不存在则加入） */
    toggleEventCategory: (category: string) => void;
    /** 销毁（停止轮询等） */
    destroy: () => void;
}

export const useCampusLiveStore = create<CampusLiveState>((set, get) => ({
    snapshot: null,
    status: 'idle',
    error: null,
    _timer: null,
    _dataset: null,
    showHeat: true,
    showEvents: true,
    heatFilterLevel: 'low',
    eventCategoryFilter: [],
    hoveredEventId: null,
    selectedEventId: null,
    detailEventId: null,
    setHoveredEvent: (id) => set({ hoveredEventId: id }),
    selectEvent: (id) => set({ selectedEventId: id }),
    openDetail: (id) => {
        // 打开详情时同步高亮；关闭详情保留选中高亮（除非后续明确清空）
        if (id) {
            set({ detailEventId: id, selectedEventId: id });
            // 打开事件详情时，通知 3D 层把镜头推到事件锚点（铭牌/列表/详情内跳转共用同一入口）
            useUiStore.getState().requestEventFocus(id);
        } else {
            set({ detailEventId: null });
        }
    },

    async _fetchInternal(dataset) {
        set({ _dataset: dataset, status: 'loading', error: null });
        try {
            const snapshot = await campusLiveService.loadSnapshot(dataset);
            // #region debug-point store-fetch-ok
            console.error('[DBG][campus-live-ui-glitch] STORE_FETCH_OK', {
                version: snapshot.version,
                heats: snapshot.heatList.length,
                events: snapshot.events.length,
                activities: snapshot.activities.length,
                summary: snapshot.heatSummary,
            });
            // #endregion
            set((state) => {
                const selectedStillExists = snapshot.events.some((event) => event.id === state.selectedEventId);
                const detailStillExists = snapshot.events.some((event) => event.id === state.detailEventId);
                return {
                    snapshot,
                    status: 'ready',
                    selectedEventId: selectedStillExists ? state.selectedEventId : null,
                    detailEventId: detailStillExists ? state.detailEventId : null,
                };
            });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // #region debug-point store-fetch-err
            console.error('[DBG][campus-live-ui-glitch] STORE_FETCH_ERROR', msg, e);
            // #endregion
            set({
                snapshot: null,
                status: 'error',
                error: msg,
                detailEventId: null,
            });
        }
    },

    async init(dataset) {
        const state = get();
        // 防重复 init
        if (state._timer || state.status === 'loading') return;
        set({ _dataset: dataset });
        await state._fetchInternal(dataset);
        // 启动轮询（闭包 dataset，保持与旧行为一致）
        const timer = setInterval(() => {
            const s = get();
            if (s.status !== 'loading') {
                s._fetchInternal(dataset);
            }
        }, CAMPUS_LIVE_REFRESH_MS);
        set({ _timer: timer });
    },

    async refresh(dataset) {
        const d = dataset ?? get()._dataset;
        if (!d) {
            console.warn('[campusLiveStore] refresh 调用时既无传参也无缓存 _dataset，已跳过');
            return;
        }
        await get()._fetchInternal(d);
    },

    setAutoRefresh(enabled, dataset) {
        const { _timer } = get();
        if (enabled) {
            if (!_timer) {
                const d = dataset ?? get()._dataset;
                if (d) {
                    const timer = setInterval(() => {
                        const s = get();
                        if (s.status !== 'loading') {
                            s._fetchInternal(d);
                        }
                    }, CAMPUS_LIVE_REFRESH_MS);
                    set({ _timer: timer });
                }
            }
        } else {
            if (_timer) {
                clearInterval(_timer);
                set({ _timer: null });
            }
        }
    },

    setShowHeat: (show) => set({ showHeat: show }),
    setShowEvents: (show) => set({ showEvents: show, hoveredEventId: null, selectedEventId: null, detailEventId: null }),
    setHeatFilterLevel: (lvl) => set({ heatFilterLevel: lvl }),

    toggleEventCategory: (c) =>
        set((s) => ({
            hoveredEventId: null,
            selectedEventId: null,
            detailEventId: null,
            eventCategoryFilter: s.eventCategoryFilter.includes(c)
                ? s.eventCategoryFilter.filter((x) => x !== c)
                : [...s.eventCategoryFilter, c],
        })),

    destroy() {
        const t = get()._timer;
        if (t) clearInterval(t);
        set({
            _timer: null,
            _dataset: null,
            snapshot: null,
            status: 'idle',
            hoveredEventId: null,
            selectedEventId: null,
            detailEventId: null,
        });
    },
}));
