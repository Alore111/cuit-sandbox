/* ================================================================
   地点词典匹配：真实地理文字 → 具体地点（补出经纬度）
   —— 事件可能没有经纬度，但有地理文字（地址区域串/详细地址）。
      places.json 是一份「地点词典」，每条描述一个可匹配的地点：
      · mustInclude：待匹配文本必须命中（至少一个）才纳入候选
      · mustExclude：待匹配文本命中任一即排除（处理同名异位/歧义）
      · keywords：额外命中加分词（提升区分度）
      · weight：地点自身权重（默认 1）
      · buildingIds / parcelIds：关联的建筑 / 地皮 ID（可多选，锚定具体对象）
      · position：该地点的 WGS-84 坐标 [纬度, 经度]（缺省时优先取关联 object 中心）
   命中项支持两种写法：
      · 普通词：待匹配文本包含该子串即命中。
      · 正则项：以 "/" 开头和结尾的整串编译为正则，用 test() 命中
        （如 "/H[0-9][A-Za-z]{2}/" 可命中 "H1XX" 这类教室编号）。
   匹配原则：「必现/禁现 + 命中越多分越高 + 无匹配即空置」。
   匹配出的坐标已是 WGS-84，与前端 Esri 底图对齐，不需要再转换。
================================================================ */

import { readDataJson } from '../loaders/jsonStore';

/** 归一化待匹配文本：去首尾空白 + 合并重复空白 + 转小写（兜底英文类） */
export function normalizeText(text: string): string {
    return (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 判断一个规则词是否为正则项：以 "/" 开头且以 "/" 结尾（长度 >= 2）。
 * 体会被编译为正则（不含首尾斜杠）。返回编译好的 RegExp 或 null（非正则）。
 */
export function tryCompileRegex(term: string): RegExp | null {
    if (term.length < 2 || !term.startsWith('/') || !term.endsWith('/')) return null;
    const body = term.slice(1, -1);
    if (!body) return null;
    try {
        return new RegExp(body);
    } catch {
        return null; // 非法正则当作无效项（不匹配、不计分）
    }
}

/** 单个规则词命中测试：正则 test() 或普通子串包含。命中返回匹配位置（正则 exec.index / 子串 index），否则 null。 */
function termHit(text: string, term: string): number | null {
    const re = tryCompileRegex(term);
    if (re) {
        const m = re.exec(text);
        return m ? (m.index ?? 0) : null;
    }
    const idx = text.indexOf(term.toLowerCase());
    return idx >= 0 ? idx : null;
}

export interface PlaceRule {
    name: string;
    /** 命中任一才候选；至少得有一个。支持普通词与 "/.../" 正则项 */
    mustInclude: string[];
    /** 命中任一即排除。支持普通词与 "/.../" 正则项 */
    mustExclude?: string[];
    /** 额外加分词。支持普通词与 "/.../" 正则项 */
    keywords?: string[];
    /** 地点权重（加分系数），默认 1 */
    weight?: number;
    /** 关联建筑 ID（可多选）：命中后用于锚定具体楼；可借此计算中心坐标 */
    buildingIds?: string[];
    /** 关联地皮 ID（可多选，如 `p-hw-543937595`）：命中后锚定地皮；可借此计算中心坐标 */
    parcelIds?: string[];
    /** 该地点自身的 WGS-84 坐标 [纬度, 经度]（可省略，缺省时优先取关联建筑/地皮中心） */
    position?: [number, number];
    /** 命中后作为 locationId 使用；缺省用 name */
    locationId?: string;
}

export interface PlaceMatch {
    /** 命中的 place */
    place: PlaceRule;
    /** 匹配得分（越高越可信） */
    score: number;
    /** 命中的词明细（调试/展示用） */
    hitKeys: { must: string[]; keywords: string[] };
    /** 具体度：必现词在文本中的最靠后位置（越大越具体，用于同分 tie-break） */
    placeRank: number;
}

/**
 * 在词典中为「地理文字」挑出最佳匹配。
 * 规则：
 *   1. mustInclude 至少命中一个 → 候选；命中 mustExclude 任一 → 剔除。
 *   2. 得分 = 命中的 mustInclude 数 × 3 + 命中关键词数 + weight。
 *   3. 同分时取「具体度」更高者：必现词在文本中出现的位置越靠后越具体
 *      （地址多为「区域 + 具体地点」，后段是建筑/场所）。
 *   4. 再同分按名称长度、定义顺序稳定兜底。
 * @returns 命中返回 match；无匹配返回 null（调用方保持 position 空置，不兜底）。
 */
export function matchPlace(geoText: string | undefined | null, places: PlaceRule[]): PlaceMatch | null {
    const text = normalizeText(geoText ?? '');
    if (!text) return null;

    let best: PlaceMatch | null = null;

    for (const place of places) {
        const mustInclude = (place.mustInclude ?? []).filter((t) => t.trim()).map(normalizeText);
        const mustExclude = (place.mustExclude ?? []).filter((t) => t.trim()).map(normalizeText);
        if (mustInclude.length === 0) continue; // 规则要求至少一个必现词，否则无法判定

        // 1) 必现：至少命中一个才可能成为候选
        const hitMust = mustInclude.filter((n) => termHit(text, n) !== null);
        if (hitMust.length === 0) continue;

        // 2) 禁现：命中任一再优质的候选也剔除
        const hitExclude = mustExclude.filter((n) => termHit(text, n) !== null);
        if (hitExclude.length > 0) continue;

        // 3) 加分关键词
        const hitKeywords = (place.keywords ?? [])
            .filter((t) => t.trim())
            .map(normalizeText)
            .filter((n) => termHit(text, n) !== null);

        // 4) 权重分
        const weightBonus = typeof place.weight === 'number' ? place.weight : 1;
        const score = hitMust.length * 3 + hitKeywords.length + weightBonus;

        // 5) 具体度：必现词在文本中的最靠后命中位置
        const depths = hitMust.map((n) => termHit(text, n) ?? 0);
        const placeRank = Math.max(...depths);

        // 6) tie-break：先比分数，再比具体度，名称长度兜底
        if (
            best === null ||
            score > best.score ||
            (score === best.score &&
                (placeRank > best.placeRank ||
                    (placeRank === best.placeRank && place.name.length > best.place.name.length)))
        ) {
            best = { place, score, hitKeys: { must: hitMust, keywords: hitKeywords }, placeRank };
        }
    }

    return best;
}

/* ================================================================
 *  places.json 加载（含建筑/地皮中心兜底）
 *   —— 地点条目可只写「名称/必现词 + 关联建筑或地皮 ID」，坐标缺省时
 *      优先从关联对象 outline 求中心；再不行才需要手填 position。
 * ================================================================ */

interface PlacesFile {
    places: PlaceRule[];
}

interface OutlineEntry {
    id: string;
    outline: [number, number][];
}

/** 求多边形轮廓中心（各顶点经纬度均值），非法返回 null */
function outlineCenter(outline: [number, number][] | undefined): [number, number] | null {
    if (!outline || outline.length === 0) return null;
    const parts = outline.filter((p) => Array.isArray(p) && p.length === 2);
    if (parts.length === 0) return null;
    let la = 0;
    let lo = 0;
    for (const [a, b] of parts) {
        la += a;
        lo += b;
    }
    return [+(la / parts.length).toFixed(6), +(lo / parts.length).toFixed(6)];
}

/** 根据 id 列表，从索引里取第一个有中心的坐标 */
function firstCenter(ids: string[] | undefined, index: Map<string, [number, number]>): [number, number] | null {
    for (const id of ids ?? []) {
        const c = index.get(String(id));
        if (c) return c;
    }
    return null;
}

/**
 * 读取 places.json 并解析出可直接用于匹配的地点列表：
 *   · 地点未显式给 position 时，尝试从关联建筑 / 地皮的 outline 中心补出（建筑优先）。
 *   · 借助 jsonStore 的 mtime 缓存，places.json / buildings.json / parcels.json 改动后自动失效。
 */
export async function loadPlaces(): Promise<PlaceRule[]> {
    const [placesRaw, buildingsRaw, parcelsRaw] = await Promise.all([
        readDataJson<PlacesFile>('places.json'),
        readDataJson<{ items: OutlineEntry[] }>('buildings.json'),
        readDataJson<{ items: OutlineEntry[] }>('parcels.json'),
    ]);

    const buildingCenter = new Map<string, [number, number]>();
    for (const b of buildingsRaw.items ?? []) {
        const c = outlineCenter(b.outline);
        if (c) buildingCenter.set(String(b.id), c);
    }
    const parcelCenter = new Map<string, [number, number]>();
    for (const p of parcelsRaw.items ?? []) {
        const c = outlineCenter(p.outline);
        if (c) parcelCenter.set(String(p.id), c);
    }

    const resolved: PlaceRule[] = [];
    for (const place of placesRaw.places ?? []) {
        const copy: PlaceRule = { ...place };
        if (!copy.position) {
            const c = firstCenter(copy.buildingIds, buildingCenter) ?? firstCenter(copy.parcelIds, parcelCenter);
            if (c) copy.position = c;
        }
        resolved.push(copy);
    }
    return resolved;
}