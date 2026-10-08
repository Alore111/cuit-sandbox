import type { NextFunction, Request, Response } from 'express';

/**
 * 共享管理员密钥鉴权（编辑页写接口用）
 * —— 地图写接口与事件配置写接口都只会被编辑器调用，用一把简单的共享密钥保护即可：
 *   请求头 `X-Admin-Key` 必须等于环境变量 `CTMAP_ADMIN_KEY`。
 *
 * 【口径】密钥来自环境变量，不内置默认值（写死密钥=形同虚设的假安全）。
 *   未配置 `CTMAP_ADMIN_KEY` 时放行但打印警告 —— 避免开发/内网环境被密钥挡住，
 *   也避免在没配密钥时偷偷放行不吱声；一旦配置即严格校验。
 */

export const ADMIN_KEY_HEADER = 'x-admin-key';

/** 取管理员密钥（未配置返回空串） */
export function resolveAdminKey(): string {
    return (process.env.CTMAP_ADMIN_KEY ?? '').trim();
}

/**
 * 写接口鉴权中间件。
 * 未配置密钥 → 放行 + 一次性警告；已配置 → 校验 X-Admin-Key，不匹配返回 401。
 */
export function requireAdminKey(req: Request, res: Response, next: NextFunction): void {
    const key = resolveAdminKey();
    if (!key) {
        console.warn(
            '[4ct-map] 未配置 CTMAP_ADMIN_KEY，写接口当前处于【不鉴权】状态。' +
            '生产/公网部署请务必设置该环境变量。'
        );
        next();
        return;
    }
    const provided = (req.header(ADMIN_KEY_HEADER) ?? '').trim();
    if (provided !== key) {
        res.status(401).json({ success: false, message: '管理员密钥错误或缺失', data: {} });
        return;
    }
    next();
}