/* ================================================================
   信标管理器（BeaconManager）
   —— 把「自定义信标」暴露成 window.mapBeacons，供宿主页面/控制台按 ID 增删移：
       · add(position, coordSystem='wgs84', moveCamera=true) → 新信标 ID
       · move(id, position, coordSystem='wgs84', moveCamera=true) → 移动后的经纬度
       · remove(id, moveCameraToGlobal=true) → 是否移除成功
   —— 与「事件详情锚点信标」独立：这里的信标由用户 API 完全掌控，
       事件详情信标仍由 useMapScene 内部的 detailEventId effect 驱动。

   坐标体系：内部一律按 wgs84 存储与换算（与 Node 端事件坐标同口径）；
   入参支持 gcj02（高德）自动转 wgs84，move 的返回值为入参同名坐标系。

   生命周期约定：
       · useMapScene 建好场景后调 attach(...)，清理时调 detach()；
       · attach 时用「上次保留的经纬度数据」重建全部自定义信标（StrictMode remount 也不丢）；
       · 每帧主循环里调 update(dt)；主题切换调 applyTheme(theme)。

   场景未就绪时调用 add/move 会抛错 —— 不静默兜底。
================================================================ */

import * as THREE from 'three';
import { Beacon } from './beacon';
import type { LonLat } from '../contract';
import type { GridSystem } from '../utils/geo';
import type { FocusController } from './view/focus';
import type { CoordinateSystem } from '../utils/coordTransform';
import { normalizeToWgs84, denormalizeLonLat } from '../utils/coordTransform';
import { useUiStore } from '../store/uiStore';

/** 场景就绪后，管理器需要的最小句柄（useMapScene 提供） */
export interface BeaconManagerScene {
    grid: GridSystem;
    /** 3D 场景（信标 group 挂这里） */
    scene: THREE.Scene;
    focus: FocusController;
}

interface BeaconEntry {
    lonLat: LonLat;
    beacon: Beacon | null;
}

/* ---------------- 模块级状态 ---------------- */

let attachedScene: BeaconManagerScene | null = null;
let reducedMotion = false;
/** id → 信标（含经纬度数据；attach 时若 beacon 为空会重建） */
const entries = new Map<string, BeaconEntry>();
let nextId = 1;

/* ---------------- 内部工具 ---------------- */

/** 经纬度 → 世界坐标（与事件铭牌投影同一套换算；y 贴近地表） */
function lonLatToPoint(scene: BeaconManagerScene, lonLat: LonLat): THREE.Vector3 {
    const { vx, vz } = scene.grid.lonLatToVoxel(lonLat[0], lonLat[1]);
    const world = scene.grid.voxelToWorld(vx, vz);
    return new THREE.Vector3(world.x, 1.1, world.z);
}

/** 把镜头聚焦到锚点（取景距离 = 网格对角线 × 系数，与事件聚焦同口径） */
function focusOnPoint(scene: BeaconManagerScene, point: THREE.Vector3): void {
    const diagonal = Math.hypot(scene.grid.size.x, scene.grid.size.z);
    scene.focus.focusOnPoint(point, Math.max(diagonal * 0.3, 60));
}

/** 按当前主题建一个信标实例并摆到经纬度位置（不加入场景，由调用方 add） */
function spawnBeacon(lonLat: LonLat): Beacon {
    const theme = useUiStore.getState().theme;
    const world = attachedScene ? lonLatToPoint(attachedScene, lonLat) : null;
    const beacon = new Beacon({
        position: world ? { x: world.x, z: world.z } : { x: 0, z: 0 },
        theme,
        reducedMotion,
    });
    beacon.setVisible(true);
    return beacon;
}

function requireScene(): BeaconManagerScene {
    if (!attachedScene) {
        throw new Error('地图场景未就绪：请先完成 3D 地图初始化，再调用信标 API');
    }
    return attachedScene;
}

/* ---------------- 对外：场景生命周期（useMapScene 调用） ---------------- */

/** 场景就绪 → 挂接句柄，并按保留的经纬度数据重建全部自定义信标 */
export function attachBeaconManager(scene: BeaconManagerScene, prefersReducedMotion: boolean): void {
    reducedMotion = prefersReducedMotion;
    attachedScene = scene;

    for (const entry of entries.values()) {
        if (entry.beacon) continue;
        const beacon = spawnBeacon(entry.lonLat);
        entry.beacon = beacon;
        scene.scene.add(beacon.group);
    }
}

/** 场景销毁 → 摘掉句柄，重建数据（经纬度）保留，下次 attach 再长出来 */
export function detachBeaconManager(): void {
    if (!attachedScene) return;
    for (const [, entry] of entries) {
        if (!entry.beacon) continue;
        attachedScene.scene.remove(entry.beacon.group);
        entry.beacon.dispose();
        entry.beacon = null;
    }
    attachedScene = null;
}

/** 每帧驱动所有信标的动效（主循环调用） */
export function updateBeacons(dt: number): void {
    for (const entry of entries.values()) {
        entry.beacon?.update(dt);
    }
}

/** 主题切换：透传给所有信标 */
export function applyBeaconTheme(theme: Parameters<Beacon['applyTheme']>[0]): void {
    for (const [, entry] of entries) {
        entry.beacon?.applyTheme(theme);
    }
}

/* ---------------- 对外：window API ---------------- */

/**
 * window.mapBeacons
 *   添加新信标：add([纬度, 经度], 坐标系='wgs84', 是否移动视角=true) → 新信标 ID
 *   移动信标：  move(ID, [纬度, 经度], 坐标系='wgs84', 是否移动视角=true) → 移动后的经纬度
 *   移除信标：  remove(ID, 是否移动视角至全局=true) → 移除成功与否
 *   经纬度与事件坐标同口径：[纬度, 经度]。
 *   坐标系：'wgs84'（默认，GPS/Node 原生）或 'gcj02'（高德/腾讯地图，自动转 wgs84 后定位）。
 */
export const mapBeacons = {
    add(lonLat: LonLat, coordSystem: CoordinateSystem = 'wgs84', moveCamera = true): string | never {
        const scene = requireScene();
        const id = `beacon-${nextId++}`;

        // 统一规整为 wgs84 内部存储；快照复制，避免外部改入参数组影响内部状态
        const wgs84 = normalizeToWgs84([lonLat[0], lonLat[1]], coordSystem);
        const entry: BeaconEntry = { lonLat: wgs84, beacon: null };
        entries.set(id, entry);

        const beacon = spawnBeacon(entry.lonLat);
        entry.beacon = beacon;
        scene.scene.add(beacon.group);

        if (moveCamera) focusOnPoint(scene, lonLatToPoint(scene, entry.lonLat));
        return id;
    },

    move(id: string, lonLat: LonLat, coordSystem: CoordinateSystem = 'wgs84', moveCamera = true): LonLat | never {
        const scene = requireScene();
        const entry = entries.get(id);
        if (!entry) {
            throw new Error(`信标不存在：${id}`);
        }

        const next: LonLat = normalizeToWgs84([lonLat[0], lonLat[1]], coordSystem);
        entry.lonLat = next;

        const beacon = entry.beacon;
        if (beacon) {
            const point = lonLatToPoint(scene, next);
            beacon.setPosition(point.x, point.z);
        }
        if (moveCamera) focusOnPoint(scene, lonLatToPoint(scene, next));
        // 返回值与入参同一坐标系（wgs84 直接用，gcj02 转回高德）
        return denormalizeLonLat(next, coordSystem);
    },

    remove(id: string, moveCameraToGlobal = true): boolean {
        const entry = entries.get(id);
        if (!entry) return false;

        entries.delete(id);
        const scene = attachedScene;
        if (scene && entry.beacon) {
            scene.scene.remove(entry.beacon.group);
            entry.beacon.dispose();
        }

        if (moveCameraToGlobal) scene?.focus.reset();
        return true;
    },
};

/* ---------------- 挂到 window ---------------- */

declare global {
    interface Window {
        mapBeacons: typeof mapBeacons;
    }
}

if (typeof window !== 'undefined') {
    window.mapBeacons = mapBeacons;
}