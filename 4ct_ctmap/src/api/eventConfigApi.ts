import type { ApiEnvelope, EventApiConfig } from '../contract';
import { request } from './client';

export type { EventApiConfig };

/** 配置读写接口路由前缀（挂载在后端 /api/event-config） */
export const EVENT_CONFIG_PREFIX = '/api/event-config';

/** localStorage 键：后端不可用时做本地兜底存储（离线编辑 + 导入导出用） */
export const EVENT_CONFIG_LOCAL_KEY = '4ct.event-api.config.v1';

/**
 * 读配置：先尝试后端 REST；失败不兜底抛异常 —— 上层用 try/catch 决定是否退 localStorage。
 */
export async function fetchEventConfig(): Promise<EventApiConfig> {
    return request<EventApiConfig>(EVENT_CONFIG_PREFIX, { method: 'GET' });
}

/**
 * 写配置：后端写入；成功后 caller 负责同步 localStorage 备份。
 */
export async function saveEventConfig(cfg: EventApiConfig): Promise<EventApiConfig> {
    return request<EventApiConfig>(EVENT_CONFIG_PREFIX, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
    });
}

/* ---------------- 本地兜底：localStorage 读写 + JSON 导入导出 ---------------- */

export function readEventConfigLocal(): EventApiConfig | null {
    try {
        const raw = localStorage.getItem(EVENT_CONFIG_LOCAL_KEY);
        if (!raw) return null;
        const obj = JSON.parse(raw) as EventApiConfig;
        return obj && typeof obj === 'object' ? obj : null;
    } catch {
        return null;
    }
}

export function writeEventConfigLocal(cfg: EventApiConfig): void {
    localStorage.setItem(EVENT_CONFIG_LOCAL_KEY, JSON.stringify(cfg));
}

/**
 * 双通道读取：优先后端 → 失败时 localStorage → 都没有返回 null，由 caller 生成默认值。
 * 【口径】失败不抛异常（为了离线编辑也能用），用返回值区分：null = 两边都没有。
 */
export async function loadEventConfigDual(): Promise<{ config: EventApiConfig | null; source: 'server' | 'local' | 'none'; error?: string }> {
    // 1) 后端
    try {
        const cfg = await fetchEventConfig();
        if (cfg && typeof cfg === 'object') {
            return { config: cfg, source: 'server' };
        }
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // 后端失败继续走 localStorage，不把错误抛给 UI
        const local = readEventConfigLocal();
        if (local) return { config: local, source: 'local', error: `后端配置读取失败（${msg}），已回退本地副本` };
        return { config: null, source: 'none', error: `后端配置读取失败（${msg}），且本地暂无副本` };
    }
    // 2) 后端返回了但结构不对 → 回退 localStorage
    const local = readEventConfigLocal();
    if (local) return { config: local, source: 'local', error: '后端返回结构异常，已回退本地副本' };
    return { config: null, source: 'none' };
}

/**
 * 双通道保存：优先后端 → 失败时仅写 localStorage 并返回 warning 让 UI 标注。
 * @returns { saved: boolean, serverSaved: boolean, message: string }
 */
export async function saveEventConfigDual(cfg: EventApiConfig): Promise<{ saved: boolean; serverSaved: boolean; message: string; config?: EventApiConfig }> {
    // 先无条件写 localStorage：后端挂了也能继续用
    try {
        writeEventConfigLocal(cfg);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { saved: false, serverSaved: false, message: `写入 localStorage 失败：${msg}` };
    }
    // 再写后端
    try {
        const next = await saveEventConfig(cfg);
        return { saved: true, serverSaved: true, message: '已保存到服务端配置文件', config: next };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
            saved: true,
            serverSaved: false,
            message: `仅已保存到本地浏览器（服务端写入失败：${msg}），可使用「导出 JSON」做备份`,
        };
    }
}

/* ---------------- JSON 导入导出（文件对话框） ---------------- */

/** 触发浏览器下载：把 config 导出为 .json 文件 */
export function exportEventConfigJson(cfg: EventApiConfig, filename = '4ct-event-api-config.json'): void {
    const blob = new Blob([JSON.stringify(cfg, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 从 File 对象读取并解析 JSON 为 EventApiConfig（做浅校验，不做字段级清洗）。
 * 【口径】不兼容就明确报错，不偷偷填默认值 —— 用户导错文件时立刻看到。
 */
export async function importEventConfigJson(file: File): Promise<EventApiConfig> {
    const text = await file.text();
    let obj: unknown;
    try {
        obj = JSON.parse(text);
    } catch (e) {
        throw new Error(`文件不是合法 JSON：${e instanceof Error ? e.message : String(e)}`);
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        throw new Error('JSON 根节点必须是对象');
    }
    return obj as EventApiConfig;
}

/** 生成一份默认配置（后端没有 + localStorage 也没有时使用） */
export function createDefaultEventConfig(): EventApiConfig {
    return {
        version: 1,
        name: '默认第三方接口（未配置）',
        headers: [
            { key: 'Authorization', value: 'Bearer <your-token>', enabled: false },
        ],
        endpoints: {
            url: '',
            method: 'GET',
            listDataPath: '',
            detailDataPath: '',
            enableDetailEndpoint: false,
            detailUrlTemplate: '',
        },
        searchEndpoints: {
            url: '',
            method: 'GET',
            listDataPath: '',
        },
        fieldMapping: {},
        savedAt: 0,
    };
}

// 兼容旧 client.ts：防止未使用的 ApiEnvelope import 被 tree-shake 时报错
export type _Envelope<T> = ApiEnvelope<T>;
