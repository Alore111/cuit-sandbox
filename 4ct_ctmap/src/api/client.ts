import type { ApiEnvelope } from '../contract';
import { getAdminKey } from '../auth/adminKey';

/** 管理员密钥请求头（与后端 server/src/middleware/auth.ts 一致） */
const ADMIN_KEY_HEADER = 'X-Admin-Key';

/** 接口调用失败（网络、响应壳 success=false、返回体不是合法 JSON） */
export class ApiError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
    }
}

/**
 * 后端地址。两种运行环境的来源不同，因此**在发请求时才解析**，而不是模块加载时取一次：
 *   - 浏览器：vite 把 import.meta.env.VITE_API_BASE 内联进来（开发期留空 = 同源，由 vite proxy 转发）；
 *   - Node 自检脚本（scripts/check-world.ts）：没有 import.meta.env，改读 process.env.VITE_API_BASE，
 *     脚本可以在调用之前把自己要连的后端地址写进去。
 * 默认空串表示同源；部署时用 VITE_API_BASE 指到后端域名。
 */
function resolveApiBase(): string {
    const fromVite = import.meta.env?.VITE_API_BASE;
    if (fromVite) return fromVite;
    return typeof process === 'undefined' ? '' : process.env.VITE_API_BASE ?? '';
}

/**
 * 统一请求入口：解响应壳，把失败转成异常。
 * 【口径】失败一律抛出，不做任何兜底 —— 上层要么展示错误，要么就是 bug，
 * 不存在「悄悄返回一份空数据继续跑」这条路。
 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${resolveApiBase()}${path}`;
    // 已录入管理员密钥则自动附带；后端仅写接口校验，读接口忽略，无需区分读写
    const adminKey = getAdminKey();
    let response: Response;
    try {
        response = await fetch(url, {
            ...init,
            headers: {
                Accept: 'application/json',
                ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
                ...(adminKey ? { [ADMIN_KEY_HEADER]: adminKey } : {}),
                ...init?.headers
            }
        });
    } catch (error) {
        throw new ApiError(
            `请求失败：${url}（${error instanceof Error ? error.message : String(error)}）`,
            0
        );
    }

    let payload: ApiEnvelope<T>;
    try {
        payload = (await response.json()) as ApiEnvelope<T>;
    } catch {
        throw new ApiError(`${url} 返回的不是合法 JSON（HTTP ${response.status}）`, response.status);
    }

    if (!payload.success) {
        throw new ApiError(payload.message || `${url} 返回失败`, response.status);
    }

    return payload.data;
}
