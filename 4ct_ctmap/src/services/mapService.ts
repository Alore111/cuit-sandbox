import type { MapDataset } from '../contract';
import { mapApi } from '../api/mapApi';

/** 本地静态 JSON fallback 路径（与后端 data/*.json 保持一致） */
const FALLBACK = {
    school: '/data/school.json',
    dictionaries: '/data/dictionaries',
    buildings: '/data/buildings.json',
    parcels: '/data/parcels.json',
    manifest: '/data/manifest.json',
} as const;

/**
 * 一个请求优先走真实 API，失败再降级到 public/data 下的静态 JSON。
 * dictionaries 需要组合 building-types + terrain-types，因此单独处理。
 */
async function fetchWithFallback<T>(name: keyof typeof FALLBACK, apiFn: () => Promise<T>): Promise<T> {
    try {
        return await apiFn();
    } catch (err) {
        console.warn(`[mapService] ${name} API 失败，降级到静态 JSON：`, err);
        const path = FALLBACK[name];
        if (name === 'dictionaries') {
            const [b, t] = await Promise.all([
                fetch('/data/dictionaries/building-types.json').then((r) => r.json()),
                fetch('/data/dictionaries/terrain-types.json').then((r) => r.json()),
            ]);
            return { buildings: b, terrain: t } as T;
        }
        return fetch(path).then((r) => r.json()) as Promise<T>;
    }
}

/**
 * 服务层：把「数据集由 5 个读接口组成」这件事收在这里，
 * 状态层与界面层只认一份 MapDataset，不需要知道端点的存在。
 */
export async function loadMapDataset(): Promise<MapDataset> {
    const [school, dictionaries, buildings, parcels, manifest] = await Promise.all([
        fetchWithFallback('school', () => mapApi.fetchSchool()),
        fetchWithFallback('dictionaries', () => mapApi.fetchDictionaries()),
        fetchWithFallback('buildings', () => mapApi.fetchBuildings()),
        fetchWithFallback('parcels', () => mapApi.fetchParcels()),
        fetchWithFallback('manifest', () => mapApi.fetchManifest()),
    ]);

    return { school, dictionaries, buildings, parcels, manifest };
}
