/* ================================================================
   鼠标拾取
   —— 射线只打建筑的「代理盒」（不可见的包围盒），不打体素实例。
   两个原因：
     1) 代理盒覆盖整栋楼的体量，命中区域比体素表面更宽容，好点；
     2) 十万级 InstancedMesh 的逐实例求交要遍历全部实例，代价高得多。
================================================================ */

import * as THREE from 'three';

export interface Picker {
    /** @returns 命中的建筑 id；未命中返回 null */
    pick(clientX: number, clientY: number): string | null;
    /**
     * 【性能优化】传入预缓存的 canvas rect，避免 pick 内部再次调用
     * getBoundingClientRect 触发强制回流。主循环里每帧调用都走该路径。
     */
    pickWithRect(
        clientX: number,
        clientY: number,
        rect: { left: number; top: number; width: number; height: number }
    ): string | null;
}

export function createPicker(
    camera: THREE.Camera,
    canvas: HTMLCanvasElement,
    proxies: THREE.Object3D[]
): Picker {
    const raycaster = new THREE.Raycaster();
    const screen = new THREE.Vector2();

    function pick(clientX: number, clientY: number): string | null {
        const rect = canvas.getBoundingClientRect();
        return pickWithRect(clientX, clientY, rect);
    }

    function pickWithRect(
        clientX: number,
        clientY: number,
        rect: { left: number; top: number; width: number; height: number }
    ): string | null {
        if (rect.width === 0 || rect.height === 0) return null;

        screen.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        screen.y = -((clientY - rect.top) / rect.height) * 2 + 1;

        raycaster.setFromCamera(screen, camera);
        const hits = raycaster.intersectObjects(proxies, false);
        return hits.length > 0 ? (hits[0].object.userData.buildingId as string) : null;
    }

    return { pick, pickWithRect };
}
