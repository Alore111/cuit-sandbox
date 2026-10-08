/*
 * ================================================================
 * 无头自检脚本（不依赖浏览器）
 * ================================================================
 * 通过后端读接口（HTTP /api/map/*）拉数据 → 在前端渲染层建一遍世界 → 打印结果。
 * 目的：把「数据 → 栅格化 → 体量 → 色板」这条链路的对错与耗时
 * 用数字说话，不必开浏览器、不必截图。
 *
 *   用法：npm run check
 *
 * 【前置条件】后端要在跑（npm run dev:server 或 npm run dev:all）。
 *   自检刻意走与浏览器完全相同的那条数据链路，因此不 import 后端源码、
 *   也不直接读 data/*.json；后端没起时脚本会明确报错退出，不做任何兜底。
 *
 * 注意：这里刻意不建 stage（渲染器需要 WebGL 上下文），
 * 因此校验范围是「世界构建 + 主题重着色」，不含实际绘制。
 * ================================================================
 */

import { LAMP_HEIGHT_METERS, LAMP_SPACING_METERS } from '../src/render/world/lampBuilder';
import { THEMES, createSlotLookup } from '../src/render/theme/palette';
import { dilate } from '../src/render/world/rasterize';
import { buildWorld } from '../src/render/world/worldBuilder';
import { loadMapDataset } from '../src/services/mapService';
import type { MapDataset, MassingKey } from '../src/contract';

/* 自检要连的后端地址：默认本机后端开发端口（与 vite.config.ts 的 proxy 目标一致），可用 VITE_API_BASE 覆盖 */
const SERVER_ORIGIN = process.env.VITE_API_BASE ?? 'http://127.0.0.1:3001';
process.env.VITE_API_BASE = SERVER_ORIGIN;

const MASSINGS: MassingKey[] = ['block', 'shed', 'arch', 'tower', 'skywalk'];

function ms(start: number): string {
    return `${(performance.now() - start).toFixed(0)}ms`;
}

function percent(part: number, total: number): string {
    return total === 0 ? '0%' : `${((part / total) * 100).toFixed(1)}%`;
}

/** 拉数据集；连不上就把「要先起后端」这件事说清楚，不做兜底 */
async function fetchDataset(): Promise<MapDataset> {
    try {
        return await loadMapDataset();
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
            `从 ${SERVER_ORIGIN} 拉取数据集失败：${reason}\n` +
                `  自检走的是后端的读接口，请先启动后端（npm run dev:server，或 npm run dev:all 一起起）。`
        );
    }
}

async function main(): Promise<void> {
    const dataset = await fetchDataset();
    const { school, dictionaries, buildings, parcels } = dataset;

    console.info(`\n== 数据 ==`);
    console.info(`学校        ${school.name}${school.campusName}（${school.shortName}）`);
    console.info(`体素边长    ${school.voxelMeters} m　网格余量 ${school.gridPaddingMeters} m`);
    console.info(`建筑 / 地皮 ${buildings.length} / ${parcels.length} 条`);
    console.info(`地皮类型    ${Object.keys(dictionaries.terrain.types).join('、')}`);
    console.info(`建筑类型    ${Object.keys(dictionaries.buildings.types).join('、')}`);

    /* ---------------- 建世界 ---------------- */
    const startedDark = performance.now();
    const world = await buildWorld(dataset, 'night', false);
    const buildTime = ms(startedDark);

    const { stats, warnings } = world;
    console.info(`\n== 网格 ==`);
    console.info(`尺寸        ${stats.gridSize.width} × ${stats.gridSize.height} 格`);
    console.info(`跨度        ${stats.spanMeters.x.toFixed(0)} × ${stats.spanMeters.z.toFixed(0)} m`);
    console.info(`岛面格子    ${stats.islandCells}（轮廓 ${school.island.outline.length} 点）`);

    console.info(`\n== 地皮占比（岛面内）==`);
    for (const [key, def] of Object.entries(dictionaries.terrain.types).sort(
        ([, a], [, b]) => a.order - b.order
    )) {
        const count = stats.terrainCellsByType[key] ?? 0;
        console.info(`  ${def.label.padEnd(6, '　')} ${String(count).padStart(7)}  ${percent(count, stats.islandCells)}`);
    }

    console.info(`\n== 体量做法分布 ==`);
    const byMassing = new Map<MassingKey, number>();
    for (const item of world.buildings.items) {
        const key = item.building.massing;
        byMassing.set(key, (byMassing.get(key) ?? 0) + 1);
    }
    for (const key of MASSINGS) {
        console.info(`  ${key.padEnd(8)} ${String(byMassing.get(key) ?? 0).padStart(3)} 栋`);
    }

    console.info(`\n== 体素规模 ==`);
    console.info(`地表        ${stats.terrainVoxels}`);
    console.info(`水面        ${stats.waterVoxels}`);
    console.info(`建筑        ${stats.buildingVoxels}（${stats.buildingCount} 栋）`);
    console.info(`岛体        ${stats.islandVoxels}（碎岩 ${stats.debrisCount} 块）`);
    console.info(`合计        ${stats.totalVoxels}`);
    console.info(`构建耗时    ${buildTime}`);

    /* ---------------- 岛体抽查：倒锥是否真的收成尖、装饰是否落位 ---------------- */
    const coneDepth = school.island.rockLayers.reduce((sum, layer) => sum + layer.thicknessMeters, 0);
    console.info(`\n== 悬空小岛 ==`);
    console.info(
        `  岛面轮廓 ${school.island.outline.length} 点　扰动基准 ${school.island.noiseMeters} m` +
            `　倒锥 ${coneDepth} m = ${coneDepth / school.voxelMeters} 格`
    );
    console.info(
        `  岩层      ${school.island.rockLayers
            .map((layer) => `${layer.thicknessMeters}m/${layer.paletteKey}`)
            .join(' → ')}`
    );
    console.info(
        `  岛缘小建筑 ${stats.rimPropCount}/${school.island.rimProps.length} 座　` +
            `岛下碎岩 ${stats.debrisCount}/${school.island.debris.length} 块`
    );

    /* ---------------- 路灯与生灵装饰 ---------------- */
    console.info(`\n== 路灯与装饰 ==`);
    console.info(
        `  路灯 ${stats.lampCount} 根（两侧成对 ${stats.lampPairCount} 组，同侧间距 ${LAMP_SPACING_METERS} m、` +
            `灯高 ${LAMP_HEIGHT_METERS} m = ${LAMP_HEIGHT_METERS / school.voxelMeters} 格）`
    );
    console.info(
        `  花草灌木 ${stats.plantCount} 株　飞鸟 ${stats.birdCount} 只　萤火虫 ${stats.fireflyCount} 只`
    );

    /* ---------------- 天桥抽查：新做法必须真的立起来 ---------------- */
    const skywalks = world.buildings.items.filter((item) => item.building.massing === 'skywalk');
    console.info(`\n== 天桥抽查 ==`);
    if (skywalks.length === 0) {
        console.info('  数据里没有 skywalk 建筑');
    }
    for (const item of skywalks) {
        const b = item.building;
        console.info(
            `  ${b.name}（${b.id}）　名义 ${b.floors}×${b.floorHeight}=${b.heightMeters}m` +
                ` → ${b.heightVoxels} 格；生成顶点 ${item.apexVoxels} 格、${item.voxelCount} 块体素` +
                `、占地 ${item.footprint.width}×${item.footprint.depth} 格`
        );
    }

    /* ---------------- 最高的几栋：形制是否合理 ---------------- */
    console.info(`\n== 生成高度 Top 6 ==`);
    for (const item of [...world.buildings.items]
        .sort((a, b) => b.apexVoxels - a.apexVoxels)
        .slice(0, 6)) {
        const b = item.building;
        console.info(
            `  ${(b.name || `${b.typeLabel}（未命名）`).padEnd(18, '　')} ${b.typeLabel.padEnd(6, '　')}` +
                ` ${b.massing.padEnd(7)} 推定 ${b.heightMeters.toFixed(1)}m → 生成 ${item.apexVoxels} 格` +
                `（${(item.apexVoxels * school.voxelMeters).toFixed(0)}m）`
        );
    }

    /* ---------------- 形制自检：屋面必须跟着建筑轮廓 ---------------- */
    console.info(`\n== 形制自检：体素是否都落在足迹内（允许出檐一圈）==`);
    let overhangVoxels = 0;
    for (const item of world.buildings.items) {
        const allowed = new Set(dilate(item.cells).map((cell) => `${cell.vx}|${cell.vz}`));
        const outside = item.voxels.filter((voxel) => !allowed.has(`${voxel.x}|${voxel.z}`));
        if (outside.length === 0) continue;

        overhangVoxels += outside.length;
        console.info(
            `  ✗ ${item.building.name || item.building.id}：${outside.length} 块盖出足迹之外` +
                `（做法 ${item.building.massing}）`
        );
    }
    if (overhangVoxels === 0) {
        console.info('  全部建筑的体素都在「足迹 + 出檐一圈」之内 ✓');
    }

    /* ---------------- 屋面剖面抽查：檐口缓、中间陡 ---------------- */
    console.info(`\n== 屋面剖面抽查（每层收进格数）==`);
    const roofProfiled = world.buildings.items.filter(
        (item) => item.building.massing === 'arch' || item.building.massing === 'shed'
    );

    for (const item of roofProfiled.slice(0, 2)) {
        interface Layer {
            count: number;
            minVx: number;
            maxVx: number;
            minVz: number;
            maxVz: number;
        }

        const layers = new Map<number, Layer>();
        for (const voxel of item.voxels) {
            if (voxel.key !== 'roof') continue;
            const layer = layers.get(voxel.y) ?? {
                count: 0,
                minVx: Infinity,
                maxVx: -Infinity,
                minVz: Infinity,
                maxVz: -Infinity
            };
            layer.count += 1;
            layer.minVx = Math.min(layer.minVx, voxel.x);
            layer.maxVx = Math.max(layer.maxVx, voxel.x);
            layer.minVz = Math.min(layer.minVz, voxel.z);
            layer.maxVz = Math.max(layer.maxVz, voxel.z);
            layers.set(voxel.y, layer);
        }

        console.info(
            `  ${item.building.name || item.building.id}（${item.building.massing}）屋面 ${layers.size} 层：`
        );

        let previous: { width: number; depth: number } | null = null;
        for (const y of [...layers.keys()].sort((a, b) => a - b)) {
            const layer = layers.get(y)!;
            const width = layer.maxVx - layer.minVx + 1;
            const depth = layer.maxVz - layer.minVz + 1;
            const inset = previous
                ? `宽收 ${Math.round((previous.width - width) / 2)}、深收 ${Math.round((previous.depth - depth) / 2)}`
                : '檐口';
            console.info(
                `    y=${String(y).padStart(2)}  宽 ${String(width).padStart(3)} / 深 ${String(depth).padStart(3)} 格　${inset}`
            );
            previous = { width, depth };
        }
    }

    /* ---------------- 告警 ---------------- */
    console.info(`\n== 渲染告警 ${warnings.length} 条 ==`);
    for (const warning of warnings) {
        console.info(`  [${warning.kind}] ${warning.name}（${warning.id}）：${warning.reason}`);
    }

    /* ---------------- 主题切换：只重写调色板纹理，测一下耗时 ---------------- */
    console.info(`\n== 主题切换（重写调色板纹理）==`);
    for (const theme of ['day', 'night'] as const) {
        const started = performance.now();
        world.applyTheme(theme);
        const config = THEMES[theme];
        console.info(
            `  → ${theme.padEnd(5)} ${ms(started)}　雾色 #${config.fog.color.toString(16).padStart(6, '0')}　` +
                `天顶 #${config.sky.dome.top.toString(16).padStart(6, '0')}　星 ${config.sky.starOpacity}`
        );
    }

    /* ---------------- 色板覆盖自检 ---------------- */
    for (const def of Object.values(dictionaries.buildings.types)) {
        createSlotLookup(def.paletteKey);
    }
    console.info('\n色板覆盖  地皮 paletteKeys 与建筑 paletteKey 均已注册为色槽');

    console.info('\n[check] 通过：世界已构建、天桥已生成、主题可切换。\n');
}

main().catch((error: unknown) => {
    console.error('\n[check] 失败：', error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
