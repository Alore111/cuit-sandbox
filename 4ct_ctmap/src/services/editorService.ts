/* ================================================================
   服务层：编辑器的取数与写回
   —— 界面层只认这里的 EditorSource / saveEditorDocument，不直接接触端点。
      保存的口径在**一处**收口：哪几份文件要写、按什么顺序、失败时怎么表现，
      都在这里，EditorApp 只负责在成功后重新读取数据。
================================================================ */

import type {
    Dictionaries,
    RawBuildingEntry,
    RawBuildingTypeDictionary,
    RawItemsFile,
    RawParcelEntry,
    School
} from '../contract';
import { mapApi } from '../api/mapApi';

/**
 * 编辑器持有的文档
 * —— 四份**磁盘上的原始形状**，也是撤销栈的快照单位。
 *    school 是单份文档（编辑器只把它的 island.outline 开给用户改），
 *    buildings / parcels 是条目数组，buildingTypes 是建筑类型字典
 *    （编辑器只开各类型的 wallColor / roofColor 给用户改）。
 *    它由服务层装载与写回，所以定义放在这里 —— 编辑器各组件 import 它，
 *    依赖方向仍然是 ui → services。
 */
export interface EditorDocument {
    school: School;
    buildings: RawBuildingEntry[];
    parcels: RawParcelEntry[];
    buildingTypes: RawBuildingTypeDictionary;
}

/**
 * 脏标记：逐文件跟踪。
 * 四份文件互不牵连，保存时只写真正改过的那几份，不会因为改了一个顶点
 * 就把另三份也重写一遍。
 */
export interface DirtyFlags {
    buildings: boolean;
    parcels: boolean;
    island: boolean;
    buildingTypes: boolean;
}

export const CLEAN_FLAGS: DirtyFlags = {
    buildings: false,
    parcels: false,
    island: false,
    buildingTypes: false
};

export interface EditorSource {
    /** 四份磁盘上的原始文档（编辑器持有它们直到保存或放弃） */
    document: EditorDocument;
    /** 类型字典：只读，表单里的下拉项与配色的回落值都来自这里 */
    dictionaries: Dictionaries;
    /** 条数外壳的版本号：整份覆盖时要原样写回，不能丢 */
    versions: { buildings: number; parcels: number };
}

export async function loadEditorSource(): Promise<EditorSource> {
    const [school, dictionaries, buildings, parcels, buildingTypes] = await Promise.all([
        mapApi.fetchRawSchool(),
        mapApi.fetchDictionaries(),
        mapApi.fetchRawBuildings(),
        mapApi.fetchRawParcels(),
        mapApi.fetchRawBuildingTypes()
    ]);

    return {
        document: {
            school,
            buildings: buildings.items,
            parcels: parcels.items,
            buildingTypes
        },
        dictionaries,
        versions: { buildings: buildings.version, parcels: parcels.version }
    };
}

export interface SaveOptions {
    document: EditorDocument;
    versions: EditorSource['versions'];
    dirty: DirtyFlags;
}

/** 保存结果的逐文件说明，例如 ["建筑 3 条", "岛面轮廓 230 点"] */
export interface SaveResult {
    parts: string[];
}

/**
 * 逐份覆盖写回。
 * —— 【口径】后端**先校验后写盘**，失败即拒绝且磁盘不变；这里不做任何部分成功后的补偿，
 *    因为每份文件本身的写入是原子的，最坏情况只是「前一份写成了、后一份被拒」，
 *    界面会如实报错，用户重试即可（.bak 也在）。
 */
export async function saveEditorDocument(options: SaveOptions): Promise<SaveResult> {
    const { document, versions, dirty } = options;
    const parts: string[] = [];

    if (dirty.buildings) {
        const file: RawItemsFile<RawBuildingEntry> = {
            version: versions.buildings,
            items: document.buildings
        };
        const result = await mapApi.saveBuildings(file);
        parts.push(`建筑 ${result.saved} 条`);
    }

    if (dirty.parcels) {
        const file: RawItemsFile<RawParcelEntry> = {
            version: versions.parcels,
            items: document.parcels
        };
        const result = await mapApi.saveParcels(file);
        parts.push(`地皮 ${result.saved} 条`);
    }

    if (dirty.island) {
        const result = await mapApi.saveSchool(document.school);
        parts.push(`岛面轮廓 ${result.saved} 点`);
    }

    /* 类型字典是整份文档（不是 { version, items } 外壳），版本号在文档里，不需要另带 */
    if (dirty.buildingTypes) {
        const result = await mapApi.saveBuildingTypes(document.buildingTypes);
        parts.push(`建筑类型 ${result.saved} 个`);
    }

    return { parts };
}
