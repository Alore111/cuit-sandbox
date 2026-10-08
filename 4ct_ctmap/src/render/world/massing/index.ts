import type { MassingKey } from '../../../contract';
import { buildArch } from './arch';
import { buildBlock } from './block';
import type { MassingBuilder } from './context';
import { buildShed } from './shed';
import { buildSkywalk } from './skywalk';
import { buildTower } from './tower';

/** 体量做法注册表：key 必须与 shared/constants/massing.ts 的 MASSING_KEYS 一致 */
export const MASSING: Record<MassingKey, MassingBuilder> = {
    block: buildBlock,
    shed: buildShed,
    arch: buildArch,
    tower: buildTower,
    skywalk: buildSkywalk
};

/** 详情卡展示的形制说明 */
export const MASSING_LABELS: Record<MassingKey, string> = {
    block: '板楼',
    shed: '单层大空间',
    arch: '大跨拱顶',
    tower: '塔楼',
    skywalk: '天桥'
};

export type { MassingBuilder, MassingContext } from './context';
