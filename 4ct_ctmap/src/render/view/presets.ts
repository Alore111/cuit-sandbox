/* ================================================================
   预设机位
   —— 四个固定机位，按钮触发后由 view/focus 的补间平滑推过去（不是自动巡游）。

   尺度一律相对「岛体取景对角线」（平面跨度 + 倒锥深度）与倒锥深度，
   换学校、改分辨率、调倒锥深浅都不用动这里的数字。

   【口径】「全景」就是首次进入时的机位，stage 的 home 直接取它，
   因此预设与默认机位永远一致，不会出现「按了全景却回不到初始构图」。
================================================================ */

import * as THREE from 'three';
import type { ViewPresetName } from '../../types/view';

export interface ViewPose {
    position: THREE.Vector3;
    target: THREE.Vector3;
}

export interface ViewPresetInput {
    center: { x: number; z: number };
    /** 岛体取景对角线（含倒锥深度） */
    diagonal: number;
    islandDepth: number;
}

interface PresetPose {
    azimuth: number;
    elevation: number;
    /** 距离 = 对角线 × 该系数 */
    distanceFactor: number;
    /** 注视点高度 = -倒锥深度 × 该比例（0.5 = 岛体竖向中段，0 = 岛面） */
    targetDepthRatio: number;
    /** 在比例之上再抬高的格数（贴地机位要看街景，不能盯着岛底） */
    targetLiftCells: number;
}

const PRESET_POSE: Record<ViewPresetName, PresetPose> = {
    /* 全景：斜俯瞰全局 */
    overview: { azimuth: 0.62, elevation: 0.55, distanceFactor: 1.02, targetDepthRatio: 0.5, targetLiftCells: 0 },
    /* 俯瞰：接近正上方，看布局 */
    top: { azimuth: 0.62, elevation: 1.42, distanceFactor: 1.3, targetDepthRatio: 0.5, targetLiftCells: 0 },
    /* 环岛：低仰角环视，看倒锥与岛缘装饰 */
    orbit: { azimuth: 1.97, elevation: 0.1, distanceFactor: 1.2, targetDepthRatio: 0.35, targetLiftCells: 0 },
    /* 贴地：贴近岛面，街景高度（机位必须落在岛面之内，否则会退化成远眺）。
       仰角取最低的 5°，与 stage 的极角钳制口径一致，不允许从岛底下往上看。 */
    ground: { azimuth: 0.07, elevation: 5 * Math.PI / 180, distanceFactor: 0.16, targetDepthRatio: 0, targetLiftCells: 4 }
};

/** stage 的默认机位就是「全景」 */
export const HOME_PRESET: ViewPresetName = 'overview';

export function createViewPresets(input: ViewPresetInput): Record<ViewPresetName, ViewPose> {
    const { center, diagonal, islandDepth } = input;
    const names = Object.keys(PRESET_POSE) as ViewPresetName[];
    const poses = {} as Record<ViewPresetName, ViewPose>;

    for (const name of names) {
        const pose = PRESET_POSE[name];
        const distance = diagonal * pose.distanceFactor;
        const target = new THREE.Vector3(
            center.x,
            -islandDepth * pose.targetDepthRatio + pose.targetLiftCells,
            center.z
        );

        poses[name] = {
            target,
            position: new THREE.Vector3(
                target.x + distance * Math.cos(pose.elevation) * Math.sin(pose.azimuth),
                target.y + distance * Math.sin(pose.elevation),
                target.z + distance * Math.cos(pose.elevation) * Math.cos(pose.azimuth)
            )
        };
    }

    return poses;
}
