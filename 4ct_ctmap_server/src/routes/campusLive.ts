import { Router, type NextFunction, type Request, type Response } from 'express';
import { readDataJson } from '../loaders/jsonStore';
import { ok } from '../middleware/response';
import { gcj02ToWgs84 } from '../utils/coords';
import { loadPlaces, matchPlace, type PlaceRule } from '../utils/places';

/**
 * 校园实况统一事件代理（服务端转发）
 * —— 前端不再直接按 event-config 里的 url/headers 发请求（否则 Token 会暴露到浏览器），
 *    统一改为请求本接口；本服务端读 data/event-config.json → 带鉴权请求配置 URL →
 *    按 listDataPath / fieldMapping 归一化为 UnifiedCampusEvent 返回。
 *
 * 【数据源口径】只有一条链：前端地图 → 本服务端固定实时事件接口 → 配置的 URL。不做其它任意数据源，也不把原始响应原样透传给前端。
 *
 * 缓存：为了不给上游源造成高频压力，接口结果做进程内 TTL 缓存（与前端实时轮询节奏解耦）。
 */

/* ================================================================
 *  类型（与 4ct_ctmap 前端 `contract/campusLive.ts` 中对应片段逐字一致）
 * ================================================================ */

type LonLat = [number, number];
/** 位置坐标系：源站可能是高德(GCJ-02)或原始(WGS-84) */
type GeoCoordSystem = 'gcj02' | 'wgs84';
type EventSeverity = 'info' | 'warning' | 'urgent' | 'special';
type EventCategory =
    | 'lecture' | 'competition' | 'performance' | 'sports' | 'meeting'
    | 'emergency' | 'maintenance' | 'promotion' | 'festival' | 'other';
type EventStatus = 'upcoming' | 'ongoing' | 'ended' | 'cancelled';

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
    /** position 当前坐标系（Node 统一输出为 wgs84，前端无需再换算） */
    coordSystem?: GeoCoordSystem;
    /** 真实地理文字：源站给的地址区域串/详细地址，Node 用它匹配地点补 position */
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

interface EventApiConfig {
    version: number;
    name?: string;
    headers: EventApiHeader[];
    endpoints: EventApiEndpoint;
    fieldMapping: EventFieldMapping;
    savedAt?: number;
}

/* ================================================================
 *  工具
 * ================================================================ */

/** 把 headers[]（仅 enabled=true）拼成 fetch HeadersInit；重复 key 后者覆盖前者。 */
function buildHeaders(config: EventApiConfig): Record<string, string> {
    const out: Record<string, string> = {};
    for (const h of config.headers ?? []) {
        if (!h || !h.enabled) continue;
        const k = (h.key ?? '').trim();
        if (!k) continue;
        out[k] = h.value ?? '';
    }
    if (!('Accept' in out) && !('accept' in out)) {
        out['Accept'] = '*/*';
    }
    return out;
}

/** 在响应体中按 dotPath 取值；空路径返回整个对象；找不到返回 undefined。 */
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

const ALLOWED_CATS: EventCategory[] = ['lecture', 'competition', 'performance', 'sports', 'meeting',
    'emergency', 'maintenance', 'promotion', 'festival', 'other'];
const ALLOWED_SEV: EventSeverity[] = ['info', 'warning', 'urgent', 'special'];
const STATUSES: EventStatus[] = ['upcoming', 'ongoing', 'ended', 'cancelled'];

/** 把第三方返回的单条对象 → UnifiedCampusEvent（默认同名字段，fieldMapping 覆盖）。
 *  places：地点词典，用于无坐标事件按地理文字补齐 position（WGS-84）。 */
function mapSingle(
    raw: Record<string, unknown>,
    fieldMapping: EventFieldMapping,
    places: PlaceRule[]
): UnifiedCampusEvent {
    const pick = <K extends keyof UnifiedCampusEvent>(k: K): unknown => {
        const src = (fieldMapping as Record<string, string | undefined>)[k] ?? (k as string);
        if (!src) return undefined;
        return digPath(raw, src);
    };
    const toStr = (v: unknown, fallback = ''): string =>
        v == null ? fallback : typeof v === 'string' ? v : String(v);
    const toNum = (v: unknown): number | undefined => {
        if (v == null || v === '') return undefined;
        if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
    };
    const toUnix = (v: unknown): number => {
        if (v == null || v === '') return Date.now();
        if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
        if (typeof v === 'string' && /^\d{10,13}$/.test(v)) {
            const n = Number(v);
            return v.length === 10 ? n * 1000 : n;
        }
        return Date.now();
    };
    const toEnum = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => {
        if (v == null || v === '') return fallback;
        const s = toStr(v).trim().toLowerCase();
        const hit = allowed.find((k) => k.toLowerCase() === s);
        return hit ?? fallback;
    };
    const id = toStr(pick('id'));

    /*
     * position 解析（两通道）：
     *   1) 坐标通道：源站自带经纬度。按 coordSystem 决定转换 ——
     *      高德(GCJ-02)反算回 WGS-84；WGS-84 原样透传。最终统一为 wgs84。
     *   2) 地理文字通道：无坐标时，用 geoText（地址区域串/详细地址）在 places
     *      词典里匹配地点，命中即取其 WGS-84 坐标并补 location 信息。
     *      匹配不到 → position 空置（不兜底）。
     */
    const srcCsRaw = toStr(pick('coordSystem')).trim().toLowerCase();
    const srcCs: GeoCoordSystem = srcCsRaw === 'wgs84' ? 'wgs84' : 'gcj02'; // 缺省按高德
    const geoText = toStr(pick('geoText')) || undefined;

    let position: LonLat | undefined;
    let locationId = toStr(pick('locationId')) || undefined;
    let locationName = toStr(pick('locationName')) || undefined;

    const rawPos = pick('position');
    if (Array.isArray(rawPos) && rawPos.length === 2) {
        const a = Number(rawPos[0]);
        const b = Number(rawPos[1]);
        if (Number.isFinite(a) && Number.isFinite(b)) {
            position = srcCs === 'gcj02' ? gcj02ToWgs84(a, b) : ([a, b] as LonLat);
        }
    }

    if (!position && geoText) {
        const hit = matchPlace(geoText, places);
        if (hit && hit.place.position) {
            position = hit.place.position;
            // 命中地点时用场所标准名作为地点名；有关联建筑则用首个作为 locationId
            locationName = locationName || hit.place.name;
            locationId = locationId || hit.place.buildingIds?.[0] || hit.place.locationId || hit.place.name;
        }
    }

    return {
        id: id || `evt-${Math.random().toString(36).slice(2, 10)}`,
        title: toStr(pick('title'), '（未命名事件）'),
        description: toStr(pick('description')),
        category: toEnum<EventCategory>(pick('category'), ALLOWED_CATS, 'other'),
        severity: toEnum<EventSeverity>(pick('severity'), ALLOWED_SEV, 'info'),
        status: toEnum<EventStatus>(pick('status'), STATUSES, 'upcoming'),
        locationId,
        locationName,
        position,
        /* Node 端已把 position 统一转/对齐到前端基准，恒为 wgs84 */
        coordSystem: position ? 'wgs84' : undefined,
        geoText,
        startTime: (() => {
            const v = pick('startTime');
            if (v == null || v === '') return undefined;
            if (typeof v === 'string' && !/^\d+$/.test(v)) return v;
            return new Date(toUnix(v)).toISOString();
        })(),
        endTime: (() => {
            const v = pick('endTime');
            if (v == null || v === '') return undefined;
            if (typeof v === 'string' && !/^\d+$/.test(v)) return v;
            return new Date(toUnix(v)).toISOString();
        })(),
        organizer: toStr(pick('organizer')) || undefined,
        participantCount: toNum(pick('participantCount')),
        coverImageUrl: toStr(pick('coverImageUrl')) || undefined,
        tags: (() => {
            const v = pick('tags');
            if (Array.isArray(v)) return v.map((x) => toStr(x)).filter(Boolean);
            if (typeof v === 'string') return v.split(/[,，;；\s]+/).filter(Boolean);
            return [];
        })(),
        limitNumber: toNum(pick('limitNumber')),
        registeredCount: toNum(pick('registeredCount')),
        score: toStr(pick('score')) || undefined,
        activityLevelText: toStr(pick('activityLevelText')) || undefined,
        jumpUrl: toStr(pick('jumpUrl')) || undefined,
        createdAt: toUnix(pick('createdAt')),
        updatedAt: toUnix(pick('updatedAt')),
    };
}

/* ================================================================
 *  列表 / 详情代理
 * ================================================================ */

/** 真实请求配置 URL 并按映射归一化为统一事件列表。 */
async function fetchUnifiedList(
    config: EventApiConfig,
    places: PlaceRule[]
): Promise<UnifiedCampusEvent[]> {
    const ep = config.endpoints;
    const url = (ep?.url ?? '').trim();
    if (!url) {
        throw new Error('未配置事件接口 URL：请在编辑页面填入 endpoints.url');
    }
    const headers = buildHeaders(config);
    const method = (ep.method ?? 'GET').toUpperCase() as 'GET' | 'POST';
    const init: RequestInit = {
        method,
        headers,
        ...(method === 'POST' ? { body: JSON.stringify({}) } : {}),
    };

    const response = await fetch(url, init);
    if (!response.ok) {
        throw new Error(`事件接口返回 HTTP ${response.status}：${url}`);
    }
    let payload: unknown;
    try {
        const text = await response.text();
        payload = text.trim() ? JSON.parse(text) : null;
    } catch {
        throw new Error(`事件接口返回体不是合法 JSON：${url}`);
    }

    // 若对方遵守 ApiEnvelope 且 success=false → 报告其 message
    if (
        payload && typeof payload === 'object' && !Array.isArray(payload)
        && (payload as { success?: unknown }).success === false
    ) {
        throw new Error(`事件接口返回失败：${(payload as { message?: unknown }).message ?? '无错误信息'}`);
    }

    // 挖列表数组：listDataPath 空 → 优先 payload.data（ApiEnvelope），否则 payload 本身
    let listRaw: unknown;
    const path = (ep.listDataPath ?? '').trim();
    if (path) {
        listRaw = digPath(payload, path);
    } else {
        const asObj = payload as { data?: unknown };
        listRaw = (asObj && typeof asObj === 'object' && Array.isArray(asObj.data)) ? asObj.data : payload;
    }
    if (!Array.isArray(listRaw)) {
        throw new Error(
            `未挖到事件列表数组：当前路径=${path || '（默认 ApiEnvelope.data）'}，请在编辑页面配置 listDataPath`
        );
    }

    const events: UnifiedCampusEvent[] = [];
    for (const item of listRaw) {
        if (!item || typeof item !== 'object') continue;
        events.push(mapSingle(item as Record<string, unknown>, config.fieldMapping ?? {}, places));
    }
    return events;
}

/** 真实请求配置的详情 URL 模板（{id} 占位），返回单条统一事件。 */
async function fetchUnifiedDetail(
    config: EventApiConfig,
    eventId: string,
    places: PlaceRule[]
): Promise<UnifiedCampusEvent | null> {
    const ep = config.endpoints;
    if (!ep.enableDetailEndpoint) return null;
    const tpl = (ep.detailUrlTemplate ?? '').trim();
    if (!tpl) {
        throw new Error('已开启详情接口但未配置 detailUrlTemplate');
    }
    const url = tpl.replaceAll('{id}', encodeURIComponent(eventId));
    const response = await fetch(url, { method: 'GET', headers: buildHeaders(config) });
    if (!response.ok) {
        throw new Error(`事件详情接口返回 HTTP ${response.status}：${url}`);
    }
    let payload: unknown;
    try {
        const text = await response.text();
        payload = text.trim() ? JSON.parse(text) : null;
    } catch {
        throw new Error(`事件详情接口返回体不是合法 JSON：${url}`);
    }
    const path = (ep.detailDataPath ?? '').trim();
    const objRaw: unknown = path ? digPath(payload, path) : (payload as { data?: unknown })?.data ?? payload;
    if (!objRaw || typeof objRaw !== 'object') {
        throw new Error(`未挖到详情对象：detailDataPath=${path || '（默认 data）'}`);
    }
    return mapSingle(objRaw as Record<string, unknown>, config.fieldMapping ?? {}, places);
}

/* ================================================================
 *  进程内 TTL 缓存（列表；详情单行按需不缓存）
 * ================================================================ */

const CONFIG_FILE = 'event-config.json';
const CACHE_TTL_SECONDS = 30;
let _listCache: { at: number; events: UnifiedCampusEvent[] } | null = null;

export const campusLiveRouter = Router();

/** express 4 不自动捕获 async 抛错，统一转交错误中间件 */
function asyncHandler(
    handler: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => {
        handler(req, res).catch(next);
    };
}

/** GET /api/campus-live/events — 统一事件列表（服务端代理 + 缓存）
 *  未配置事件 URL → 返回空数组（前端视为空态引导去编辑页），
 *  已配置但源异常 → 抛错（前端展示错误，不兜底）。 */
campusLiveRouter.get(
    '/events',
    asyncHandler(async (_req, res) => {
        const nowTs = Date.now() / 1000;
        if (_listCache && nowTs - _listCache.at < CACHE_TTL_SECONDS) {
            ok(res, _listCache.events, 'success(cached)');
            return;
        }
        const config = await readDataJson<EventApiConfig>(CONFIG_FILE);
        const url = (config.endpoints?.url ?? '').trim();
        if (!url) {
            _listCache = { at: nowTs, events: [] };
            ok(res, [], '未配置事件接口 URL，返回空态');
            return;
        }
        const places = await loadPlaces();
        const events = await fetchUnifiedList(config, places);
        _listCache = { at: nowTs, events };
        ok(res, events);
    })
);

/** GET /api/campus-live/events/:id — 详情代理（若配置启用详情端点则转发，否则回退列表缓存项） */
campusLiveRouter.get(
    '/events/:id',
    asyncHandler(async (req, res) => {
        const id = (req.params.id ?? '').trim();
        if (!id) {
            res.status(400).json({ success: false, message: '缺少事件 id', data: {} });
            return;
        }
        const config = await readDataJson<EventApiConfig>(CONFIG_FILE);
        const places = await loadPlaces();
        const detail = await fetchUnifiedDetail(config, id, places);
        // 未启用详情端点 / 未配置模板 → 回退列表缓存里的同 id 项（保持"有就是有"）
        if (detail) {
            ok(res, detail);
            return;
        }
        const fallback = (_listCache?.events ?? []).find((e) => e.id === id) ?? null;
        if (fallback) {
            ok(res, fallback);
            return;
        }
        res.status(404).json({ success: false, message: `事件不存在：${id}`, data: {} });
    })
);