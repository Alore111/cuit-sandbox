/* ================================================================
   数据集装配
   —— 读 JSON → 校验 → 把「类型经验值 / 逐栋覆盖」合成到每条建筑上 → 排序。
   完成后前端拿到的是可直接渲染的完整对象，类型推断与形制合成都不在浏览器里做。
================================================================ */

import { polygonAreaM2 } from '../contract';
import type {
    Building,
    BuildingTypeDef,
    BuildingTypeDictionary,
    Dictionaries,
    MapDataset,
    MassingParams,
    Parcel,
    School
} from '../contract';

import { DataError } from '../errors';
import {
    validateBuildingEntries,
    validateBuildingTypeDictionary,
    validateManifest,
    validateParcelEntries,
    validateSchool,
    validateTerrainTypeDictionary,
    type ValidatedBuildingEntry,
    type ValidatedParcelEntry
} from '../validate/mapData';
import { readDataJson } from './jsonStore';

/* ----------------------------------------------------------------
   建筑：类型推断 + 形制合成
---------------------------------------------------------------- */

interface CompiledRule {
    pattern: RegExp;
    type: string;
}

/** 规则数固定，编译一次复用，避免逐条建筑重复编译正则 */
function compileNameRules(dict: BuildingTypeDictionary): CompiledRule[] {
    return dict.nameRules.map((rule) => ({ pattern: new RegExp(rule.pattern), type: rule.type }));
}

/**
 * 由名称与 OSM 标签推断建筑类型。
 * 名称优先：校园建筑的名称（"第二教学楼""19栋宿舍"）比 building=yes/university 这类粗标签信息量大得多。
 */
function inferTypeKey(
    entry: ValidatedBuildingEntry,
    dict: BuildingTypeDictionary,
    rules: CompiledRule[]
): string {
    for (const rule of rules) {
        if (rule.pattern.test(entry.name)) return rule.type;
    }
    const byKind = entry.kind ? dict.kindRules[entry.kind] : undefined;
    return byKind ?? dict.defaultTypeKey;
}

/** 覆盖优先于类型经验值；覆盖了哪些字段如实记下，供详情卡标注来源 */
const OVERRIDABLE_FIELDS = ['typeKey', 'massing', 'floors', 'floorHeight', 'massingParams'] as const;

function resolveBuilding(
    entry: ValidatedBuildingEntry,
    dict: BuildingTypeDictionary,
    rules: CompiledRule[],
    voxelMeters: number
): Building {
    const typeKey = entry.typeKey ?? inferTypeKey(entry, dict, rules);
    const type: BuildingTypeDef | undefined = dict.types[typeKey];

    if (!type) {
        throw new DataError(
            `data/buildings.json 中建筑 ${entry.id} 的 typeKey「${typeKey}」不在 building-types.json 的 types 里`
        );
    }

    const floors = entry.floors ?? type.floors;
    const floorHeight = entry.floorHeight ?? type.floorHeight;
    const massing = entry.massing ?? type.massing;
    /* 逐栋参数整体替换类型参数（不做键级合并），语义唯一、不会出现半覆盖的中间态 */
    const massingParams: MassingParams = entry.massingParams ?? type.massingParams ?? {};
    const heightMeters = floors * floorHeight;

    const overriddenFields: string[] = OVERRIDABLE_FIELDS.filter(
        (field) => entry[field] !== undefined && entry[field] !== null
    );

    return {
        id: entry.id,
        name: entry.name,
        kind: entry.kind,
        source: entry.source,
        outline: entry.outline,
        areaM2: polygonAreaM2(entry.outline),
        typeKey,
        typeLabel: type.label,
        paletteKey: type.paletteKey,
        /* 主色调是**类型级**参数，不参与逐栋覆盖：同一类型的楼颜色一致 */
        wallColor: type.wallColor ?? null,
        roofColor: type.roofColor ?? null,
        massing,
        floors,
        floorHeight,
        heightMeters,
        /* 后端只做单位换算，不加任何形制约束（层数下限是渲染层的规则） */
        heightVoxels: Math.round(heightMeters / voxelMeters),
        massingParams,
        overriddenFields
    };
}

function resolveParcel(
    entry: ValidatedParcelEntry,
    terrainTypes: Record<string, unknown>
): Parcel {
    if (!terrainTypes[entry.typeKey]) {
        throw new DataError(
            `data/parcels.json 中地皮 ${entry.id} 的 typeKey「${entry.typeKey}」不在 terrain-types.json 的 types 里`
        );
    }

    return {
        id: entry.id,
        name: entry.name,
        typeKey: entry.typeKey,
        outline: entry.outline,
        source: entry.source,
        areaM2: polygonAreaM2(entry.outline)
    };
}

/* ----------------------------------------------------------------
   装配
---------------------------------------------------------------- */

/**
 * defaultTerrainTypeKey 必须落在 terrain 字典里，否则岛面内未被地皮覆盖的格子
 * 无地皮类型可铺。读路径与写路径共用这一条，避免两处口径分叉。
 */
function assertDefaultTerrainTypeKey(
    school: School,
    terrainTypes: Record<string, unknown>
): void {
    if (!terrainTypes[school.defaultTerrainTypeKey]) {
        throw new DataError(
            `data/school.json 的 defaultTerrainTypeKey「${school.defaultTerrainTypeKey}」不在 terrain-types.json 的 types 里`
        );
    }
}

/**
 * 装出整份数据集。
 * 每次请求都会走一遍（JSON 解析由 jsonStore 按 mtime 缓存，这里只剩纯计算，量级在毫秒以下），
 * 因此改完 JSON 刷新页面即可生效，不需要重启服务。
 */
export async function loadMapDataset(): Promise<MapDataset> {
    const [schoolRaw, buildingDictRaw, terrainDictRaw, buildingsRaw, parcelsRaw, manifestRaw] =
        await Promise.all([
            readDataJson('school.json'),
            readDataJson('dictionaries/building-types.json'),
            readDataJson('dictionaries/terrain-types.json'),
            readDataJson('buildings.json'),
            readDataJson('parcels.json'),
            readDataJson('manifest.json')
        ]);

    const school: School = validateSchool(schoolRaw);
    const buildingDict = validateBuildingTypeDictionary(buildingDictRaw);
    const terrainDict = validateTerrainTypeDictionary(terrainDictRaw);
    const manifest = validateManifest(manifestRaw);

    assertDefaultTerrainTypeKey(school, terrainDict.types);

    const rules = compileNameRules(buildingDict);

    const buildings = validateBuildingEntries(buildingsRaw)
        .map((entry) => resolveBuilding(entry, buildingDict, rules, school.voxelMeters))
        /* 占地大的排前面：名录按占地排序，地皮按面积降序盖章（大盖小） */
        .sort((a, b) => b.areaM2 - a.areaM2);

    const parcels = validateParcelEntries(parcelsRaw)
        .map((entry) => resolveParcel(entry, terrainDict.types))
        .sort((a, b) => b.areaM2 - a.areaM2);

    const dictionaries: Dictionaries = { buildings: buildingDict, terrain: terrainDict };

    return { school, dictionaries, buildings, parcels, manifest };
}

/* ----------------------------------------------------------------
   写接口用：先过「装得出来吗」这一关，再落盘
   —— 结构与取值校验 + 类型推断 + 形制合成各跑一遍。
      走的是与 loadMapDataset 完全相同的代码路径，因此写盘通过 == 下次一定能读出来。
---------------------------------------------------------------- */

export function assertBuildingsWritable(raw: unknown, dataset: MapDataset): number {
    const dict = dataset.dictionaries.buildings;
    const rules = compileNameRules(dict);
    const entries = validateBuildingEntries(raw);

    for (const entry of entries) {
        resolveBuilding(entry, dict, rules, dataset.school.voxelMeters);
    }
    return entries.length;
}

export function assertParcelsWritable(raw: unknown, dataset: MapDataset): number {
    const entries = validateParcelEntries(raw);

    for (const entry of entries) {
        resolveParcel(entry, dataset.dictionaries.terrain.types);
    }
    return entries.length;
}

/**
 * school.json 是**单份文档**（不是 { version, items } 集合），因此返回值不是「条数」，
 * 而是本次写盘确认过的**岛面轮廓点数** —— 编辑器只开 outline 给用户改，
 * 这个数就是用户最关心的那个「改动落实了吗」的凭据。
 */
export function assertSchoolWritable(raw: unknown, dataset: MapDataset): number {
    const school = validateSchool(raw);
    assertDefaultTerrainTypeKey(school, dataset.dictionaries.terrain.types);
    return school.island.outline.length;
}

/**
 * 类型字典的写前校验，返回值是类型数。
 * —— 类型字典不只是一份配置：每栋楼的类型推断与形制合成都依赖它。因此除了结构校验，
 *    还要拿**磁盘上的 buildings.json** 在新字典下完整跑一遍合成 ——
 *    删掉一个仍被引用的类型、或把 massing 改坏，都会在这一步被拦住，
 *    「写盘通过」因此仍然等价于「下次一定读得出来」。
 */
export async function assertDictionariesWritable(
    raw: unknown,
    dataset: MapDataset
): Promise<number> {
    const dict = validateBuildingTypeDictionary(raw);
    const rules = compileNameRules(dict);
    const buildingsRaw = await readDataJson<unknown>('buildings.json');

    for (const entry of validateBuildingEntries(buildingsRaw)) {
        resolveBuilding(entry, dict, rules, dataset.school.voxelMeters);
    }
    return Object.keys(dict.types).length;
}
