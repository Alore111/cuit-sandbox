/* ================================================================
   校园实况服务层（统一事件代理版）
   —— 数据来源：实时事件统一走 Node 服务端代理（/api/campus-live/events），
      Node 读 event-config → 带鉴权请求上游 → 归一化为 UnifiedCampusEvent。
      前端不再直连第三方，Token 只在后端。
      · 渲染主线：拉到统一事件 → deriveHeatFromEvents 派生热度 → 兼容层转换。
      配置缓存仍保留给编辑页 / 详情逻辑读取生效中的配置用。
   ================================================================ */

import type { Building, CampusLiveQuery, CampusLiveSnapshot, MapDataset } from '../contract';
import {
    deriveHeatFromEvents,
    unifiedToLegacyEvents,
    unifiedToLegacyActivities,
    EVENT_CATEGORY_DEFAULTS,
    EVENT_SEVERITY_DEFAULTS,
    ACTIVITY_MODULE_DEFAULTS,
    ACTIVITY_LEVEL_DEFAULTS,
    type UnifiedCampusEvent,
} from '../contract';
import {
    type EventApiConfig,
} from '../api/eventConfigApi';
import { campusLiveApi } from '../api/campusLiveApi';

/** 实况自动轮询周期（毫秒）。 */
export const CAMPUS_LIVE_REFRESH_MS = 60_000;

/** 快照版本前缀：沿用 unified-api，让 UI 判定「统一事件接口」数据源的逻辑继续成立 */
const CAMPUS_LIVE_PROXY_TAG = 'unified-api-proxy';

/* 配置缓存：事件渲染不再消费配置（由 Node 代理读取），这里仅保留编辑页保存后需要的
 * 清除入口，以及给详情/编辑入口读取生效配置的访问器。Node 代理读配置按 mtime 自动失效。 */
let _cachedConfig: EventApiConfig | null = null;

export function invalidateConfigCache(): void {
    _cachedConfig = null;
}

/** 从 MapDataset 构建 buildingsById Map，供热度派生使用 */
function buildBuildingIndex(dataset: MapDataset): Map<string, Building> {
    const m = new Map<string, Building>();
    for (const b of (dataset?.buildings ?? [])) {
        if (b.id) m.set(b.id, b);
    }
    return m;
}

/** 用第三方事件构造统一快照：热度派生 + 兼容层转换 */
function buildSnapshotFromUnified(
    events: UnifiedCampusEvent[],
    dataset: MapDataset,
    versionTag: string,
): CampusLiveSnapshot {
    const buildings = buildBuildingIndex(dataset);
    const { heatList, heatSummary } = deriveHeatFromEvents(events, buildings);
    const legEvents = unifiedToLegacyEvents(events);
    const legActs = unifiedToLegacyActivities(events);
    return {
        version: versionTag,
        snapshotAt: Date.now(),
        heatList,
        heatSummary,
        events: legEvents,
        activities: legActs,
        eventCategoryDict: EVENT_CATEGORY_DEFAULTS,
        eventSeverityDict: EVENT_SEVERITY_DEFAULTS,
        activityModuleDict: ACTIVITY_MODULE_DEFAULTS,
        activityLevelDict: ACTIVITY_LEVEL_DEFAULTS,
    };
}

/** 对外：获取快照（统一走 Node 服务端事件代理，不再浏览器直连第三方） */
export async function loadCampusLiveSnapshot(
    dataset: MapDataset,
    _query?: CampusLiveQuery
): Promise<CampusLiveSnapshot> {
    // 事件代理返回已归一化的 UnifiedCampusEvent；空数组 = 未配置事件源的空态
    const events = await campusLiveApi.fetchUnifiedEvents();
    const tag = `${CAMPUS_LIVE_PROXY_TAG}-${events.length}`;
    return buildSnapshotFromUnified(events, dataset, tag);
}

/** 对外：刷新单项热榜（留作后期扩展，目前走统一 fetchSnapshot） */
export const campusLiveService = {
    loadSnapshot: loadCampusLiveSnapshot,
    /** 统一代理模型下不存在独立演示数据；空态由面板用 snapshot.events 是否为空判定 */
    isMock: () => false,
    /** 获取当前生效配置（供编辑/详情入口；渲染主路径已改走 Node 代理，此值通常为 null） */
    getCurrentConfig: () => _cachedConfig,
    invalidateConfigCache,
};
