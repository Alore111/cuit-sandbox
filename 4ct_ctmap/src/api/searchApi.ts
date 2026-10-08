import type { SearchResult } from '../contract';
import { request } from './client';

/** 搜索 API 路由前缀 */
export const SEARCH_API_PREFIX = '/api/search';

/**
 * 统一搜索 API
 * —— GET /api/search?q=关键词
 *    返回地点（建筑/地皮/地点词典）+ 事件，地点优先，按匹配度排序。
 */
export const searchApi = {
    /**
     * 执行搜索
     * @param query 搜索关键词
     * @returns 搜索结果（地点 + 事件）
     */
    search: (query: string) =>
        request<SearchResult>(
            `${SEARCH_API_PREFIX}?q=${encodeURIComponent(query)}`
        ),
};
