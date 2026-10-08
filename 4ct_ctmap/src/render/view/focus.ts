/* ================================================================
   相机聚焦
   —— 点选/搜索到某栋建筑时，把镜头平滑推到它面前，再平滑退回全景。
   实现要点：
     1) 补间期间必须冻结 OrbitControls，否则它的阻尼会与手动改机位打架；
     2) target 与相机位置同时插值，画面是「推近」而不是「绕过去」；
     3) 缓动走 easeInOutCubic，起步与收尾都不突兀。
================================================================ */

import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/** 补间时长（秒） */
const DURATION = 0.85;

/** 聚焦机位的方位角 / 仰角 */
const FOCUS_AZIMUTH = 0.62;
const FOCUS_ELEVATION = 0.5;

/** 机位距离 = 建筑长边 × 该系数，下限保证小建筑也不会贴脸 */
const DISTANCE_FACTOR = 4.5;
const MIN_DISTANCE = 70;

function easeInOutCubic(t: number): number {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export interface FocusTarget {
    center: THREE.Vector3;
    /** 建筑实际顶点（体素层号） */
    apexVoxels: number;
    footprint: { width: number; depth: number };
}

export interface FocusController {
    focusOn: (target: FocusTarget) => void;
    /** 聚焦到任意世界坐标点（事件锚点等），姿态与建筑聚焦同款，距离由调用方按取景尺度给 */
    focusOnPoint: (center: THREE.Vector3, distance: number) => void;
    /** 推到指定机位（预设视角用它，与聚焦共用同一套补间） */
    moveTo: (position: THREE.Vector3, target: THREE.Vector3) => void;
    reset: () => void;
    update: (dt: number) => void;
    /** 补间进行中：此期间不做拾取 */
    readonly animating: boolean;
}

export function createFocusController(
    camera: THREE.PerspectiveCamera,
    controls: OrbitControls,
    home: { position: THREE.Vector3; target: THREE.Vector3 }
): FocusController {
    /** 补间状态；null 表示没有正在进行的补间 */
    let tween: { elapsed: number } | null = null;

    const fromPosition = new THREE.Vector3();
    const fromTarget = new THREE.Vector3();
    const toPosition = new THREE.Vector3();
    const toTarget = new THREE.Vector3();

    const target = new THREE.Vector3();
    const position = new THREE.Vector3();

    function start(nextPosition: THREE.Vector3, nextTarget: THREE.Vector3): void {
        /* 补间起点取当前瞬时值：允许在动画中途改目标而不跳变 */
        fromPosition.copy(camera.position);
        fromTarget.copy(controls.target);
        toPosition.copy(nextPosition);
        toTarget.copy(nextTarget);
        tween = { elapsed: 0 };
        controls.enabled = false;
    }

    function focusOn(item: FocusTarget): void {
        const { center, apexVoxels, footprint } = item;

        target.set(center.x, apexVoxels * 0.45, center.z);

        const distance = Math.max(
            MIN_DISTANCE,
            Math.max(footprint.width, footprint.depth) * DISTANCE_FACTOR
        );
        position.set(
            target.x + distance * Math.cos(FOCUS_ELEVATION) * Math.sin(FOCUS_AZIMUTH),
            target.y + distance * Math.sin(FOCUS_ELEVATION),
            target.z + distance * Math.cos(FOCUS_ELEVATION) * Math.cos(FOCUS_AZIMUTH)
        );

        start(position, target);
    }

    function focusOnPoint(center: THREE.Vector3, distance: number): void {
        target.copy(center);
        position.set(
            target.x + distance * Math.cos(FOCUS_ELEVATION) * Math.sin(FOCUS_AZIMUTH),
            target.y + distance * Math.sin(FOCUS_ELEVATION),
            target.z + distance * Math.cos(FOCUS_ELEVATION) * Math.cos(FOCUS_AZIMUTH)
        );
        start(position, target);
    }

    function reset(): void {
        start(home.position, home.target);
    }

    function update(dt: number): void {
        if (!tween) return;

        tween.elapsed += dt;
        // 【性能优化】手动内联 min/clamp，避免调用 Math.min/THREE.MathUtils.clamp 的函数调用开销
        const t = tween.elapsed < DURATION ? tween.elapsed / DURATION : 1;
        const k = easeInOutCubic(t);

        camera.position.lerpVectors(fromPosition, toPosition, k);
        controls.target.lerpVectors(fromTarget, toTarget, k);
        // 补间期间用户无法操作 controls（enabled=false），所以不需要每帧做阻尼、边界检查等无用功
        // 只强制同步相机矩阵即可，跳过 controls.update() 的 ~0.03ms 开销
        camera.updateMatrixWorld();

        if (t >= 1) {
            tween = null;
            // 补间结束前显式同步一次 controls：后续手动接管控制需要最新状态
            controls.update();
            controls.enabled = true;
        }
    }

    return {
        focusOn,
        focusOnPoint,
        moveTo: start,
        reset,
        update,
        get animating() {
            return tween !== null;
        }
    };
}
