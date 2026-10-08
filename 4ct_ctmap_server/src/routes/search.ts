/* ================================================================
 *  统一搜索路由
 *  —— GET /api/search?q=关键词
 *     返回地点（建筑/地皮/地点词典）+ 事件，地点优先，按匹配度排序。
 *
 *  地点匹配采用混合算法：
 *    1. 先直接匹配建筑名称和地皮名称（子串包含）
 *    2. 若无直接命中，回退到 places.json 地点词典匹配
 *
 *  事件搜索：
 *    - 若配置了 searchEndpoints（独立事件搜索端点），代理请求上游
 *    - 否则从事件列表缓存中按标题/地点/描述过滤
 *
 *  节流：前端应自行实现输入节流（建议 300ms），后端不做额外限流。
 * ================================================================ */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { readDataJson } from '../loaders/jsonStore';
import { ok } from '../middleware/response';
import { loadPlaces, normalizeText, tryCompileRegex, type PlaceRule } from '../utils/places';

/* ================================================================
 *  类型（与前端 contract/campusLive.ts 中对应片段保持同步）
 * ================================================================ */

type LonLat = [number, number];

/** 搜索结果条目 */
export interface SearchResultItem {
    /** 结果类型：place=地点, event=事件 */
    type: 'place' | 'event';
    /** 显示名称 */
    name: string;
    /** 经纬度坐标 [lat, lon]（如果有） */
    position?: LonLat;
    /** 匹配得分（越高越匹配） */
    score: number;
    /** 地点类型额外字段 */
    placeData?: {
        /** 子类型：building=建筑, parcel=地皮, place=地点词典条目 */
        subType: 'building' | 'parcel' | 'place';
        /** 建筑 ID 数组（如果有） */
        buildingIds?: string[];
        /** 地皮 ID 数组（如果有） */
        parcelIds?: string[];
        /** 建筑/地皮类型标签 */
        typeLabel?: string;
    };
    /** 事件类型额外字段 */
    eventData?: {
        id: string;
        title: string;
        category: string;
        status: string;
        startTime?: string;
        endTime?: string;
        locationName?: string;
        description?: string;
        organizer?: string;
        tags?: string[];
        jumpUrl?: string;
    };
}

/** 统一搜索响应 */
export interface SearchResult {
    items: SearchResultItem[];
    total: number;
    query: string;
}

/* ================================================================
 *  事件代理相关类型（与 campusLive.ts 保持一致）
 * ================================================================ */

type EventSeverity = 'info' | 'warning' | 'urgent' | 'special';
type EventCategory =
    | 'lecture' | 'competition' | 'performance' | 'sports' | 'meeting'
    | 'emergency' | 'maintenance' | 'promotion' | 'festival' | 'other';
type EventStatus = 'upcoming' | 'ongoing' | 'ended' | 'cancelled';
type GeoCoordSystem = 'gcj02' | 'wgs84';

interface UnifiedCampusEvent {
    id: string;
    title: string;
    description: string;
    category: EventCategory;
    severity: EventSeverity;
    status: EventStatus;
    locationId?: string;
    locationName?: string;
    position?: LonLat;
    coordSystem?: GeoCoordSystem;
    geoText?: string;
    startTime?: string;
    endTime?: string;
    organizer?: string;
    participantCount?: number;
    coverImageUrl?: string;
    tags?: string[];
    limitNumber?: number;
    registeredCount?: number;
    score?: string;
    activityLevelText?: string;
    jumpUrl?: string;
    createdAt: number;
    updatedAt: number;
}

interface EventApiHeader {
    key: string;
    value: string;
    enabled: boolean;
}

type EventFieldMapping = Partial<Record<keyof UnifiedCampusEvent, string>>;

interface EventApiEndpoint {
    url: string;
    method: 'GET' | 'POST';
    listDataPath?: string;
    detailDataPath?: string;
    enableDetailEndpoint: boolean;
    detailUrlTemplate?: string;
}

/** 事件搜索端点配置（与 EventApiEndpoint 同构，独立于列表端点） */
interface EventApiSearchEndpoint {
    url: string;
    method: 'GET' | 'POST';
    listDataPath?: string;
}

interface EventApiConfig {
    version: number;
    name?: string;
    headers: EventApiHeader[];
    endpoints: EventApiEndpoint;
    /** 独立事件搜索端点（可选）；未配置时从列表缓存中过滤 */
    searchEndpoints?: EventApiSearchEndpoint;
    fieldMapping: EventFieldMapping;
    savedAt?: number;
}

/* ================================================================
 *  数据加载辅助
 * ================================================================ */

interface BuildingItem {
    id: string;
    name: string;
    typeLabel: string;
    outline: LonLat[];
}

interface ParcelItem {
    id: string;
    name: string;
    outline: LonLat[];
}

/** 求多边形轮廓中心（与 places.ts 同一算法） */
function outlineCenter(outline: LonLat[] | undefined): LonLat | null {
    if (!outline || outline.length === 0) return null;
    const parts = outline.filter((p) => Array.isArray(p) && p.length === 2);
    if (parts.length === 0) return null;
    let la = 0, lo = 0;
    for (const [a, b] of parts) { la += a; lo += b; }
    return [+(la / parts.length).toFixed(6), +(lo / parts.length).toFixed(6)];
}

/* ================================================================
 *  地点搜索（混合算法）
 * ================================================================ */

/**
 * 搜索地点：混合算法
 *   1. 先直接找建筑名称和地皮名称（子串包含）
 *   2. 如果没有直接命中，再找 places.json 词典匹配
 */
function searchPlaces(
    query: string,
    buildings: BuildingItem[],
    parcels: ParcelItem[],
    places: PlaceRule[]
): SearchResultItem[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];

    const results: SearchResultItem[] = [];

    /* 第一轮：直接匹配建筑名称 */
    for (const b of buildings) {
        const name = (b.name ?? '').trim();
        if (!name) continue;
        const nameLower = name.toLowerCase();
        if (!nameLower.includes(q)) continue;

        // 匹配度评分：完全匹配 > 开头匹配 > 包含匹配
        let score = 50;
        if (nameLower === q) score = 100;
        else if (nameLower.startsWith(q)) score = 80;

        const center = outlineCenter(b.outline);
        results.push({
            type: 'place',
            name,
            position: center ?? undefined,
            score,
            placeData: {
                subType: 'building',
                buildingIds: [String(b.id)],
                typeLabel: b.typeLabel || undefined,
            },
        });
    }

    /* 第一轮：直接匹配地皮名称 */
    for (const p of parcels) {
        const name = (p.name ?? '').trim();
        if (!name) continue;
        const nameLower = name.toLowerCase();
        if (!nameLower.includes(q)) continue;

        let score = 45;
        if (nameLower === q) score = 95;
        else if (nameLower.startsWith(q)) score = 75;

        const center = outlineCenter(p.outline);
        results.push({
            type: 'place',
            name,
            position: center ?? undefined,
            score,
            placeData: {
                subType: 'parcel',
                parcelIds: [String(p.id)],
            },
        });
    }

    /* 第二轮：如果有直接命中，词典就不重复搜索了（避免同名异位结果冗余） */
    if (results.length > 0) {
        return results.sort((a, b) => b.score - a.score).slice(0, 30);
    }

    /* 第三轮：无直接命中 → 回退到 places.json 词典匹配 */
    for (const place of places) {
        const nameLower = (place.name ?? '').toLowerCase();
        const includeTerms = (place.mustInclude ?? []).filter((t) => t.trim());

        // 检查地点名称或必现词是否匹配查询
        const nameMatch = nameLower.includes(q);
        const includeMatch = includeTerms.some((term) => {
            // 词典规则支持两种写法：普通词（子串包含）或 /.../ 正则项（re.test）。
            // 先归一化（转小写）再编译正则，与 places.ts 的 matchPlace 口径一致，
            // 避免 "/H1[0-9]{3}/" 这类大写规则匹配不到用户小写输入 h1243。
            const normalized = normalizeText(term);
            const re = tryCompileRegex(normalized);
            if (re) return re.test(q);
            return normalized.includes(q) || q.includes(normalized);
        });

        if (!nameMatch && !includeMatch) continue;

        // 命中正则/必现词但名称不匹配：得分按规则命中计（低于名称匹配）
        let score = 60;
        if (nameMatch && nameLower === q) score = 90;
        else if (nameMatch) score = 70;
        else if (includeMatch) score = 65;

        results.push({
            type: 'place',
            name: place.name,
            position: place.position ?? undefined,
            score,
            placeData: {
                subType: 'place',
                buildingIds: place.buildingIds,
                parcelIds: place.parcelIds,
            },
        });
    }

    return results.sort((a, b) => b.score - a.score).slice(0, 30);
}

/* ================================================================
 *  事件搜索
 * ================================================================ */

/** 把请求头配置转为 fetch HeadersInit */
function buildHeaders(config: EventApiConfig): Record<string, string> {
    const out: Record<string, string> = {};
    for (const h of config.headers ?? []) {
        if (!h || !h.enabled) continue;
        const k = (h.key ?? '').trim();
        if (!k) continue;
        out[k] = h.value ?? '';
    }
    if (!('Accept' in out) && !('accept' in out)) out['Accept'] = '*/*';
    return out;
}

/** 在响应体中按 dotPath 取值 */
function digPath(obj: unknown, dotPath?: string): unknown {
    if (obj == null) return undefined;
    const p = (dotPath ?? '').trim();
    if (!p) return obj;
    const parts = p.split('.').filter((s) => s.length > 0);
    let cur: unknown = obj;
    for (const part of parts) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
}

/** 从列表缓存中过滤事件（无独立搜索端点时的兜底方案） */
function filterEventsFromCache(
    events: UnifiedCampusEvent[],
    query: string
): SearchResultItem[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];

    const results: SearchResultItem[] = [];
    for (const e of events) {
        const titleMatch = (e.title ?? '').toLowerCase().includes(q);
        const locMatch = (e.locationName ?? '').toLowerCase().includes(q);
        const descMatch = (e.description ?? '').toLowerCase().includes(q);
        if (!titleMatch && !locMatch && !descMatch) continue;

        // 标题匹配得分最高
        let score = 50;
        if (e.title.toLowerCase() === q) score = 95;
        else if (e.title.toLowerCase().startsWith(q)) score = 85;
        else if (titleMatch) score = 70;
        else if (locMatch) score = 55;

        results.push({
            type: 'event',
            name: e.title,
            position: e.position,
            score,
            eventData: {
                id: e.id,
                title: e.title,
                category: e.category,
                status: e.status,
                startTime: e.startTime,
                endTime: e.endTime,
                locationName: e.locationName,
                description: e.description,
                organizer: e.organizer,
                tags: e.tags,
                jumpUrl: e.jumpUrl,
            },
        });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, 20);
}

/** 代理请求独立事件搜索端点 */
async function searchEventsFromEndpoint(
    config: EventApiConfig,
    query: string
): Promise<SearchResultItem[]> {
    const sep = config.searchEndpoints;
    if (!sep?.url) return [];

    const headers = buildHeaders(config);
    const method = (sep.method ?? 'GET').toUpperCase() as 'GET' | 'POST';

    let url = sep.url;
    let init: RequestInit = { method, headers };

    if (method === 'GET') {
        const sepUrl = new URL(url);
        sepUrl.searchParams.set('q', query);
        url = sepUrl.toString();
    } else {
        init.body = JSON.stringify({ q: query, query });
        init.headers = { ...headers, 'Content-Type': 'application/json' };
    }

    const response = await fetch(url, init);
    if (!response.ok) return [];

    let payload: unknown;
    try {
        const text = await response.text();
        payload = text.trim() ? JSON.parse(text) : null;
    } catch {
        return [];
    }

    // 挖列表数组
    let listRaw: unknown;
    const path = (sep.listDataPath ?? '').trim();
    if (path) {
        listRaw = digPath(payload, path);
    } else {
        const asObj = payload as { data?: unknown };
        listRaw = (asObj && typeof asObj === 'object' && Array.isArray(asObj.data)) ? asObj.data : payload;
    }
    if (!Array.isArray(listRaw)) return [];

    // 把每条映射为搜索结果（字段名与 UnifiedCampusEvent 对齐）
    const results: SearchResultItem[] = [];
    for (const item of listRaw) {
        if (!item || typeof item !== 'object') continue;
        const raw = item as Record<string, unknown>;
        const toStr = (k: string): string => {
            const v = raw[k];
            return v == null ? '' : typeof v === 'string' ? v : String(v);
        };
        const title = toStr('title') || toStr('name');
        if (!title) continue;

        const q = query.trim().toLowerCase();
        let score = 50;
        if (title.toLowerCase() === q) score = 95;
        else if (title.toLowerCase().startsWith(q)) score = 85;

        // 解析坐标
        let position: LonLat | undefined;
        const rawPos = raw.position;
        if (Array.isArray(rawPos) && rawPos.length === 2) {
            const a = Number(rawPos[0]);
            const b = Number(rawPos[1]);
            if (Number.isFinite(a) && Number.isFinite(b)) position = [a, b];
        }

        results.push({
            type: 'event',
            name: title,
            position,
            score,
            eventData: {
                id: toStr('id'),
                title,
                category: toStr('category') || 'other',
                status: toStr('status') || 'upcoming',
                startTime: toStr('startTime') || undefined,
                endTime: toStr('endTime') || undefined,
                locationName: toStr('locationName') || undefined,
                description: toStr('description') || undefined,
                organizer: toStr('organizer') || undefined,
                tags: Array.isArray(raw.tags) ? raw.tags.map(String) : undefined,
                jumpUrl: toStr('jumpUrl') || undefined,
            },
        });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, 20);
}

/* ================================================================
 *  事件列表缓存（与 campusLive.ts 共享 TTL 策略，独立实例）
 * ================================================================ */

const CONFIG_FILE = 'event-config.json';
const CACHE_TTL_SECONDS = 30;
let _listCache: { at: number; events: UnifiedCampusEvent[] } | null = null;

async function getCachedEvents(config: EventApiConfig): Promise<UnifiedCampusEvent[]> {
    const nowTs = Date.now() / 1000;
    if (_listCache && nowTs - _listCache.at < CACHE_TTL_SECONDS) {
        return _listCache.events;
    }
    // 缓存失效或不存在 → 从列表端点拉取（复用 campusLive 的缓存更好，
    // 但为避免跨路由耦合，这里独立维护一份短 TTL 缓存）
    const url = (config.endpoints?.url ?? '').trim();
    if (!url) return [];
    try {
        const headers = buildHeaders(config);
        const method = (config.endpoints.method ?? 'GET').toUpperCase();
        const init: RequestInit = {
            method,
            headers,
            ...(method === 'POST' ? { body: JSON.stringify({}) } : {}),
        };
        const response = await fetch(url, init);
        if (!response.ok) return [];
        const text = await response.text();
        const payload = text.trim() ? JSON.parse(text) : null;
        let listRaw: unknown;
        const path = (config.endpoints.listDataPath ?? '').trim();
        if (path) {
            listRaw = digPath(payload, path);
        } else {
            const asObj = payload as { data?: unknown };
            listRaw = (asObj && typeof asObj === 'object' && Array.isArray(asObj.data)) ? asObj.data : payload;
        }
        if (!Array.isArray(listRaw)) return [];
        // 简化映射：只取搜索需要的字段
        const events: UnifiedCampusEvent[] = [];
        for (const item of listRaw) {
            if (!item || typeof item !== 'object') continue;
            const raw = item as Record<string, unknown>;
            const toStr = (k: string): string => {
                const v = raw[k]; return v == null ? '' : typeof v === 'string' ? v : String(v);
            };
            events.push({
                id: toStr('id'),
                title: toStr('title') || '（未命名事件）',
                description: toStr('description'),
                category: (toStr('category') || 'other') as EventCategory,
                severity: (toStr('severity') || 'info') as EventSeverity,
                status: (toStr('status') || 'upcoming') as EventStatus,
                locationName: toStr('locationName') || undefined,
                position: undefined,
                startTime: toStr('startTime') || undefined,
                endTime: toStr('endTime') || undefined,
                organizer: toStr('organizer') || undefined,
                tags: Array.isArray(raw.tags) ? raw.tags.map(String) : undefined,
                jumpUrl: toStr('jumpUrl') || undefined,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            });
        }
        _listCache = { at: nowTs, events };
        return events;
    } catch {
        return [];
    }
}

/* ================================================================
 *  路由
 * ================================================================ */

export const searchRouter = Router();

/** express 4 不自动捕获 async 抛错，统一转交错误中间件 */
function asyncHandler(
    handler: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => {
        handler(req, res).catch(next);
    };
}

/**
 * GET /api/search?q=关键词
 *
 * 响应格式：
 * {
 *   success: true,
 *   message: "success",
 *   data: {
 *     items: SearchResultItem[],  // 地点在前、事件在后，各自按匹配度降序
 *     total: number,
 *     query: string
 *   }
 * }
 */
searchRouter.get(
    '/',
    asyncHandler(async (req, res) => {
        const query = ((req.query.q as string) ?? '').trim();
        if (!query) {
            ok(res, { items: [], total: 0, query: '' } satisfies SearchResult);
            return;
        }

        // 并行加载所有数据源
        const [buildingsRaw, parcelsRaw, places, config] = await Promise.all([
            readDataJson<{ items: BuildingItem[] }>('buildings.json'),
            readDataJson<{ items: ParcelItem[] }>('parcels.json'),
            loadPlaces(),
            readDataJson<EventApiConfig>(CONFIG_FILE),
        ]);

        // 1) 搜索地点（混合算法）
        const placeResults = searchPlaces(
            query,
            buildingsRaw.items ?? [],
            parcelsRaw.items ?? [],
            places
        );

        // 2) 搜索事件
        let eventResults: SearchResultItem[];
        const hasSearchEndpoint = !!config.searchEndpoints?.url?.trim();
        if (hasSearchEndpoint) {
            try {
                eventResults = await searchEventsFromEndpoint(config, query);
            } catch {
                // 独立搜索端点失败 → 回退缓存过滤
                const events = await getCachedEvents(config);
                eventResults = filterEventsFromCache(events, query);
            }
        } else {
            const events = await getCachedEvents(config);
            eventResults = filterEventsFromCache(events, query);
        }

        // 3) 合并：地点优先，各自按匹配度降序
        const items: SearchResultItem[] = [...placeResults, ...eventResults];

        ok(res, {
            items,
            total: items.length,
            query,
        } satisfies SearchResult);
    })
);
