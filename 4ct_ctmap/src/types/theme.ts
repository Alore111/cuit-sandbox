/**
 * 主题名 —— 二期起这两个主题就是字面意义的夜晚与白天：
 *   night 深蓝夜空 + 星空月亮 + 岛面灯火
 *   day   蓝天白云 + 太阳 + 通透日光
 */
export type ThemeName = 'night' | 'day';

export const THEME_NAMES: readonly ThemeName[] = ['night', 'day'];

export function isThemeName(value: unknown): value is ThemeName {
    return value === 'night' || value === 'day';
}
