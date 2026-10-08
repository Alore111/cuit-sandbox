/* ================================================================
   JSON 数据的合法性校验
   —— 只做「结构对不对」，不做任何缺省填充。
      校验失败一律抛 DataError，message 里必须带上是哪个文件、哪条数据（id）、哪个字段，
      不允许出现「数据异常」这类无法定位的描述。
================================================================ */

import { HEX_COLOR_PATTERN, isMassingKey, METERS_SUFFIX } from '../contract';
import type {
    BuildingTypeDef,
    BuildingTypeDictionary,
    DataSource,
    Island,
    IslandDebris,
    IslandRimProp,
    IslandRockLayer,
    LonLat,
    MassingKey,
    MassingParams,
    RimPropKind,
    School,
    TerrainTypeDef,
    TerrainTypeDictionary
} from '../contract';
import { DataError } from '../errors';

/* ----------------------------------------------------------------
   基础断言
---------------------------------------------------------------- */

function asRecord(value: unknown, where: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new DataError(`${where} 应为对象`);
    }
    return value as Record<string, unknown>;
}

function reqString(value: unknown, field: string, where: string): string {
    if (typeof value !== 'string' || value === '') {
        throw new DataError(`${where} 的 ${field} 必须是非空字符串`);
    }
    return value;
}

function optString(value: unknown, field: string, where: string): string {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') {
        throw new DataError(`${where} 的 ${field} 必须是字符串`);
    }
    return value;
}

function reqNumber(value: unknown, field: string, where: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new DataError(`${where} 的 ${field} 必须是有限数字`);
    }
    return value;
}

function reqPositive(value: unknown, field: string, where: string): number {
    const n = reqNumber(value, field, where);
    if (n <= 0) {
        throw new DataError(`${where} 的 ${field} 必须大于 0（当前 ${n}）`);
    }
    return n;
}

function reqNonNegative(value: unknown, field: string, where: string): number {
    const n = reqNumber(value, field, where);
    if (n < 0) {
        throw new DataError(`${where} 的 ${field} 不能为负数（当前 ${n}）`);
    }
    return n;
}

/** 可选的数值字段：null / 省略表示「跟随类型字典」，不合法则报错 */
function optPositive(value: unknown, field: string, where: string): number | null {
    if (value === undefined || value === null) return null;
    return reqPositive(value, field, where);
}

/**
 * 可选的主色调字段（wallColor / roofColor）：null / 省略 = 「跟随色板」。
 * 给了就必须是 #rrggbb —— 不猜、不补全、不把 #rgb 当 #rrggbb 用。
 */
function optHexColor(value: unknown, field: string, where: string): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string' || !HEX_COLOR_PATTERN.test(value)) {
        throw new DataError(`${where} 的 ${field} 必须是 #rrggbb 形式的颜色：${String(value)}`);
    }
    return value;
}

function reqBoolean(value: unknown, field: string, where: string): boolean {
    if (typeof value !== 'boolean') {
        throw new DataError(`${where} 的 ${field} 必须是布尔值`);
    }
    return value;
}

/** 轮廓：至少 3 个 [lat, lon] 点，经纬度必须在合法范围内 */
function reqOutline(value: unknown, field: string, where: string): LonLat[] {
    if (!Array.isArray(value) || value.length < 3) {
        throw new DataError(`${where} 的 ${field} 至少需要 3 个点`);
    }

    return value.map((point, index) => {
        if (!Array.isArray(point) || point.length !== 2) {
            throw new DataError(`${where} 的 ${field} 第 ${index + 1} 个点必须是 [lat, lon]`);
        }
        const [lat, lon] = point as unknown[];
        if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
            throw new DataError(`${where} 的 ${field} 第 ${index + 1} 个点的纬度不合法：${String(lat)}`);
        }
        if (typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180) {
            throw new DataError(`${where} 的 ${field} 第 ${index + 1} 个点的经度不合法：${String(lon)}`);
        }
        return [lat, lon] as LonLat;
    });
}

/** 条目集合的公共外壳：{ version, items } */
function reqItems(raw: unknown, where: string): unknown[] {
    const record = asRecord(raw, where);
    reqNumber(record.version, 'version', where);
    if (!Array.isArray(record.items)) {
        throw new DataError(`${where} 的 items 必须是数组`);
    }
    return record.items;
}

/* ----------------------------------------------------------------
   学校配置
---------------------------------------------------------------- */

function reqLat(value: unknown, field: string, where: string): number {
    const n = reqNumber(value, field, where);
    if (n < -90 || n > 90) {
        throw new DataError(`${where} 的 ${field} 纬度超出范围：${n}`);
    }
    return n;
}

function reqLon(value: unknown, field: string, where: string): number {
    const n = reqNumber(value, field, where);
    if (n < -180 || n > 180) {
        throw new DataError(`${where} 的 ${field} 经度超出范围：${n}`);
    }
    return n;
}

/** 岛缘小建筑的形制：只有渲染层实现了的才允许写进数据 */
const RIM_PROP_KINDS: readonly RimPropKind[] = ['pavilion', 'tower'];

function validateIsland(raw: unknown, where: string): Island {
    const islandWhere = `${where} 的 island`;
    const record = asRecord(raw, islandWhere);

    if (!Array.isArray(record.rockLayers) || record.rockLayers.length === 0) {
        throw new DataError(`${islandWhere} 的 rockLayers 必须是非空数组`);
    }
    const rockLayers: IslandRockLayer[] = record.rockLayers.map((layerRaw, index) => {
        const layerWhere = `${islandWhere} 的 rockLayers[${index}]`;
        const layer = asRecord(layerRaw, layerWhere);
        return {
            thicknessMeters: reqPositive(layer.thicknessMeters, 'thicknessMeters', layerWhere),
            paletteKey: reqString(layer.paletteKey, 'paletteKey', layerWhere)
        };
    });

    const seenPropIds = new Set<string>();
    if (!Array.isArray(record.rimProps)) {
        throw new DataError(`${islandWhere} 的 rimProps 必须是数组`);
    }
    const rimProps: IslandRimProp[] = record.rimProps.map((propRaw, index) => {
        const propWhere = `${islandWhere} 的 rimProps[${index}]`;
        const prop = asRecord(propRaw, propWhere);
        const id = reqString(prop.id, 'id', propWhere);
        if (seenPropIds.has(id)) {
            throw new DataError(`${islandWhere} 的 rimProps 里 id 重复：${id}`);
        }
        seenPropIds.add(id);

        if (!RIM_PROP_KINDS.includes(prop.kind as RimPropKind)) {
            throw new DataError(
                `${propWhere} 的 kind 不是已实现的形制：${String(prop.kind)}（可选 ${RIM_PROP_KINDS.join(' / ')}）`
            );
        }

        return {
            id,
            kind: prop.kind as RimPropKind,
            lat: reqLat(prop.lat, 'lat', propWhere),
            lon: reqLon(prop.lon, 'lon', propWhere)
        };
    });

    const seenDebrisIds = new Set<string>();
    if (!Array.isArray(record.debris)) {
        throw new DataError(`${islandWhere} 的 debris 必须是数组`);
    }
    const debris: IslandDebris[] = record.debris.map((itemRaw, index) => {
        const itemWhere = `${islandWhere} 的 debris[${index}]`;
        const item = asRecord(itemRaw, itemWhere);
        const id = reqString(item.id, 'id', itemWhere);
        if (seenDebrisIds.has(id)) {
            throw new DataError(`${islandWhere} 的 debris 里 id 重复：${id}`);
        }
        seenDebrisIds.add(id);

        return {
            id,
            lat: reqLat(item.lat, 'lat', itemWhere),
            lon: reqLon(item.lon, 'lon', itemWhere),
            depthMeters: reqPositive(item.depthMeters, 'depthMeters', itemWhere),
            sizeMeters: reqPositive(item.sizeMeters, 'sizeMeters', itemWhere)
        };
    });

    return {
        outline: reqOutline(record.outline, 'outline', islandWhere),
        noiseMeters: reqNonNegative(record.noiseMeters, 'noiseMeters', islandWhere),
        rockLayers,
        rimProps,
        debris
    };
}

export function validateSchool(raw: unknown): School {
    const where = 'data/school.json';
    const record = asRecord(raw, where);

    return {
        id: reqString(record.id, 'id', where),
        name: reqString(record.name, 'name', where),
        campusName: reqString(record.campusName, 'campusName', where),
        shortName: reqString(record.shortName, 'shortName', where),
        brandMark: reqString(record.brandMark, 'brandMark', where),
        title: reqString(record.title, 'title', where),
        subtitle: reqString(record.subtitle, 'subtitle', where),
        voxelMeters: reqPositive(record.voxelMeters, 'voxelMeters', where),
        gridPaddingMeters: reqNonNegative(record.gridPaddingMeters, 'gridPaddingMeters', where),
        defaultTerrainTypeKey: reqString(
            record.defaultTerrainTypeKey,
            'defaultTerrainTypeKey',
            where
        ),
        boundary: reqOutline(record.boundary, 'boundary', where),
        island: validateIsland(record.island, where),
        attribution: reqString(record.attribution, 'attribution', where),
        heightNote: reqString(record.heightNote, 'heightNote', where)
    };
}

/* ----------------------------------------------------------------
   类型字典
---------------------------------------------------------------- */

/** 体量做法参数：key 必须带 Meters 后缀、值必须为正（长度一律以米为单位） */
function optMassingParams(value: unknown, field: string, where: string): MassingParams | null {
    if (value === undefined || value === null) return null;

    const record = asRecord(value, `${where} 的 ${field}`);
    const params: MassingParams = {};
    for (const [key, raw] of Object.entries(record)) {
        if (!key.endsWith(METERS_SUFFIX)) {
            throw new DataError(
                `${where} 的 ${field}.${key} 缺少 ${METERS_SUFFIX} 后缀（长度参数一律以米为单位）`
            );
        }
        params[key] = reqPositive(raw, `${field}.${key}`, where);
    }

    if (Object.keys(params).length === 0) {
        throw new DataError(`${where} 的 ${field} 不能是空对象`);
    }
    return params;
}

export function validateBuildingTypeDictionary(
    raw: unknown,
    where = 'data/dictionaries/building-types.json'
): BuildingTypeDictionary {
    const record = asRecord(raw, where);
    const typesRecord = asRecord(record.types, `${where} 的 types`);

    const types: Record<string, BuildingTypeDef> = {};
    for (const [key, defRaw] of Object.entries(typesRecord)) {
        const defWhere = `${where} 的 types.${key}`;
        const def = asRecord(defRaw, defWhere);

        if (!isMassingKey(def.massing)) {
            throw new DataError(
                `${defWhere}.massing 不是合法的体量做法：${String(def.massing)}`
            );
        }

        types[key] = {
            label: reqString(def.label, 'label', defWhere),
            floors: reqPositive(def.floors, 'floors', defWhere),
            floorHeight: reqPositive(def.floorHeight, 'floorHeight', defWhere),
            massing: def.massing,
            paletteKey: reqString(def.paletteKey, 'paletteKey', defWhere),
            wallColor: optHexColor(def.wallColor, 'wallColor', defWhere),
            roofColor: optHexColor(def.roofColor, 'roofColor', defWhere),
            massingParams: optMassingParams(def.massingParams, 'massingParams', defWhere) ?? undefined
        };
    }

    if (Object.keys(types).length === 0) {
        throw new DataError(`${where} 的 types 不能为空`);
    }

    const defaultTypeKey = reqString(record.defaultTypeKey, 'defaultTypeKey', where);
    if (!types[defaultTypeKey]) {
        throw new DataError(`${where} 的 defaultTypeKey「${defaultTypeKey}」不在 types 里`);
    }

    if (!Array.isArray(record.nameRules)) {
        throw new DataError(`${where} 的 nameRules 必须是数组`);
    }
    const nameRules = record.nameRules.map((ruleRaw, index) => {
        const ruleWhere = `${where} 的 nameRules[${index}]`;
        const rule = asRecord(ruleRaw, ruleWhere);
        const type = reqString(rule.type, 'type', ruleWhere);
        if (!types[type]) {
            throw new DataError(`${ruleWhere}.type「${type}」不在 types 里`);
        }
        return { pattern: reqString(rule.pattern, 'pattern', ruleWhere), type };
    });

    const kindRulesRecord = asRecord(record.kindRules, `${where} 的 kindRules`);
    const kindRules: Record<string, string> = {};
    for (const [kind, raw] of Object.entries(kindRulesRecord)) {
        const type = reqString(raw, `kindRules.${kind}`, where);
        if (!types[type]) {
            throw new DataError(`${where} 的 kindRules.${kind}「${type}」不在 types 里`);
        }
        kindRules[kind] = type;
    }

    return {
        version: reqNumber(record.version, 'version', where),
        defaultTypeKey,
        types,
        nameRules,
        kindRules
    };
}

export function validateTerrainTypeDictionary(
    raw: unknown,
    where = 'data/dictionaries/terrain-types.json'
): TerrainTypeDictionary {
    const record = asRecord(raw, where);
    const typesRecord = asRecord(record.types, `${where} 的 types`);

    const types: Record<string, TerrainTypeDef> = {};
    for (const [key, defRaw] of Object.entries(typesRecord)) {
        const defWhere = `${where} 的 types.${key}`;
        const def = asRecord(defRaw, defWhere);

        if (!Array.isArray(def.paletteKeys) || def.paletteKeys.length === 0) {
            throw new DataError(`${defWhere}.paletteKeys 必须是非空数组`);
        }

        types[key] = {
            label: reqString(def.label, 'label', defWhere),
            order: reqNumber(def.order, 'order', defWhere),
            paletteKeys: def.paletteKeys.map((item, index) =>
                reqString(item, `paletteKeys[${index}]`, defWhere)
            ),
            canopy: reqBoolean(def.canopy, 'canopy', defWhere),
            groundCover: reqBoolean(def.groundCover, 'groundCover', defWhere),
            streetLamp: reqBoolean(def.streetLamp, 'streetLamp', defWhere),
            water: reqBoolean(def.water, 'water', defWhere)
        };
    }

    if (Object.keys(types).length === 0) {
        throw new DataError(`${where} 的 types 不能为空`);
    }

    return { version: reqNumber(record.version, 'version', where), types };
}

/* ----------------------------------------------------------------
   建筑与地皮条目（结构校验，不做类型推断与形制合成）
   —— 校验通过后可选字段已被补齐成确定的形状（null 表示「跟随类型字典」），
      因此这里返回的是 Validated* 而不是磁盘上的 Raw* 形状。
---------------------------------------------------------------- */

export interface ValidatedBuildingEntry {
    id: string;
    name: string;
    kind: string;
    source: DataSource;
    outline: LonLat[];
    typeKey: string | null;
    massing: MassingKey | null;
    floors: number | null;
    floorHeight: number | null;
    massingParams: MassingParams | null;
}

export interface ValidatedParcelEntry {
    id: string;
    name: string;
    typeKey: string;
    outline: LonLat[];
    source: DataSource;
}

export function validateBuildingEntries(raw: unknown): ValidatedBuildingEntry[] {
    const where = 'data/buildings.json';
    const seen = new Set<string>();

    return reqItems(raw, where).map((itemRaw, index) => {
        const itemWhere = `${where} 的 items[${index}]`;
        const item = asRecord(itemRaw, itemWhere);
        const id = reqString(item.id, 'id', itemWhere);

        if (seen.has(id)) {
            throw new DataError(`${where} 里 id 重复：${id}`);
        }
        seen.add(id);

        let massing = null;
        if (item.massing !== undefined && item.massing !== null) {
            if (!isMassingKey(item.massing)) {
                throw new DataError(`${where} 中建筑 ${id} 的 massing 不合法：${String(item.massing)}`);
            }
            massing = item.massing;
        }

        return {
            id,
            name: optString(item.name, 'name', `${where} 中建筑 ${id}`),
            kind: optString(item.kind, 'kind', `${where} 中建筑 ${id}`),
            source: item.source === 'manual' ? 'manual' : 'osm',
            outline: reqOutline(item.outline, 'outline', `${where} 中建筑 ${id}`),
            typeKey:
                item.typeKey === undefined || item.typeKey === null
                    ? null
                    : reqString(item.typeKey, 'typeKey', `${where} 中建筑 ${id}`),
            massing,
            floors: optPositive(item.floors, 'floors', `${where} 中建筑 ${id}`),
            floorHeight: optPositive(item.floorHeight, 'floorHeight', `${where} 中建筑 ${id}`),
            massingParams: optMassingParams(
                item.massingParams,
                'massingParams',
                `${where} 中建筑 ${id}`
            )
        };
    });
}

export function validateParcelEntries(raw: unknown): ValidatedParcelEntry[] {
    const where = 'data/parcels.json';
    const seen = new Set<string>();

    return reqItems(raw, where).map((itemRaw, index) => {
        const itemWhere = `${where} 的 items[${index}]`;
        const item = asRecord(itemRaw, itemWhere);
        const id = reqString(item.id, 'id', itemWhere);

        if (seen.has(id)) {
            throw new DataError(`${where} 里 id 重复：${id}`);
        }
        seen.add(id);

        return {
            id,
            name: optString(item.name, 'name', `${where} 中地皮 ${id}`),
            typeKey: reqString(item.typeKey, 'typeKey', `${where} 中地皮 ${id}`),
            outline: reqOutline(item.outline, 'outline', `${where} 中地皮 ${id}`),
            source: item.source === 'manual' ? 'manual' : 'osm'
        };
    });
}

/* ----------------------------------------------------------------
   元信息
---------------------------------------------------------------- */

export function validateManifest(raw: unknown): {
    version: string;
    updatedAt: string;
    sources: { name: string; license: string }[];
} {
    const where = 'data/manifest.json';
    const record = asRecord(raw, where);

    if (!Array.isArray(record.sources)) {
        throw new DataError(`${where} 的 sources 必须是数组`);
    }

    return {
        version: reqString(record.version, 'version', where),
        updatedAt: reqString(record.updatedAt, 'updatedAt', where),
        sources: record.sources.map((sourceRaw, index) => {
            const sourceWhere = `${where} 的 sources[${index}]`;
            const source = asRecord(sourceRaw, sourceWhere);
            return {
                name: reqString(source.name, 'name', sourceWhere),
                license: reqString(source.license, 'license', sourceWhere)
            };
        })
    };
}
