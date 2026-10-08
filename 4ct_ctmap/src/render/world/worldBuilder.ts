/* ================================================================
   世界装配
   —— 把一份数据集拼成可渲染的悬空小岛：
        网格与坐标系 → 建筑轮廓栅格化 → 地皮盖章 → 地表 → 岛体倒锥 → 体量生成

   调用顺序有硬性要求：建筑必须先栅格化，地表才知道哪些格子不抬树冠。
   主题贯穿全流程：色板只在这里被解析成颜色，其余模块只认色键。

   【分帧】整条链是纯同步计算，一口气跑完要三秒以上，期间浏览器一帧都画不出来
      （加载页的入场动画、进度光带全冻住）。因此 buildWorld 是**异步**的：
      在这里造一个让出器（见 render/scheduler.ts）交给各步骤，
      各步骤在热循环里按时间预算把主线程让回去 —— 总耗时略涨，但动画不冻。
================================================================ */

import * as THREE from 'three';
import type { MapDataset } from '../../contract';
import type { ThemeName } from '../../types/theme';
import type { BuildingRuntime, RenderWarning, WorldStats } from '../../types/world';
import { createGrid, type GridSystem } from '../../utils/geo';
import { createDetailVoxels } from '../constants';
import { createSlicer } from '../scheduler';
import { resolveThemeConfig, THEMES, createSlotLookup, writePalette, type GlobalColorKey, type ThemeConfig } from '../theme/palette';
import { createVoxelMesh } from '../voxel/buildVoxelMesh';
import {
    createBuildings,
    rasterizeBuildings,
    toRuntimeSnapshots,
    type BuildingsHandle
} from './buildingsBuilder';
import { buildIsland } from './islandBuilder';
import { buildLamps } from './lampBuilder';
import { buildProps } from './propsBuilder';
import { buildIslandMask } from './rasterize';
import { buildTerrain } from './terrainBuilder';

export interface World {
    group: THREE.Group;
    /** 网格系统：相机取景、平移限位与投影都用它 */
    grid: GridSystem;
    /** 倒锥总深（体素格数）：相机取景要把岛底一起框进来 */
    islandDepth: number;
    buildings: BuildingsHandle;
    stats: WorldStats;
    warnings: RenderWarning[];
    buildingRuntime: Record<string, BuildingRuntime>;
    /** 支持主题名或插值配置（过渡动画期间传入 lerpThemeConfig 的结果） */
    applyTheme: (themeOrConfig: ThemeName | ThemeConfig) => void;
    /** 每帧推进：建筑高亮补间 + 装饰物动效（飞鸟盘旋、萤火虫漂移） */
    update: (dt: number) => void;
    /** 卸载时释放本世界自建的 GPU 资源（共享的立方体几何不在此列） */
    dispose: () => void;
}

/**
 * 色板覆盖自检：数据里的 paletteKey 必须在当前主题的色板里存在。
 * 缺失直接抛错（而不是给个默认色）—— 配色问题藏起来比暴露出来贵得多。
 */
function assertPaletteCoverage(dataset: MapDataset, theme: ThemeName): void {
    const config = THEMES[theme];

    for (const [key, def] of Object.entries(dataset.dictionaries.terrain.types)) {
        for (const paletteKey of def.paletteKeys) {
            if (config.voxel[paletteKey as GlobalColorKey] === undefined) {
                throw new Error(
                    `地皮类型「${key}」的 paletteKey「${paletteKey}」在色板里不存在（主题 ${theme}）`
                );
            }
        }
    }

    for (const [key, def] of Object.entries(dataset.dictionaries.buildings.types)) {
        if (!config.building[def.paletteKey]) {
            throw new Error(
                `建筑类型「${key}」的 paletteKey「${def.paletteKey}」在色板里不存在（主题 ${theme}）`
            );
        }
    }

    for (const layer of dataset.school.island.rockLayers) {
        if (config.voxel[layer.paletteKey as GlobalColorKey] === undefined) {
            throw new Error(
                `island.rockLayers 的 paletteKey「${layer.paletteKey}」在色板里不存在（主题 ${theme}）`
            );
        }
    }
}

export async function buildWorld(
    dataset: MapDataset,
    theme: ThemeName,
    reducedMotion: boolean
): Promise<World> {
    const { school, dictionaries, buildings, parcels } = dataset;

    assertPaletteCoverage(dataset, theme);

    /* 本次构建共用一个让出器：切片统计按它记录（见 render/scheduler） */
    const slicer = createSlicer();

    const grid = createGrid(school);
    const details = createDetailVoxels(school.voxelMeters);

    /* 0. 岛面格掩码：地表与岛体倒锥共用，避免两边各跑一次多边形测试 */
    const mask = await buildIslandMask(grid, slicer);

    /* 1. 建筑轮廓栅格化：同时得到「哪些格子被建筑占用」 */
    const rasterized = await rasterizeBuildings(grid, buildings, details, slicer);

    /* 2. 地皮盖章 → 逐格地表类别 → 铺地表（岛面之下交给岛体） */
    const terrain = await buildTerrain(
        {
            grid,
            mask,
            parcels,
            terrainTypes: dictionaries.terrain.types,
            defaultTerrainTypeKey: school.defaultTerrainTypeKey,
            occupied: rasterized.occupied,
            details
        },
        slicer
    );

    /* 3. 岛体：岛面以下的岩体 + 岛缘小建筑 + 岛下碎岩 + 岛底云霭 */
    const island = await buildIsland(
        { grid, mask, island: school.island, theme, reducedMotion },
        slicer
    );

    /* 倒锥总深（格）：取景、雾距与天空半径都按它一起放大 */
    /* 【性能排查 · 临时】岛体倒锥停画 → 取景不再为岛底留深度：
       相机取景对角线、雾距、天空半径与四个预设机位都按岛面尺度重算，
       小岛回到画面中央、占画面更大（否则画面下方会空出 400 m）。
       恢复岛体：把下面这段 islandDepth 计算还原、并删掉 islandDepth = 0 那一行。 */
    // const islandDepth = Math.round(
    //     school.island.rockLayers.reduce((sum, layer) => sum + layer.thicknessMeters, 0) /
    //         school.voxelMeters
    // );
    const islandDepth = 0;

    /* 4. 合并成少量 InstancedMesh：地表与水面投光不投影（自投影在 2m 体素下看不出收益，代价却翻倍） */
    const config = THEMES[theme];
    const terrainMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: config.material.roughness,
        metalness: config.material.metalness,
        flatShading: true
    });
    const terrainMesh = await createVoxelMesh(
        await terrain.solid.toArray(slicer),
        terrainMaterial,
        createSlotLookup(),
        slicer,
        { castShadow: false }
    );
    terrainMesh.mesh.name = 'terrain';

    const waterMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: config.water.roughness,
        metalness: config.water.metalness,
        transparent: true,
        opacity: config.water.opacity,
        emissive: new THREE.Color(config.water.emissive),
        flatShading: true
    });
    const waterMesh = await createVoxelMesh(
        await terrain.water.toArray(slicer),
        waterMaterial,
        createSlotLookup(),
        slicer,
        { castShadow: false }
    );
    waterMesh.mesh.name = 'water';
    waterMesh.mesh.renderOrder = 2;

    /* 5. 建筑体量 */
    const buildingHandle = await createBuildings(
        rasterized.records,
        details,
        theme,
        school.voxelMeters,
        slicer
    );

    /* 6. 路灯：沿数据里标了 streetLamp 的地皮两侧成对布置 */
    const lamps = await buildLamps(
        {
            grid,
            parcels,
            terrainTypes: dictionaries.terrain.types,
            occupied: rasterized.occupied
        },
        slicer
    );

    /* 7. 岛面与空中的生灵装饰：花草灌木、飞鸟、萤火虫 */
    const props = await buildProps(
        {
            grid,
            mask,
            classGrid: terrain.classGrid,
            typeKeys: terrain.typeKeys,
            terrainTypes: dictionaries.terrain.types,
            occupied: rasterized.occupied,
            reducedMotion,
            theme
        },
        slicer
    );

    const group = new THREE.Group();
    group.name = 'campus';
    group.add(
        terrainMesh.mesh,
        waterMesh.mesh,
        island.group,
        buildingHandle.group,
        lamps.group,
        props.group
    );

    /* 8. 统计与告警 */
    const terrainVoxels = terrain.solid.size;
    const waterVoxels = terrain.water.size;
    const buildingVoxels = buildingHandle.items.reduce((sum, item) => sum + item.voxelCount, 0);

    const stats: WorldStats = {
        ...terrain.stats,
        terrainVoxels,
        waterVoxels,
        buildingCount: buildingHandle.items.length,
        buildingVoxels,
        islandVoxels: island.voxelCount,
        rimPropCount: island.rimPropCount,
        debrisCount: island.debrisCount,
        lampCount: lamps.lampCount,
        lampPairCount: lamps.pairCount,
        plantCount: props.plantCount,
        birdCount: props.birdCount,
        fireflyCount: props.fireflyCount,
        totalVoxels: terrainVoxels + waterVoxels + buildingVoxels + island.voxelCount
    };

    function applyTheme(next: ThemeName | ThemeConfig): void {
        const nextConfig = resolveThemeConfig(next);

        /* 调色板先写：全部体素网格（地表 / 水面 / 岛体 / 路灯 / 花木 / 建筑）的颜色
           都取自这张纹理，写一次即全场生效 —— 这也是昼夜过渡每帧的全部颜色工作。
           几何只存色槽索引，所以换主题不需要碰任何顶点数据。 */
        writePalette(nextConfig);

        terrainMaterial.roughness = nextConfig.material.roughness;
        terrainMaterial.metalness = nextConfig.material.metalness;

        waterMaterial.roughness = nextConfig.water.roughness;
        waterMaterial.metalness = nextConfig.water.metalness;
        waterMaterial.opacity = nextConfig.water.opacity;
        waterMaterial.emissive.setHex(nextConfig.water.emissive);

        island.applyTheme(next);
        lamps.applyTheme(next);
        props.applyTheme(next);
        buildingHandle.applyTheme(next);
    }

    function update(dt: number): void {
        buildingHandle.update(dt);
        props.update(dt);
        /* 岛下的碎岩与云霭：极慢漂移，让岛底不像一块死石头 */
        island.update(dt);
    }

    function dispose(): void {
        terrainMaterial.dispose();
        waterMaterial.dispose();
        island.dispose();
        lamps.dispose();
        props.dispose();

        for (const item of buildingHandle.items) {
            item.material.dispose();
            item.proxy.geometry.dispose();
            (item.proxy.material as THREE.Material).dispose();
        }
    }

    /* 调色板必须在首帧之前写好：几何里只有色槽索引，颜色全来自那张纹理 */
    applyTheme(theme);

    return {
        group,
        grid,
        islandDepth,
        buildings: buildingHandle,
        stats,
        warnings: [...rasterized.warnings, ...terrain.warnings, ...island.warnings],
        buildingRuntime: toRuntimeSnapshots(buildingHandle.items),
        applyTheme,
        update,
        dispose
    };
}
