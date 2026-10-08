/* ================================================================
   体量做法与几何参数的公共口径
   —— MASSING_KEYS 是后端校验、前端渲染、编辑器下拉三处共用的白名单。
      本文件必须与另一个项目的同名副本逐字一致（见 index.ts 的同步要求）。
================================================================ */

import type { MassingKey } from './types';

/** 全部体量做法 key：后端用它校验数据，渲染层用它在 massing 注册表里查实现 */
export const MASSING_KEYS: readonly MassingKey[] = ['block', 'shed', 'arch', 'tower', 'skywalk'];

/** 所有以米为单位的几何参数都必须带这个后缀（口径见设计文档 §7.6） */
export const METERS_SUFFIX = 'Meters';

export function isMassingKey(value: unknown): value is MassingKey {
    return typeof value === 'string' && (MASSING_KEYS as readonly string[]).includes(value);
}
