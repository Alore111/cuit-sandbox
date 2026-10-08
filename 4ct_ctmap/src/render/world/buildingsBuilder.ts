/* ================================================================
   建筑：轮廓栅格化 + 体量生成 + 状态动效
   —— 轮廓是真实的（数据里的多边形），高度是按类型经验值推定的（数据里的 floors × floorHeight）。
   每栋一个 InstancedMesh + 独立材质，才能单独做悬停增亮与聚焦高亮。
================================================================ */

import * as THREE from 'three';
import type { Building } from '../../contract';
import type { ThemeName } from '../../types/theme';
import type { BuildingRuntime, RenderWarning } from '../../types/world';
import type { GridSystem } from '../../utils/geo';
import { GROUND_Y, MIN_TOTAL_VOXELS, PROXY_PADDING, type DetailVoxels } from '../constants';
import type { Slicer } from '../scheduler';
import {
    BUILDING_STATE,
    STATE_VISUAL,
    THEMES,
    createSlotLookup,
    resolveThemeConfig,
    type BuildingState,
    type BuildingTint,
    type ThemeConfig
} from '../theme/palette';
import { createVoxelMesh, type VoxelMeshHandle } from '../voxel/buildVoxelMesh';
import { seededRandom } from '../voxel/random';
import { VoxelModel, type Voxel } from '../voxel/VoxelModel';
import { MASSING } from './massing';
import { boundsOf, cellKey, clipToGrid, rasterizeOutline, type GridCell } from './rasterize';

/** 状态动效的平滑时间常数（秒）：越小越干脆 */
const SMOOTH = 0.16;

/**
 * 该栋的类型主色调（类型字典给的可选覆盖，见 BuildingTypeDef）。
 * 逐栋参数不参与：同一类型的楼颜色一致，因此每次取值都是同一份。
 */
function tintOf(building: Building): BuildingTint {
    return { wallColor: building.wallColor, roofColor: building.roofColor };
}

export interface BuildingRecord {
    building: Building;
    cells: GridCell[];
}

export interface RasterizeBuildingsResult {
    records: BuildingRecord[];
    /** 建筑足迹：地表据此决定哪些格子不抬树冠 */
    occupied: Set<string>;
    warnings: RenderWarning[];
}

/**
 * 栅格化全部建筑。必须在建地表之前调用：
 * 地表要靠这份足迹集合决定哪些格子不抬树冠。
 */
export async function rasterizeBuildings(
    grid: GridSystem,
    buildings: Building[],
    details: DetailVoxels,
    slicer: Slicer
): Promise<RasterizeBuildingsResult> {
    const records: BuildingRecord[] = [];
    const occupied = new Set<string>();
    const warnings: RenderWarning[] = [];

    for (const building of buildings) {
        const raw = await rasterizeOutline(grid, building.outline, slicer);
        const cells = clipToGrid(raw, grid);
        const name = building.name || `${building.typeLabel}（未命名）`;

        if (cells.length === 0) {
            warnings.push({
                id: building.id,
                kind: 'building',
                name,
                reason:
                    raw.length === 0
                        ? '轮廓在网格内一格都没有（多边形可能退化或自交）'
                        : `轮廓整条落在网格之外（多边形 ${raw.length} 格全在板外）`
            });
            continue;
        }

        if (cells.length < details.minFootprintCells) {
            warnings.push({
                id: building.id,
                kind: 'building',
                name,
                reason: `足迹只有 ${cells.length} 格，小于最小占地 ${details.minFootprintCells} 格，未生成体素`
            });
            continue;
        }

        for (const { vx, vz } of cells) occupied.add(cellKey(vx, vz));
        records.push({ building, cells });

        /* 轮廓栅格化与足迹登记按栋累计：逐栋让出 */
        if (slicer.shouldYield()) await slicer.yield();
    }

    return { records, occupied, warnings };
}

export interface BuildingItem {
    building: Building;
    cells: GridCell[];
    handle: VoxelMeshHandle;
    material: THREE.MeshStandardMaterial;
    proxy: THREE.Mesh;
    /** 代理盒的静止高度：跟随时需要在这个基值上加浮动量 */
    proxyBaseY: number;
    voxels: Voxel[];
    /** 实际生成的最高顶点（含冠部、矮栏等超出名义高度的部分） */
    apexVoxels: number;
    footprint: { width: number; depth: number };
    voxelCount: number;
    center: THREE.Vector3;
    state: BuildingState;
    lift: number;
    glow: number;
}

export interface BuildingsHandle {
    group: THREE.Group;
    items: BuildingItem[];
    proxies: THREE.Object3D[];
    get: (id: string) => BuildingItem | null;
    setState: (id: string, state: BuildingState) => void;
    update: (dt: number) => void;
    applyTheme: (themeOrConfig: ThemeName | ThemeConfig) => void;
}

/** 建筑的体素包围盒 → 世界坐标下的中心、尺寸与射线拾取代理盒 */
function createProxy(item: {
    cells: GridCell[];
    apexVoxels: number;
    centerX: number;
    centerZ: number;
}): { proxy: THREE.Mesh; width: number; depth: number; baseY: number } {
    const { minVx, maxVx, minVz, maxVz } = boundsOf(item.cells);

    /* 向外放宽一格：既把出檐屋面盖进去，也让点击判定更宽容 */
    const width = maxVx - minVx + 1 + PROXY_PADDING * 2;
    const depth = maxVz - minVz + 1 + PROXY_PADDING * 2;
    const height = item.apexVoxels - GROUND_Y;
    const baseY = GROUND_Y + 1 + height / 2;

    const proxy = new THREE.Mesh(
        new THREE.BoxGeometry(width, height, depth),
        /* visible=false 的材质不参与渲染，但射线照样能命中 */
        new THREE.MeshBasicMaterial({ visible: false })
    );
    proxy.position.set(item.centerX, baseY, item.centerZ);

    return { proxy, width, depth, baseY };
}

/**
 * 逐栋生成体量与网格 —— 每栋都要跑一遍体量做法（攒体素）再合并成几何，
 * 是构建链上仅次于地表合并的一步，因此按栋让出主线程。
 */
export async function createBuildings(
    records: BuildingRecord[],
    details: DetailVoxels,
    theme: ThemeName,
    voxelMeters: number,
    slicer: Slicer
): Promise<BuildingsHandle> {
    const group = new THREE.Group();
    group.name = 'buildings';

    const items: BuildingItem[] = [];
    for (const record of records) {
        const { building, cells } = record;
        const builder = MASSING[building.massing];
        if (!builder) {
            throw new Error(
                `建筑 ${building.id}（${building.name || building.typeLabel}）的体量做法「${building.massing}」没有实现`
            );
        }

        const model = new VoxelModel();
        /* 名义总层数：推定高度折算，并按「台基 + 墙体 + 屋面」的结构下限兜住 */
        const totalVoxels = Math.max(MIN_TOTAL_VOXELS, building.heightVoxels);

        const apexVoxels = builder({
            model,
            cells,
            groundY: GROUND_Y,
            totalVoxels,
            params: building.massingParams,
            voxelMeters,
            details,
            random: seededRandom(Number(building.id.replace(/\D/g, '')) || 1),
            label: `建筑 ${building.id}（${building.name || building.typeLabel}）`
        });

        const voxels = await model.toArray(slicer);
        const slotOf = createSlotLookup(building.paletteKey, tintOf(building));
        const material = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: THEMES[theme].material.roughness,
            metalness: THEMES[theme].material.metalness,
            flatShading: true,
            emissive: new THREE.Color(0x000000),
            emissiveIntensity: 1
        });
        const handle = await createVoxelMesh(voxels, material, slotOf, slicer);

        const centerBounds = boundsOf(cells);
        const centerX = (centerBounds.minVx + centerBounds.maxVx) / 2 + 0.5;
        const centerZ = (centerBounds.minVz + centerBounds.maxVz) / 2 + 0.5;

        const { proxy, width, depth, baseY } = createProxy({
            cells,
            apexVoxels,
            centerX,
            centerZ
        });
        proxy.userData.buildingId = building.id;

        const topWorld = apexVoxels + 1;

        group.add(handle.mesh, proxy);

        items.push({
            building,
            cells,
            handle,
            material,
            proxy,
            proxyBaseY: baseY,
            voxels,
            apexVoxels,
            footprint: { width, depth },
            voxelCount: voxels.length,
            /* 世界坐标下的占地中心与顶部高度，供相机聚焦使用 */
            center: new THREE.Vector3(centerX, topWorld / 2, centerZ),
            state: BUILDING_STATE.IDLE,
            lift: 0,
            glow: 0
        });

        if (slicer.shouldYield()) await slicer.yield();
    }

    const byId = new Map(items.map((item) => [item.building.id, item]));
    const proxies = items.map((item) => item.proxy);

    function setState(id: string, state: BuildingState): void {
        const item = byId.get(id);
        if (item && item.state !== state) item.state = state;
    }

    /** 每帧平滑推进位移与自发光，并在悬停/聚焦时让建筑上浮一点 */
    function update(dt: number): void {
        const k = 1 - Math.exp(-dt / SMOOTH);

        for (const item of items) {
            const target = STATE_VISUAL[item.state];
            item.lift += (target.lift - item.lift) * k;
            item.glow += (target.glow - item.glow) * k;

            item.handle.mesh.position.y = item.lift;
            item.proxy.position.y = item.proxyBaseY + item.lift;
            item.material.emissive.setRGB(item.glow * 0.3, item.glow * 0.2, item.glow * 0.07);
        }
    }

    function applyTheme(next: ThemeName | ThemeConfig): void {
        const config = resolveThemeConfig(next);
        for (const item of items) {
            item.material.roughness = config.material.roughness;
            item.material.metalness = config.material.metalness;
        }
    }

    return {
        group,
        items,
        proxies,
        get: (id) => byId.get(id) ?? null,
        setState,
        update,
        applyTheme
    };
}

/** 供状态层保存的轻量快照：UI 不接触 three.js 对象 */
export function toRuntimeSnapshots(items: BuildingItem[]): Record<string, BuildingRuntime> {
    const snapshots: Record<string, BuildingRuntime> = {};
    for (const item of items) {
        snapshots[item.building.id] = {
            id: item.building.id,
            apexVoxels: item.apexVoxels,
            footprint: item.footprint,
            voxelCount: item.voxelCount
        };
    }
    return snapshots;
}
