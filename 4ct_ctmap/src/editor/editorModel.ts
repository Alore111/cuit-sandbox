/* ================================================================
   编辑模型（纯函数）
   —— 所有「改数据」的计算都在这里，且一律**返回新文档**，不改传入的对象：
      撤销栈存的是快照，只有不可变更新才能让快照保持有效。

      需要投影（经纬度 ↔ 本地米）的计算不在这里 —— 那些归 EditorCanvas，
      因为投影的原点取自岛面轮廓的包围盒（见 projection.ts）。
================================================================ */

import { METERS_PER_DEGREE_LAT, metersPerDegreeLon } from '../contract';
import type { LonLat, RawBuildingEntry, RawBuildingTypeDef, RawParcelEntry } from '../contract';
import type { EditorDocument } from '../services/editorService';
import { sameTarget } from './editorTypes';
import type { EditorTarget, TargetShape } from './editorTypes';

/** 顶点数下限：三点以下不成面 */
export const MIN_VERTEX_COUNT = 3;

/** 分配一个没被占用的 id（后缀递增），避免与已有数据撞车 */
export function nextId(prefix: string, taken: Set<string>): string {
    let index = 1;
    while (taken.has(`${prefix}-${index}`)) index += 1;
    return `${prefix}-${index}`;
}

/* ----------------------------------------------------------------
   轮廓的离散编辑
---------------------------------------------------------------- */

/** 在 index 之后插入一个新顶点（新点取两端中点，随后由拖动落到目标位置） */
export function insertVertexAfter(outline: LonLat[], index: number): LonLat[] {
    if (index < 0 || index >= outline.length) return outline;

    const from = outline[index];
    const to = outline[(index + 1) % outline.length];
    const next = outline.slice();
    next.splice(index + 1, 0, [
        Number(((from[0] + to[0]) / 2).toFixed(7)),
        Number(((from[1] + to[1]) / 2).toFixed(7))
    ]);
    return next;
}

/** 删除第 index 个顶点；少于 MIN_VERTEX_COUNT 点时拒绝（返回原数组） */
export function removeVertexAt(outline: LonLat[], index: number): LonLat[] {
    if (index < 0 || index >= outline.length) return outline;
    if (outline.length <= MIN_VERTEX_COUNT) return outline;
    return outline.filter((_, i) => i !== index);
}

/** 周长（米）：按轮廓平均纬度换算经度尺度，与 polygonAreaM2 同一套近似 */
export function polygonPerimeterMeters(outline: LonLat[]): number {
    if (outline.length < 2) return 0;

    const meanLat = outline.reduce((sum, [lat]) => sum + lat, 0) / outline.length;
    const kx = metersPerDegreeLon(meanLat);

    let total = 0;
    for (let i = 0; i < outline.length; i += 1) {
        const [latA, lonA] = outline[i];
        const [latB, lonB] = outline[(i + 1) % outline.length];
        total += Math.hypot((lonB - lonA) * kx, (latB - latA) * METERS_PER_DEGREE_LAT);
    }
    return total;
}

/* ----------------------------------------------------------------
   目标 ↔ 轮廓
---------------------------------------------------------------- */

/** 三类对象压成同一份「可编辑轮廓」列表：绘制顺序即数组顺序（岛面在最下） */
export function buildShapes(doc: EditorDocument): TargetShape[] {
    return [
        { target: { kind: 'island' }, label: '岛面轮廓', outline: doc.school.island.outline },
        ...doc.parcels.map((entry) => ({
            target: { kind: 'parcel' as const, id: entry.id },
            label: entry.name || entry.id,
            outline: entry.outline
        })),
        ...doc.buildings.map((entry) => ({
            target: { kind: 'building' as const, id: entry.id },
            label: entry.name || entry.id,
            outline: entry.outline
        }))
    ];
}

export function outlineOf(doc: EditorDocument, target: EditorTarget): LonLat[] | null {
    if (target.kind === 'island') return doc.school.island.outline;

    const list: { id: string; outline: LonLat[] }[] =
        target.kind === 'building' ? doc.buildings : doc.parcels;
    return list.find((entry) => entry.id === target.id)?.outline ?? null;
}

/**
 * 用新轮廓替换某个目标的轮廓，返回新文档。
 * 「建筑 / 地皮 / 岛面」三条支路只在这里分叉一次，
 * 上层（画布、属性面板、快捷键）因此都只调这一个入口。
 */
export function withOutline(
    doc: EditorDocument,
    target: EditorTarget,
    outline: LonLat[]
): EditorDocument {
    if (target.kind === 'island') {
        return {
            ...doc,
            school: { ...doc.school, island: { ...doc.school.island, outline } }
        };
    }

    if (target.kind === 'building') {
        return {
            ...doc,
            buildings: doc.buildings.map((entry) =>
                entry.id === target.id ? { ...entry, outline } : entry
            )
        };
    }

    return {
        ...doc,
        parcels: doc.parcels.map((entry) => (entry.id === target.id ? { ...entry, outline } : entry))
    };
}

/* ----------------------------------------------------------------
   属性批量改写（属性表用）
---------------------------------------------------------------- */

/** 建筑条目的可批量编辑字段 */
export type BuildingPatch = Partial<Pick<RawBuildingEntry, 'name' | 'typeKey' | 'massing' | 'floors' | 'floorHeight'>>;

/** 地皮条目的可批量编辑字段 */
export type ParcelPatch = Partial<Pick<RawParcelEntry, 'name' | 'typeKey'>>;

export function patchBuildings(
    doc: EditorDocument,
    ids: readonly string[],
    patch: BuildingPatch
): EditorDocument {
    const idSet = new Set(ids);
    return {
        ...doc,
        buildings: doc.buildings.map((entry) => (idSet.has(entry.id) ? { ...entry, ...patch } : entry))
    };
}

export function patchParcels(
    doc: EditorDocument,
    ids: readonly string[],
    patch: ParcelPatch
): EditorDocument {
    const idSet = new Set(ids);
    return {
        ...doc,
        parcels: doc.parcels.map((entry) => (idSet.has(entry.id) ? { ...entry, ...patch } : entry))
    };
}

/** 删除一批目标（岛面不可删 —— 它是单例且是地表铺装范围的来源） */
export function removeTargets(doc: EditorDocument, targets: readonly EditorTarget[]): EditorDocument {
    const buildingIds = new Set<string>();
    const parcelIds = new Set<string>();

    for (const target of targets) {
        if (target.kind === 'building') buildingIds.add(target.id);
        if (target.kind === 'parcel') parcelIds.add(target.id);
    }

    return {
        ...doc,
        buildings: doc.buildings.filter((entry) => !buildingIds.has(entry.id)),
        parcels: doc.parcels.filter((entry) => !parcelIds.has(entry.id))
    };
}

/* ----------------------------------------------------------------
   类型配色（改的是**类型字典**，不是某个「当前编辑对象」）
---------------------------------------------------------------- */

/** 类型字典里开放的配色字段；null = 删掉该字段，回到「跟随色板」 */
export interface TypeColorPatch {
    wallColor?: string | null;
    roofColor?: string | null;
}

const TYPE_COLOR_FIELDS = ['wallColor', 'roofColor'] as const;

/**
 * 改某个建筑类型的主色调，返回新文档。
 * 【口径】null 是**删字段**，不是写一个 null 进去：磁盘上「没有这个键」才叫
 * 「跟随色板」，与建筑条目里 typeKey / floors 的「未覆盖」是同一套语义 ——
 * 写 null 只会在数据里留下一堆无意义的空值，让「到底有没有配过色」读不出来。
 * 字典里不存在的类型直接返回原文档（配色面板的输入来自同一份字典，正常不会发生）。
 */
export function setTypeColors(
    doc: EditorDocument,
    typeKey: string,
    patch: TypeColorPatch
): EditorDocument {
    const current = doc.buildingTypes.types[typeKey];
    if (!current) return doc;

    const next: RawBuildingTypeDef = { ...current };
    for (const field of TYPE_COLOR_FIELDS) {
        const value = patch[field];
        if (value === undefined) continue;
        if (value === null) delete next[field];
        else next[field] = value;
    }

    return {
        ...doc,
        buildingTypes: {
            ...doc.buildingTypes,
            types: { ...doc.buildingTypes.types, [typeKey]: next }
        }
    };
}

/* ----------------------------------------------------------------
   新建条目
---------------------------------------------------------------- */

export function createBuildingEntry(id: string, outline: LonLat[]): RawBuildingEntry {
    /* typeKey / massing / floors / floorHeight / massingParams 全部留空 = 跟随类型字典 */
    return { id, name: '新建建筑', kind: '', source: 'manual', outline };
}

export function createParcelEntry(id: string, outline: LonLat[], typeKey: string): RawParcelEntry {
    return { id, name: '新建地皮', typeKey, source: 'manual', outline };
}

/** 合并两个选择集（按 target 去重）：框选加选、属性表加选都用它 */
export function mergeTargets(a: readonly EditorTarget[], b: readonly EditorTarget[]): EditorTarget[] {
    const merged = [...a];
    for (const target of b) {
        if (!merged.some((item) => sameTarget(item, target))) merged.push(target);
    }
    return merged;
}

/** id 占用表：新建条目前用来避让 */
export function takenIds(doc: EditorDocument, kind: 'building' | 'parcel'): Set<string> {
    const list: { id: string }[] = kind === 'building' ? doc.buildings : doc.parcels;
    return new Set(list.map((entry) => entry.id));
}
