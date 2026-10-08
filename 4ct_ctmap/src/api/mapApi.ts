import type {
    Building,
    Dictionaries,
    Manifest,
    Parcel,
    RawBuildingEntry,
    RawBuildingTypeDictionary,
    RawItemsFile,
    RawParcelEntry,
    School
} from '../contract';
import { request } from './client';

/** 路由前缀：前端只写相对路径，端口与域名只在 vite 代理里出现一次 */
export const MAP_API_PREFIX = '/api/map';

/** 地点词典单条规则（与 Node server/src/utils/places.ts 的 PlaceRule 对齐） */
export interface PlaceRule {
    name: string;
    /** 命中任一才候选；至少得有一个。支持普通词与 "/.../" 正则项 */
    mustInclude: string[];
    /** 命中任一即排除；支持普通词与 "/.../" 正则项 */
    mustExclude?: string[];
    /** 额外加分词；支持普通词与 "/.../" 正则项 */
    keywords?: string[];
    /** 地点权重（加分系数），默认 1 */
    weight?: number;
    /** 关联建筑 ID（可多选） */
    buildingIds?: string[];
    /** 关联地皮 ID（可多选，如 p-hw-543937595） */
    parcelIds?: string[];
    /** 该地点自身的 WGS-84 坐标 [纬度, 经度]（可省略，缺省时取关联建筑/地皮中心） */
    position?: [number, number];
    /** 命中后作为 locationId 使用；缺省用 name */
    locationId?: string;
}

/** places.json 整份文档 */
export interface PlacesFile {
    version: number;
    places: PlaceRule[];
}

/** API 层：只定义端点与返回类型，不做任何编排与缓存 */
export const mapApi = {
    fetchSchool: () => request<School>(`${MAP_API_PREFIX}/school`),
    fetchDictionaries: () => request<Dictionaries>(`${MAP_API_PREFIX}/dictionaries`),
    fetchBuildings: () => request<Building[]>(`${MAP_API_PREFIX}/buildings`),
    fetchParcels: () => request<Parcel[]>(`${MAP_API_PREFIX}/parcels`),
    fetchManifest: () => request<Manifest>(`${MAP_API_PREFIX}/manifest`),

    /** 编辑登录检测：向后端校验管理员密钥（仅鉴权，不修改数据）。密钥错误会抛 401 */
    checkAdminAuth: () =>
        request<{ enabled: boolean; hasKey: boolean }>(`${MAP_API_PREFIX}/auth-check`),

    /** 编辑器：取磁盘上的原始条目（保留「未覆盖」语义与未识别字段） */
    fetchRawSchool: () => request<School>(`${MAP_API_PREFIX}/raw/school`),
    fetchRawBuildings: () =>
        request<RawItemsFile<RawBuildingEntry>>(`${MAP_API_PREFIX}/raw/buildings`),
    fetchRawParcels: () => request<RawItemsFile<RawParcelEntry>>(`${MAP_API_PREFIX}/raw/parcels`),
    /** 端点名是 raw 白名单里的 dictionaries，但只有建筑类型字典一份（地皮类型不在编辑范围） */
    fetchRawBuildingTypes: () =>
        request<RawBuildingTypeDictionary>(`${MAP_API_PREFIX}/raw/dictionaries`),

    /** 编辑器：整份覆盖写回（后端先校验，失败即拒绝且不写盘） */
    saveBuildings: (file: RawItemsFile<RawBuildingEntry>) =>
        request<{ saved: number }>(`${MAP_API_PREFIX}/buildings`, {
            method: 'PUT',
            body: JSON.stringify(file)
        }),
    saveParcels: (file: RawItemsFile<RawParcelEntry>) =>
        request<{ saved: number }>(`${MAP_API_PREFIX}/parcels`, {
            method: 'PUT',
            body: JSON.stringify(file)
        }),
    /** school.json 是单份文档，返回值是写盘确认过的岛面轮廓点数 */
    saveSchool: (school: School) =>
        request<{ saved: number }>(`${MAP_API_PREFIX}/school`, {
            method: 'PUT',
            body: JSON.stringify(school)
        }),
    /** 建筑类型字典：返回值是写盘确认过的类型数 */
    saveBuildingTypes: (file: RawBuildingTypeDictionary) =>
        request<{ saved: number }>(`${MAP_API_PREFIX}/dictionaries`, {
            method: 'PUT',
            body: JSON.stringify(file)
        }),

    /** 地点词典：地理位置匹配面板读写 places.json */
    fetchPlaces: () => request<PlacesFile>(`${MAP_API_PREFIX}/places`),
    savePlaces: (file: PlacesFile) =>
        request<{ saved: number }>(`${MAP_API_PREFIX}/places`, {
            method: 'PUT',
            body: JSON.stringify(file)
        })
};
