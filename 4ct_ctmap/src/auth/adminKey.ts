/* ================================================================
   管理员密钥（编辑页鉴权）
   —— 编辑页的写接口（地图覆盖写回、事件配置保存）由后端 `X-Admin-Key`
      共享密钥保护。密钥由用户在编辑页录入后保存在 sessionStorage，
      `request()`（client.ts）在发请求时自动附带该 header —— 后端只在
      写接口校验它，读接口忽略，因此门禁通过后无需区分读写。
   ================================================================ */

const ADMIN_KEY_STORAGE_KEY = '4ct.admin-key';

/** 读取当前会话已录入的管理员密钥（未录入返回空串） */
export function getAdminKey(): string {
    try {
        return (sessionStorage.getItem(ADMIN_KEY_STORAGE_KEY) ?? '').trim();
    } catch {
        return '';
    }
}

/** 录入管理员密钥到会话存储（仅当前标签页会话有效，关页即失） */
export function setAdminKey(key: string): void {
    sessionStorage.setItem(ADMIN_KEY_STORAGE_KEY, key.trim());
}

/** 清除管理员密钥（登出），业务侧用于重新鉴权 */
export function clearAdminKey(): void {
    sessionStorage.removeItem(ADMIN_KEY_STORAGE_KEY);
}