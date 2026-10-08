import { create } from 'zustand';
import type { MapDataset } from '../contract';
import { loadMapDataset } from '../services/mapService';
import type { BuildingRuntime, RenderWarning, WorldStats } from '../types/world';

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/** 渲染层建完世界后回填的结果（UI 只读这份轻量快照） */
export interface WorldResult {
    stats: WorldStats;
    warnings: RenderWarning[];
    buildingRuntime: Record<string, BuildingRuntime>;
}

interface MapState {
    dataset: MapDataset | null;
    status: LoadStatus;
    error: string | null;
    /** 世界构建结果，未构建完成时为 null */
    world: WorldResult | null;
    load: () => Promise<void>;
    setWorld: (result: WorldResult) => void;
}

export const useMapStore = create<MapState>((set) => ({
    dataset: null,
    status: 'idle',
    error: null,
    world: null,

    async load() {
        set({ status: 'loading', error: null });
        try {
            const dataset = await loadMapDataset();
            set({ dataset, status: 'ready' });
        } catch (error) {
            /* 不兜底：把可定位的失败原因交给错误遮罩展示 */
            set({
                dataset: null,
                status: 'error',
                error: error instanceof Error ? error.message : String(error)
            });
        }
    },

    setWorld(result) {
        set({ world: result });
    }
}));
