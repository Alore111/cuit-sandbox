import type { NextFunction, Request, Response } from 'express';
import { DataError } from '../errors';

/**
 * 统一响应壳，与 4ct_backend_core/utils/response.py 保持同一形状：
 *   { success, message, data }
 * 注意：判空必须用 `=== undefined`，否则 [] / 0 / false 这类合法值会被替换掉。
 */
export function ok<T>(res: Response, data: T, message = 'success'): void {
    res.json({ success: true, message, data: data === undefined ? {} : data });
}

export function fail(res: Response, message: string, status: number): void {
    res.status(status).json({ success: false, message, data: {} });
}

/** 未匹配到任何路由 */
export function notFound(_req: Request, res: Response): void {
    fail(res, '接口不存在', 404);
}

/**
 * 统一错误出口。
 * express 4 的错误中间件必须是 4 个参数，因此 _next 不能省。
 */
export function errorHandler(
    error: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction
): void {
    if (error instanceof DataError) {
        console.error('[4ct-map] 数据错误：', error.message);
        fail(res, error.message, 500);
        return;
    }

    console.error('[4ct-map] 未预期错误：', error);
    fail(res, error instanceof Error ? error.message : String(error), 500);
}
