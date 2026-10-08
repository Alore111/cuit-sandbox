import { isThemeName, type ThemeName } from '../types/theme';

const STORAGE_KEY = '4ct-ctmap:theme';

function readStoredTheme(): ThemeName | null {
    try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        return isThemeName(stored) ? stored : null;
    } catch (error) {
        console.warn('[4ct-map] 主题偏好读取失败，本次会话使用系统偏好：', error);
        return null;
    }
}

/**
 * 主题初值：本地存过的偏好 > 系统偏好 > 夜晚（默认观感）。
 * 【口径】主题是用户偏好，可以持久化 —— 与 3CT App 里「代理开关不得持久化」的安全口径无关。
 */
export function readInitialTheme(): ThemeName {
    const stored = readStoredTheme();
    if (stored) return stored;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'day' : 'night';
}

export function persistTheme(theme: ThemeName): void {
    try {
        window.localStorage.setItem(STORAGE_KEY, theme);
    } catch (error) {
        console.warn('[4ct-map] 主题偏好写入失败，本次会话内仍会正常切换：', error);
    }
}

/** 主题的视觉落点：<html data-theme> 驱动 UI 令牌，3D 侧由 stage/world 各自响应 */
export function applyThemeToDocument(theme: ThemeName): void {
    document.documentElement.dataset.theme = theme;
}
