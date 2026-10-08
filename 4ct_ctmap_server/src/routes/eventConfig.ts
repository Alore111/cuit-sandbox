import { Router, type Request, type Response, type NextFunction } from 'express';
import { readDataJson, writeDataJson } from '../loaders/jsonStore';
import { requireAdminKey } from '../middleware/auth';
import { ok } from '../middleware/response';

/**
 * express 4 不会自动捕获 async 处理函数抛出的异常，
 * 这里统一把 rejection 转交给错误中间件。
 */
function asyncHandler(
    handler: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => {
        handler(req, res).catch(next);
    };
}

/** 配置文件名：后端唯一真源，前端 GET/PUT 都走这个文件 */
const CONFIG_FILE = 'event-config.json';

/** 最小形状校验：写盘前做一次浅校验，避免整写 JSON 结构写错把编辑器搞崩 */
function assertConfigShape(obj: unknown): asserts obj is {
    version?: number;
    name?: string;
    headers?: unknown;
    endpoints?: unknown;
    fieldMapping?: unknown;
} {
    if (!obj || typeof obj !== 'object') {
        throw new Error('请求体必须是 JSON 对象');
    }
    const o = obj as Record<string, unknown>;
    if (o.headers != null && !Array.isArray(o.headers)) {
        throw new Error('headers 必须是数组或留空');
    }
    if (o.endpoints != null && (typeof o.endpoints !== 'object' || Array.isArray(o.endpoints))) {
        throw new Error('endpoints 必须是对象或留空');
    }
    if (o.fieldMapping != null && (typeof o.fieldMapping !== 'object' || Array.isArray(o.fieldMapping))) {
        throw new Error('fieldMapping 必须是对象或留空');
    }
}

export const eventConfigRouter = Router();

/** 读：从 data/event-config.json 读当前配置。文件不存在 → 返回 404 DataError（上层 catch 转 500，不做兜底） */
eventConfigRouter.get(
    '/',
    asyncHandler(async (_req, res) => {
        const cfg = await readDataJson<unknown>(CONFIG_FILE);
        ok(res, cfg);
    })
);

/** 写：整份覆盖写 data/event-config.json，写盘前补 savedAt 时间戳，返回保存后的配置（需管理员密钥） */
eventConfigRouter.put(
    '/',
    requireAdminKey,
    asyncHandler(async (req, res) => {
        assertConfigShape(req.body);
        const savedAt = Date.now();
        const next = {
            ...(req.body as Record<string, unknown>),
            savedAt,
            version: typeof req.body?.version === 'number' ? req.body.version : 1,
        };
        await writeDataJson(CONFIG_FILE, next);
        ok(res, next, `已写入 ${CONFIG_FILE}，原文件备份为 .bak`);
    })
);
