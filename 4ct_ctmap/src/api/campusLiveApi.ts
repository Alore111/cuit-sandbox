import type { CampusLiveQuery, CampusLiveSnapshot, UnifiedCampusEvent } from '../contract';
import { request } from './client';

/** 路由前缀：与 MAP_API_PREFIX 风格一致，后期对接 backend_core 时改这里即可 */
export const CAMPUS_LIVE_API_PREFIX = '/api/campus-live';

/**
 * 校园实况 API 层。
 * 【迁移策略】实时事件统一由 Node 服务端代理（读 event-config → 带鉴权请求上游 →
 * 字段映射），前端不再直连第三方接口，避免 Token 暴露到浏览器。此处只消费代理结果。
 */
export const campusLiveApi = {
    /**
     * 拉取统一事件列表（走 Node 服务端代理，Token 只存在于后端）。
     * 返回已按 fieldMapping 归一化的 UnifiedCampusEvent[]；空数组 = 未配置事件源的空态。
     */
    fetchUnifiedEvents: () =>
        request<UnifiedCampusEvent[]>(`${CAMPUS_LIVE_API_PREFIX}/events`),

    /**
     * 拉取单个事件详情（走 Node 服务端代理）。
     * 代理会按配置决定转发详情端点或回退列表项；404 / 上游失败会抛错。
     */
    fetchUnifiedEventDetail: (eventId: string) =>
        request<UnifiedCampusEvent>(`${CAMPUS_LIVE_API_PREFIX}/events/${encodeURIComponent(eventId)}`),

    /** 拉取完整快照（兼容保留；当前实际实时链路上层走 fetchUnifiedEvents） */
    fetchSnapshot: (query?: CampusLiveQuery) =>
        request<CampusLiveSnapshot>(`${CAMPUS_LIVE_API_PREFIX}/snapshot`, {
            method: query ? 'POST' : 'GET',
            ...(query ? { body: JSON.stringify(query) } : {}),
        }),

    /** 增量拉取（保留，未接） */
    fetchHeatList: () => request(`${CAMPUS_LIVE_API_PREFIX}/heat`),
    fetchEvents: (query?: CampusLiveQuery) =>
        request(`${CAMPUS_LIVE_API_PREFIX}/events`, {
            method: query ? 'POST' : 'GET',
            ...(query ? { body: JSON.stringify(query) } : {}),
        }),
    fetchActivities: (query?: CampusLiveQuery) =>
        request(`${CAMPUS_LIVE_API_PREFIX}/activities`, {
            method: query ? 'POST' : 'GET',
            ...(query ? { body: JSON.stringify(query) } : {}),
        }),
};
