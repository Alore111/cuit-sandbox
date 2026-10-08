/* ================================================================
   第三方统一事件接口调用服务（UnifiedEventService）
   —— 按 EventApiConfig 发 HTTP 请求，执行字段映射：
      · 组装 headers（只发 enabled=true）
      · 按 listDataPath / detailDataPath 从响应体挖数据（默认 ApiEnvelope.data）
      · 按 fieldMapping 把源字段 → UnifiedCampusEvent 字段
      · 缺省 / 异常字段用兜底，不吞异常（HTTP 失败直接抛给上层）
   ================================================================ */

import type {
    EventApiConfig,
    EventApiHeader,
    EventFieldMapping,
    EventCategory,
    EventSeverity,
    EventStatus,
    UnifiedCampusEvent,
    LonLat,
} from '../contract';
import { EVENT_FIELD_DEFAULTS, EVENT_CATEGORY_DEFAULTS, EVENT_SEVERITY_DEFAULTS } from '../contract';

/** ================================================================
 *  一、基础工具
 *  ================================================================ */

/** 把 headers[]（带 enabled）拼成 fetch HeadersInit；
 *  【口径】重复 key 后面的值覆盖前面，不做去重合并。 */
function buildHeaders(config: EventApiConfig): Record<string, string> {
    const out: Record<string, string> = {};
    const acceptJson = false; // 不强制 Accept: application/json，第三方可能返回 text/plain
    for (const h of (config.headers ?? []) as EventApiHeader[]) {
        if (!h || !h.enabled) continue;
        const k = (h.key ?? '').trim();
        if (!k) continue;
        out[k] = h.value ?? '';
    }
    // 第三方接口不一定遵守我们的 ApiEnvelope，Accept 不强加；仅当 headers 未设置时补一个
    if (!('Accept' in out) && !('accept' in out)) {
        out['Accept'] = acceptJson ? 'application/json' : '*/*';
    }
    return out;
}

/** 在响应体中按 dotPath 取值；path 为空串或 undefined 时返回整个 obj。
 *  只支持对象属性，不支持数组下标。找不到返回 undefined，caller 判断兜底。 */
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

/** 把第三方返回的单个对象 → 按映射填到 UnifiedCampusEvent 模板上。
 *  【口径】字段值类型不匹配时，尽量转（转数字失败则留 undefined），不把整个事件丢掉。*/
function mapSingle(
    raw: Record<string, unknown>,
    fieldMapping: EventFieldMapping,
    problems: Array<{ field: string; reason: string }>
): UnifiedCampusEvent {
    const pick = <K extends keyof UnifiedCampusEvent>(k: K): unknown => {
        const src = (fieldMapping as Record<string, string | undefined>)[k] ?? EVENT_FIELD_DEFAULTS[k];
        if (!src) return undefined;
        // src 支持 dot 路径：第三方返回嵌套对象时也能挖
        return digPath(raw, src);
    };

    const toStr = (v: unknown, fallback = ''): string => {
        if (v == null) return fallback;
        if (typeof v === 'string') return v;
        try {
            return String(v);
        } catch {
            return fallback;
        }
    };

    const toNum = (v: unknown): number | undefined => {
        if (v == null || v === '') return undefined;
        if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
    };

    const toUnix = (v: unknown): number => {
        if (v == null || v === '') return Date.now();
        // 已经是数字秒/毫秒
        if (typeof v === 'number') {
            return v > 1e12 ? v : v * 1000; // 秒 → 毫秒
        }
        if (typeof v === 'string') {
            // 纯数字字符串
            if (/^\d{10,13}$/.test(v)) {
                const n = Number(v);
                return v.length === 10 ? n * 1000 : n;
            }
            const d = new Date(v);
            const t = d.getTime();
            if (Number.isFinite(t)) return t;
        }
        return Date.now();
    };

    const toPosition = (v: unknown): LonLat | undefined => {
        if (Array.isArray(v) && v.length >= 2) {
            const a = Number(v[0]), b = Number(v[1]);
            if (Number.isFinite(a) && Number.isFinite(b)) {
                return [a, b];
            }
        }
        // 兼容 { lat, lng } / { latitude, longitude }
        if (v && typeof v === 'object') {
            const o = v as Record<string, unknown>;
            const lat = Number(o.lat ?? o.latitude);
            const lon = Number(o.lng ?? o.lon ?? o.longitude);
            if (Number.isFinite(lat) && Number.isFinite(lon)) return [lat, lon];
        }
        return undefined;
    };

    const toTags = (v: unknown): string[] => {
        if (Array.isArray(v)) return v.map((x) => toStr(x)).filter(Boolean);
        if (typeof v === 'string') return v.split(/[,，;；\s]+/).filter(Boolean);
        return [];
    };

    const toEnum = <T extends string>(
        v: unknown,
        allowed: readonly string[],
        fallback: T,
        _fieldName: string
    ): T => {
        if (v == null || v === '') return fallback;
        const s = toStr(v).trim().toLowerCase();
        const hit = allowed.find((k) => k.toLowerCase() === s);
        if (hit) return hit as T;
        // 兼容中文文本（比如"讲座报告" → lecture）
        return fallback;
    };

    const ALLOWED_CATS = EVENT_CATEGORY_DEFAULTS.map((d) => d.key);
    const ALLOWED_SEV = EVENT_SEVERITY_DEFAULTS.map((d) => d.key);
    const STATUSES: EventStatus[] = ['upcoming', 'ongoing', 'ended', 'cancelled'];

    const id = toStr(pick('id'));
    if (!id) problems.push({ field: 'id', reason: '源数据缺少 id，事件将使用 fallbackId' });
    const title = toStr(pick('title'));
    const description = toStr(pick('description'));
    if (!title) problems.push({ field: 'title', reason: '源数据缺少 title' });

    return {
        id: id || `evt-${Math.random().toString(36).slice(2, 10)}`,
        title: title || '（未命名事件）',
        description,
        category: toEnum<EventCategory>(pick('category'), ALLOWED_CATS, 'other', 'category'),
        severity: toEnum<EventSeverity>(pick('severity'), ALLOWED_SEV, 'info', 'severity'),
        status: toEnum<EventStatus>(pick('status'), STATUSES, 'upcoming', 'status'),
        locationId: toStr(pick('locationId')) || undefined,
        locationName: toStr(pick('locationName')) || undefined,
        position: toPosition(pick('position')),
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
        tags: toTags(pick('tags')),
        limitNumber: toNum(pick('limitNumber')),
        registeredCount: toNum(pick('registeredCount')),
        score: toStr(pick('score')) || undefined,
        activityLevelText: toStr(pick('activityLevelText')) || undefined,
        jumpUrl: toStr(pick('jumpUrl')) || undefined,
        createdAt: toUnix(pick('createdAt')),
        updatedAt: toUnix(pick('updatedAt')),
        __raw: raw,
    };
}

/** ================================================================
 *  二、测试请求结果：编辑页面用它展示"映射前后对比"和"问题清单"
 *  ================================================================ */

export interface TestRequestResult {
    /** HTTP 状态码；网络失败时 0 */
    httpStatus: number;
    /** 请求耗时（毫秒） */
    durationMs: number;
    /** 原始响应体（解析成 JS 对象，失败则是错误消息字符串） */
    rawResponse: unknown;
    /** 按 listDataPath 挖出的列表源数组 */
    rawList: unknown[];
    /** 映射后的事件 */
    events: UnifiedCampusEvent[];
    /** 映射中发现的问题（每个事件 0~N 条） */
    mappingProblems: Array<{ eventIndex: number; field: string; reason: string }>;
    /** 成功？HTTP 成功 + 挖到数组 = true */
    ok: boolean;
    /** 错误摘要（ok=false 时给人类可读） */
    message?: string;
}

/** ================================================================
 *  三、核心：按 config 发列表请求 + 做映射
 *      生产环境直接用；测试/编辑页面也复用它（wrapper 加了耗时统计）。
 *  ================================================================ */

/**
 * 按配置发第三方列表请求 + 字段映射。
 * 【HTTP 失败口径】fetch 抛异常或 HTTP 非 2xx 会原样抛出，上层决定给 UI 展示还是轮询静默。
 *  【字段映射失败口径】单个事件缺字段时记录 problems 到返回对象，事件本身用兜底值保留，
 *    不让"一条数据烂了"把整批都搞挂。
 */
export async function fetchUnifiedEventsList(config: EventApiConfig): Promise<{
    events: UnifiedCampusEvent[];
    rawResponse: unknown;
    rawList: unknown[];
    mappingProblems: TestRequestResult['mappingProblems'];
}> {
    const ep = config.endpoints;
    const url = ep?.url;
    if (!url) {
        throw new Error('未配置列表接口 URL：请在事件编辑页面填入 endpoints.url');
    }

    const headers = buildHeaders(config);
    const method = (ep.method ?? 'GET').toUpperCase() as 'GET' | 'POST';
    const init: RequestInit = {
        method,
        headers: {
            ...headers,
            ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        // 【用户口径】第三方跨域请求默认不带上 cookie；若后续有需要，可在编辑页面加个 withCredentials 开关再改这里
        credentials: 'omit',
    };

    let response: Response;
    try {
        response = await fetch(url, init);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`请求失败：${url}（${msg}）`);
    }

    if (!response.ok) {
        let body = '';
        try { body = await response.text(); } catch { /* 忽略读取失败 */ }
        throw new Error(`接口返回 HTTP ${response.status}：${url}（${body.slice(0, 200)}）`);
    }

    // 解析 JSON（第三方有可能返回纯文本，这里失败直接抛，不做 HTML 兜底）
    let payload: unknown;
    try {
        const text = await response.text();
        payload = text.trim() ? JSON.parse(text) : null;
    } catch (e) {
        throw new Error(`返回体不是合法 JSON：${url}（${e instanceof Error ? e.message : String(e)}）`);
    }

    // 默认 ApiEnvelope 格式：若 payload.success === false → 抛它的 message
    if (
        payload && typeof payload === 'object' && !Array.isArray(payload) &&
        'success' in payload && (payload as { success?: unknown }).success === false
    ) {
        const msg = (payload as { message?: unknown }).message;
        throw new Error(`第三方接口返回失败：${typeof msg === 'string' && msg ? msg : 'success=false，无错误信息'}`);
    }

    // 挖列表数组：listDataPath 空串 → 先看 payload.data 是不是数组（ApiEnvelope 默认），否则回退 payload 本身
    let listRaw: unknown;
    const path = (ep.listDataPath ?? '').trim();
    if (path) {
        listRaw = digPath(payload, path);
    } else {
        const asObj = payload as { data?: unknown };
        listRaw = (asObj && typeof asObj === 'object' && Array.isArray(asObj.data))
            ? asObj.data
            : payload;
    }
    if (!Array.isArray(listRaw)) {
        throw new Error(
            `未挖到事件列表数组：当前路径=${path || '（默认 ApiEnvelope.data）'}。` +
            `若第三方响应格式不是 { data: [...] }，请在编辑页面填写 listDataPath。`
        );
    }

    const mappingProblems: TestRequestResult['mappingProblems'] = [];
    const events: UnifiedCampusEvent[] = [];
    for (let i = 0; i < listRaw.length; i++) {
        const item = listRaw[i];
        if (!item || typeof item !== 'object') {
            mappingProblems.push({ eventIndex: i, field: '(整条)', reason: '列表项不是对象，已跳过' });
            continue;
        }
        const evProblems: Array<{ field: string; reason: string }> = [];
        const ev = mapSingle(item as Record<string, unknown>, config.fieldMapping ?? {}, evProblems);
        for (const p of evProblems) mappingProblems.push({ eventIndex: i, ...p });
        events.push(ev);
    }

    return { events, rawResponse: payload, rawList: listRaw, mappingProblems };
}

/** ================================================================
 *  四、详情接口（仅当 enableDetailEndpoint=true 时调用）
 *      —— 打开详情抽屉时按需请求；返回值同样走字段映射。
 *  ================================================================ */
export async function fetchUnifiedEventDetail(
    config: EventApiConfig,
    eventId: string,
    /** listFallback：关闭详情接口或请求失败时，caller 可直接拿列表项当详情；这里只负责请求不做 fallback */
): Promise<{ event?: UnifiedCampusEvent; rawResponse: unknown; mappingProblems: Array<{ field: string; reason: string }> }> {
    const ep = config.endpoints;
    if (!ep.enableDetailEndpoint) {
        return { event: undefined, rawResponse: null, mappingProblems: [] };
    }
    const tpl = ep.detailUrlTemplate ?? '';
    if (!tpl) {
        throw new Error('已开启详情接口但未配置 detailUrlTemplate');
    }
    const url = tpl.replaceAll('{id}', encodeURIComponent(eventId));
    const headers = buildHeaders(config);
    const init: RequestInit = {
        method: 'GET',
        headers,
        credentials: 'omit',
    };
    let response: Response;
    try {
        response = await fetch(url, init);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`详情请求失败：${url}（${msg}）`);
    }
    if (!response.ok) throw new Error(`详情 HTTP ${response.status}`);
    let payload: unknown;
    try {
        const text = await response.text();
        payload = text.trim() ? JSON.parse(text) : null;
    } catch (e) {
        throw new Error(`详情返回体不是合法 JSON：${e instanceof Error ? e.message : String(e)}`);
    }
    const path = (ep.detailDataPath ?? '').trim();
    let objRaw: unknown = path ? digPath(payload, path) : (payload as { data?: unknown })?.data ?? payload;
    if (!objRaw || typeof objRaw !== 'object') {
        throw new Error(`未挖到详情对象：detailDataPath=${path || '（默认 data）'}`);
    }
    const problems: Array<{ field: string; reason: string }> = [];
    const ev = mapSingle(objRaw as Record<string, unknown>, config.fieldMapping ?? {}, problems);
    return { event: ev, rawResponse: payload, mappingProblems: problems };
}

/** ================================================================
 *  五、编辑页面的"测试请求"按钮：wrapper，加耗时统计 + 问题清单聚合
 *  ================================================================ */
export async function testRequestList(config: EventApiConfig): Promise<TestRequestResult> {
    const start = performance.now();
    try {
        const r = await fetchUnifiedEventsList(config);
        const duration = Math.round(performance.now() - start);
        return {
            httpStatus: 200,
            durationMs: duration,
            rawResponse: r.rawResponse,
            rawList: r.rawList,
            events: r.events,
            mappingProblems: r.mappingProblems,
            ok: true,
        };
    } catch (e) {
        const duration = Math.round(performance.now() - start);
        const msg = e instanceof Error ? e.message : String(e);
        return {
            httpStatus: 0,
            durationMs: duration,
            rawResponse: msg,
            rawList: [],
            events: [],
            mappingProblems: [],
            ok: false,
            message: msg,
        };
    }
}
