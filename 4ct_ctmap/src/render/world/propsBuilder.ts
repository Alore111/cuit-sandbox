/* ================================================================
   岛面与空中的生灵装饰
   —— 四类装饰里的两类（另两类是天空的云/星空/日月，见 render/sky）：
        · 花草灌木：只在数据标了 groundCover 且没有树冠的地表上散布（草地），
          按坐标哈希决定落点与株高 —— 每次打开位置完全一致；
        · 飞鸟与萤火虫：飞鸟绕岛盘旋（昼夜都在），萤火虫只在夜里亮（白天整体隐藏）。

   装饰物一律不参与阴影：它们数量多、体量小，投影看不出收益，代价却翻倍。
================================================================ */

import * as THREE from 'three';
import type { TerrainTypeDef } from '../../contract';
import type { ThemeName } from '../../types/theme';
import type { GridSystem } from '../../utils/geo';
import type { Slicer } from '../scheduler';
import { resolveThemeConfig, createSlotLookup, type ThemeConfig } from '../theme/palette';
import { createVoxelMesh } from '../voxel/buildVoxelMesh';
import { hash2 } from '../voxel/random';
import { VoxelModel } from '../voxel/VoxelModel';
import { cellKey } from './rasterize';
import { OUTSIDE_TYPE_INDEX } from './terrainBuilder';

/** 落点阈值：哈希超过就长一株。取「每 40 格左右一株」，1.2 km 的岛上读起来是稀疏点缀 */
const FLOWER_THRESHOLD = 0.982;
const SHRUB_THRESHOLD = 0.962;
/** 灌木有两档高度（格）：低丛与高丛 */
const SHRUB_TALL_THRESHOLD = 0.988;
const SHRUB_LOW_CELLS = 2;
const SHRUB_TALL_CELLS = 3;

/** 飞鸟：群数 / 每群只数 / 盘旋高度（米）/ 角速度（弧度每秒） */
const BIRD_FLOCKS = 3;
const BIRDS_PER_FLOCK = 4;
const BIRD_ALTITUDE_METERS = [70, 140];
const BIRD_ORBIT_SPEED = [0.05, 0.09];
/** 鸟身尺寸（体素格）：翼展 3 格 = 6 m */
const BIRD_WINGSPAN = 3;
const BIRD_BODY_HEIGHT = 0.6;
const BIRD_BODY_LENGTH = 1.2;

/**
 * 萤火虫：只数 / 离岛面高度（格）/ 原地绕圈的半径（格）/ 角速度区间（弧度每秒）/ 上下浮动（格）
 * —— 每只各绕自己那一小块地方转，不整团绕岛转：整团转起来在画面里就是一大块光斑在扫，
 *    而且转轴落在世界原点（网格左上角），看起来就是绕岛角飞。
 */
const FIREFLY_COUNT = 160;
const FIREFLY_HEIGHT_CELLS = [2, 8];
const FIREFLY_DRIFT_RADIUS_CELLS = 1.6;
const FIREFLY_DRIFT_SPEED = [0.3, 0.7];
const FIREFLY_BOB_CELLS = 1.2;

export interface PropsInput {
    grid: GridSystem;
    mask: Uint8Array;
    /** 逐格地皮类型索引（来自地表构建） */
    classGrid: Int16Array;
    /** 索引 → 地皮类型 key */
    typeKeys: string[];
    terrainTypes: Record<string, TerrainTypeDef>;
    /** 建筑足迹：建筑里不长花草 */
    occupied: Set<string>;
    reducedMotion: boolean;
    theme: ThemeName;
}

export interface PropsHandle {
    group: THREE.Group;
    plantCount: number;
    birdCount: number;
    fireflyCount: number;
    applyTheme: (themeOrConfig: ThemeName | ThemeConfig) => void;
    update: (dt: number) => void;
    dispose: () => void;
}

interface Flock {
    group: THREE.Group;
    /** 逆时针还是顺时针 */
    direction: number;
    speed: number;
}

export async function buildProps(input: PropsInput, slicer: Slicer): Promise<PropsHandle> {
    const { grid, mask, classGrid, typeKeys, terrainTypes, occupied, reducedMotion, theme } = input;
    const { width, height, voxelMeters } = grid;

    /* ---------- 1. 花草灌木 ---------- */
    const plants = new VoxelModel();
    /** 可长花草的格子，萤火虫从这里面取落点 */
    const groundCells: number[] = [];
    let plantCount = 0;

    for (let vz = 0; vz < height; vz++) {
        for (let vx = 0; vx < width; vx++) {
            const at = vz * width + vx;
            if (mask[at] === 0) continue;

            const index = classGrid[at];
            if (index === OUTSIDE_TYPE_INDEX) continue;

            const def = terrainTypes[typeKeys[index]];
            if (!def || !def.groundCover) continue;

            groundCells.push(at);
            /* 有树冠的地表已经立了树，不再长花草（否则花草会穿在树冠里） */
            if (def.canopy || occupied.has(cellKey(vx, vz))) continue;

            const roll = hash2(vx, vz);
            if (roll > FLOWER_THRESHOLD) {
                plants.set(vx, 1, vz, 'flower');
                plantCount += 1;
            } else if (roll > SHRUB_THRESHOLD) {
                const top = roll > SHRUB_TALL_THRESHOLD ? SHRUB_TALL_CELLS : SHRUB_LOW_CELLS;
                for (let y = 1; y <= top; y++) {
                    plants.set(vx, y, vz, y === top ? 'shrubHi' : 'shrub');
                }
                plantCount += 1;
            }
        }
        /* 岛面逐格过一遍，量级与地表那一步相同：按行让出 */
        if (slicer.shouldYield()) await slicer.yield();
    }

    /* ---------- 2. 飞鸟：绕岛盘旋 ---------- */
    const birdGeometry = new THREE.BoxGeometry(BIRD_WINGSPAN, BIRD_BODY_HEIGHT, BIRD_BODY_LENGTH);
    const birdMaterial = new THREE.MeshBasicMaterial({ fog: false });
    const flocks: Flock[] = [];
    const birdCount = BIRD_FLOCKS * BIRDS_PER_FLOCK;
    const maxSpan = Math.max(grid.size.x, grid.size.z);

    for (let f = 0; f < BIRD_FLOCKS; f += 1) {
        const flock = new THREE.Group();
        /* 群挂到岛心自转：实例位置也按岛心写，鸟才是「绕岛」盘旋 */
        flock.position.set(grid.center.x, 0, grid.center.z);
        const mesh = new THREE.InstancedMesh(birdGeometry, birdMaterial, BIRDS_PER_FLOCK);
        mesh.frustumCulled = false;

        const altitudeCells =
            (BIRD_ALTITUDE_METERS[0] +
                hash2(f + 11, f * 7 + 3) * (BIRD_ALTITUDE_METERS[1] - BIRD_ALTITUDE_METERS[0])) /
            voxelMeters;
        const baseRadius = maxSpan * (0.24 + hash2(f + 31, 17) * 0.16);

        const matrix = new THREE.Matrix4();
        for (let b = 0; b < BIRDS_PER_FLOCK; b += 1) {
            /* 群内每只错开一点半径、高度与相位，才不会叠成一条线 */
            const offset = hash2(f * 13 + b, b * 29 + 5);
            const radius = baseRadius * (0.86 + offset * 0.3);
            const angle = (b / BIRDS_PER_FLOCK) * Math.PI * 2 + offset * 1.2;
            const y = altitudeCells + (offset - 0.5) * 6;
            matrix.makeTranslation(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
            mesh.setMatrixAt(b, matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
        flock.add(mesh);

        const speed =
            BIRD_ORBIT_SPEED[0] +
            hash2(f + 71, 23) * (BIRD_ORBIT_SPEED[1] - BIRD_ORBIT_SPEED[0]);
        flock.rotation.y = hash2(f + 101, 41) * Math.PI * 2;
        flocks.push({ group: flock, direction: f % 2 === 0 ? 1 : -1, speed });
    }

    /* ---------- 3. 萤火虫：夜里亮，白天整体隐藏 ---------- */
    const fireflyMaterial = new THREE.PointsMaterial({
        size: voxelMeters * 2.4,
        sizeAttenuation: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false
    });
    const fireflyLayout = [];
    /** 每只的基准落点（漂移围绕它转）、相位与角速度 */
    const fireflyBase = new Float32Array(FIREFLY_COUNT * 3);
    const fireflyPhase = new Float32Array(FIREFLY_COUNT);
    const fireflySpeed = new Float32Array(FIREFLY_COUNT);
    const fireflySpan = Math.min(FIREFLY_COUNT, groundCells.length);
    for (let i = 0; i < fireflySpan; i += 1) {
        /* 均匀抽样而不是逐个哈希：萤火虫要铺满整岛，不能只挤在一角 */
        const at = groundCells[Math.floor((i / fireflySpan) * groundCells.length)];
        const vx = at % width;
        const vz = (at - vx) / width;
        const jitterX = hash2(vx + 101, vz) - 0.5;
        const jitterZ = hash2(vx, vz + 202) - 0.5;
        const y =
            FIREFLY_HEIGHT_CELLS[0] +
            hash2(vx + 303, vz + 404) * (FIREFLY_HEIGHT_CELLS[1] - FIREFLY_HEIGHT_CELLS[0]);
        const x = vx + 0.5 + jitterX;
        const z = vz + 0.5 + jitterZ;

        fireflyLayout.push(x, y, z);
        fireflyBase[i * 3] = x;
        fireflyBase[i * 3 + 1] = y;
        fireflyBase[i * 3 + 2] = z;
        fireflyPhase[i] = hash2(vx + 505, vz + 606) * Math.PI * 2;
        fireflySpeed[i] =
            FIREFLY_DRIFT_SPEED[0] +
            hash2(vx + 707, vz + 808) * (FIREFLY_DRIFT_SPEED[1] - FIREFLY_DRIFT_SPEED[0]);
    }
    const fireflyGeometry = new THREE.BufferGeometry();
    fireflyGeometry.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(fireflyLayout), 3)
    );
    const fireflies = new THREE.Points(fireflyGeometry, fireflyMaterial);
    fireflies.name = 'fireflies';
    /** 白天整体隐藏，这时不必每帧重传顶点 */
    let fireflyVisible = true;

    /* ---------- 4. 装配 ---------- */
    const slotOf = createSlotLookup();
    const plantMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.85,
        metalness: 0,
        flatShading: true
    });
    const plantMesh = await createVoxelMesh(await plants.toArray(slicer), plantMaterial, slotOf, slicer, {
        castShadow: false
    });
    plantMesh.mesh.name = 'groundCoverPlants';

    const group = new THREE.Group();
    group.name = 'props';
    group.add(plantMesh.mesh, fireflies);
    for (const flock of flocks) group.add(flock.group);

    function applyTheme(next: ThemeName | ThemeConfig): void {
        const config = resolveThemeConfig(next);
        plantMaterial.roughness = config.material.roughness;
        birdMaterial.color.setHex(config.voxel.bird);
        fireflyMaterial.color.setHex(config.voxel.lampGlow);
        fireflyMaterial.opacity = config.fireflies.opacity;
        fireflyVisible = config.fireflies.opacity > 0;
        fireflies.visible = fireflyVisible;
    }

    const animate = !reducedMotion;
    const fireflyPositions = fireflyGeometry.getAttribute('position') as THREE.BufferAttribute;
    let fireflyTime = 0;

    function update(dt: number): void {
        if (!animate) return;
        for (const flock of flocks) {
            flock.group.rotation.y += flock.direction * flock.speed * dt;
        }

        if (!fireflyVisible) return;

        /* 萤火虫逐只原地漂移：绕基准点划小圈 + 上下微浮，光点才是「飘」而不是「整片扫」 */
        fireflyTime += dt;
        for (let i = 0; i < fireflySpan; i += 1) {
            const angle = fireflyPhase[i] + fireflyTime * fireflySpeed[i];
            fireflyPositions.setXYZ(
                i,
                fireflyBase[i * 3] + Math.cos(angle) * FIREFLY_DRIFT_RADIUS_CELLS,
                fireflyBase[i * 3 + 1] + Math.sin(angle * 1.7) * FIREFLY_BOB_CELLS,
                fireflyBase[i * 3 + 2] + Math.sin(angle) * FIREFLY_DRIFT_RADIUS_CELLS
            );
        }
        fireflyPositions.needsUpdate = true;
    }

    function dispose(): void {
        plantMaterial.dispose();
        birdGeometry.dispose();
        birdMaterial.dispose();
        fireflyGeometry.dispose();
        fireflyMaterial.dispose();
    }

    applyTheme(theme);

    return {
        group,
        plantCount,
        birdCount,
        fireflyCount: fireflySpan,
        applyTheme,
        update,
        dispose
    };
}
