import { create } from 'zustand';
import type { LonLat } from '../contract';
import { useCampusLiveStore } from './campusLiveStore';
import { mapBeacons } from '../render/beaconManager';

/**
 * 统一地图定位（信标 + 铭牌 + 导航）
 * —— 搜索结果点击、外部跳转定位等场景共用同一入口。
 *
 * 参数（与搜索接口返回结构对齐）：
 *   · kind: 'place' | 'event'（地点 / 事件）
 *   · position: 经纬度 [lat, lon]
 *   · eventId / buildingId：二选一
 *   · name: 铭牌标题（事件可省略，用事件标题）
 *
 * 行为差异：
 *   · place：在地图上加信标 + 无背景描边铭牌（不承载点击）+ 相机导航
 *   · event：打开事件详情抽屉（详情自带信标 + 导航 + 事件铭牌）
 */
export interface LocateTarget {
    kind: 'place' | 'event';
    /** 经纬度 [lat, lon]，wgs84 */
    position?: LonLat;
    eventId?: string;
    buildingId?: string;
    /** 铭牌标题（事件可省略） */
    name?: string;
}

interface LocateState {
    /** 当前定位目标；place 类型由 LocateMarkerLayer 渲染铭牌 */
    target: LocateTarget | null;
    /** 自定义信标 ID（beaconManager.add 返回），clear 时移除 */
    beaconId: string | null;
    /** 统一入口 */
    locate: (target: LocateTarget) => void;
    /** 清除定位：移除信标 + 清目标 */
    clearLocate: () => void;
}

/** 移除自定义信标（场景未就绪时静默忽略） */
function removeBeacon(id: string | null): void {
    if (!id) return;
    try {
        mapBeacons.remove(id, false);
    } catch {
        /* 场景未就绪等情形：直接忽略，下次 attach 时不会重建 */
    }
}

export const useLocateStore = create<LocateState>((set, get) => ({
    target: null,
    beaconId: null,

    locate: (target) => {
        /* 事件类型：复用详情链路（详情抽屉 + 信标 + 导航） */
        if (target.kind === 'event' && target.eventId) {
            removeBeacon(get().beaconId);
            useCampusLiveStore.getState().openDetail(target.eventId);
            set({ target, beaconId: null });
            return;
        }

        /* 地点类型：加信标（含相机导航）+ 记录目标供铭牌渲染 */
        const prevBeacon = get().beaconId;
        let beaconId: string | null = null;
        if (target.position) {
            try {
                beaconId = mapBeacons.add(
                    [target.position[0], target.position[1]],
                    'wgs84',
                    true // 移动视角到信标
                );
            } catch {
                /* 场景未就绪：信标留空，铭牌仍可渲染 */
            }
        }
        removeBeacon(prevBeacon);
        set({ target, beaconId });
    },

    clearLocate: () => {
        removeBeacon(get().beaconId);
        set({ target: null, beaconId: null });
    },
}));