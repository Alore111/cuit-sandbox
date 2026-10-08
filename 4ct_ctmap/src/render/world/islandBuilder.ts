/* ================================================================
   悬空小岛的岛体：岛面以下的岩体 + 挂在岛下的碎岩与云霭
   —— 岛面轮廓与地表铺装不在这里（见 rasterize / terrainBuilder），本文件只管「岛面之下」。

   【做法：一张深度场 + 一层表面壳】
   岛面以下 200 层，逐层填实心是百万级体素；而从外面永远只能看到表面，
   因此岛体只发**一层表面壳**。表面壳由一张深度场描述：
       depthOf(格) = 该格的岩面在岛面以下第几层（1 = 紧贴岛面）
   于是「这一格在第 L 层是否存在」= depthOf(格) <= L（L 越大越深）。

   发射规则只有两条：
     1) 每格发自己岩面那一片；
     2) 若某个相邻格比它深 2 层以上，就沿这个落差竖直补一段岩壁
        （补在浅的那一格上，一直补到深的那一格的层数）。
   相邻只差 1 层时不必补：体素的斜对角接触已经封住射线了。
   实测岛体二十多万体素 —— 平滑处每格只发一片，只有落差处才补壁。

   【深度场 = 主轮廓 + 扇区棱面 + 崩口 + 岩根】
     · 层次感：主轮廓按幂曲线收束（上段近垂直、下段收得快），并在**每个岩层底界留一圈平台**。
       悬崖 → 平台 → 悬崖，配上岩层的配色带，就是一圈圈同心岩台的千层岩。
     · 破碎感：扇区棱面 —— 以锥轴为中心切若干扇区，每个扇区带一个持久偏移
       （按深度分段重掷、段内线性过渡），回转对称被打破，岩壁变成一块块折面；
       崩口 —— 几处「扇区 × 深度」窗口整体下沉，局部岩体像被削掉一大块。
     · 梦幻感：岩根 —— 锥底不收成一个尖，而是按齿状下沉、长短不一，像被连根拔起；
       再加岛底云霭与碎岩的极慢漂移（见本文件后半段）。

   【与数据的口径】
     · island.rockLayers：岩层数、每层配色带、每一圈大平台落在第几层，全部由它决定；
       它的总厚度仍是岛体总深（相机取景也跟着它走）。
     · island.debris：数据只给「方位 + 深度 + 大小」，水平落点由渲染层贴着当前剖面现算
       —— 剖面改了不必重算数据，数据也不必再假设某一条剖面曲线。
================================================================ */

import * as THREE from 'three';
import type { Island, IslandDebris, IslandRimProp } from '../../contract';
import type { ThemeName } from '../../types/theme';
import type { RenderWarning } from '../../types/world';
import type { GridSystem } from '../../utils/geo';
import {
    ISLAND_BODY,
    ISLAND_CONE_EXPONENT,
    ISLAND_DRIFT,
    ISLAND_MIST,
    metersToVoxels
} from '../constants';
import { HOT_LOOP_SPAN, type Slicer } from '../scheduler';
import { resolveThemeConfig, createSlotLookup, type GlobalColorKey, type ThemeConfig } from '../theme/palette';
import { createVoxelMesh } from '../voxel/buildVoxelMesh';
import { hash2, seededRandom } from '../voxel/random';
import { VoxelModel } from '../voxel/VoxelModel';
import { distanceToIslandEdge } from './rasterize';

/** 岛缘小建筑借用建筑配色组里的这一组（亭/塔的墙、顶、檐口都从它取色） */
const RIM_PROP_PALETTE_KEY = 'generic';

/** 岛下碎岩的配色（岩块本体；土色留给岩层，岩块只用石的几档） */
const DEBRIS_ROCK_KEYS: readonly GlobalColorKey[] = ['rock', 'rockHi', 'rockDeep'];

/** 棱面、崩口、岩根一律按固定种子生成：每次打开形状必须完全一致 */
const ISLAND_SEED = 0x1549;

/** 碎岩贴着岩面外侧再让开的净距（格）：既不相交，也读得出「刚从岩壁上剥落」 */
const DEBRIS_GAP_CELLS = 1;

/** 亭：方形台基 + 四角立柱 + 攒尖顶 */
const PAVILION = {
    baseMeters: 10,
    pillarHeightMeters: 4,
    /** 屋面比台基外扩（出檐） */
    eaveOverhangMeters: 2
};

/** 塔：方形台基 + 塔身（隔层带一圈窗）+ 塔刹 */
const TOWER = {
    baseMeters: 6,
    shaftHeightMeters: 12
};

export interface IslandInput {
    grid: GridSystem;
    /** 岛面格掩码（与地表共用同一份） */
    mask: Uint8Array;
    island: Island;
    theme: ThemeName;
    reducedMotion: boolean;
}

export interface IslandHandle {
    group: THREE.Group;
    /** 岛体（表面壳 + 碎岩）体素数 */
    voxelCount: number;
    rimPropCount: number;
    debrisCount: number;
    warnings: RenderWarning[];
    applyTheme: (themeOrConfig: ThemeName | ThemeConfig) => void;
    /** 每帧推进：碎岩与云霭的极慢漂移（reducedMotion 下不动） */
    update: (dt: number) => void;
    dispose: () => void;
}

/* ----------------------------------------------------------------
   1. 深度场：岛面以下「每格的岩面在第几层」
---------------------------------------------------------------- */

/** 一圈岩层平台：在第 level 层的底界向外留 cells 格宽的水平岩台 */
interface Shelf {
    level: number;
    cells: number;
}

/** 岩层计划：逐层色键 + 各圈平台 */
interface Strata {
    keyByDepth: GlobalColorKey[];
    shelves: Shelf[];
}

/**
 * 把数据里的岩层展开成「逐层色键」，并定出各圈平台落在哪一层。
 * —— 岩层底界各留一圈大平台（层次感的主骨架）；厚岩层内部再插一圈次级平台，
 *    否则一层几万体素读下来就是一块整料，看不到「层」。
 */
function planStrata(layers: Island['rockLayers'], voxelMeters: number, coneLevels: number): Strata {
    const keyByDepth: GlobalColorKey[] = [];
    const boundaries: number[] = [];

    for (const layer of layers) {
        const cells = Math.max(1, Math.round(layer.thicknessMeters / voxelMeters));
        for (let i = 0; i < cells; i += 1) keyByDepth.push(layer.paletteKey as GlobalColorKey);
        boundaries.push(keyByDepth.length);
    }

    const major = metersToVoxels(ISLAND_BODY.layerShelfMeters, voxelMeters);
    const shelves: Shelf[] = [];

    /* 最底层的底界不留平台：那是锥底，岩根从那里垂下 */
    for (const level of boundaries.slice(0, -1)) {
        if (level < coneLevels) shelves.push({ level, cells: major });
    }

    const spacing = Math.max(2, metersToVoxels(ISLAND_BODY.minorShelfSpacingMeters, voxelMeters));
    const minor = metersToVoxels(ISLAND_BODY.minorShelfMeters, voxelMeters);
    for (let level = spacing; level < coneLevels; level += spacing) {
        if (shelves.some((shelf) => Math.abs(shelf.level - level) < spacing / 2)) continue;
        shelves.push({ level, cells: minor });
    }

    shelves.sort((a, b) => a.level - b.level);
    return { keyByDepth, shelves };
}

/** 主轮廓：岛缘距离 → 岩面层号的反表 */
interface Profile {
    /** levelByDist[d] = 岛缘距离为 d 的格子落在第几层（1 起） */
    levelByDist: Int16Array;
    /** 锥底的起始距离：距离大于等于它的格子属于锥底（岩根段） */
    tipStart: number;
}

/**
 * 主轮廓：幂曲线决定整体收束，平台在层号上是**跳变** ——
 * 一层的距离区间被撑宽几格，那几格就落在同一层上，读出来是一圈水平岩台。
 */
function buildProfile(
    maxDist: number,
    coneLevels: number,
    strata: Strata,
    voxelMeters: number
): Profile {
    const tipReserve = metersToVoxels(ISLAND_BODY.tipReserveMeters, voxelMeters);
    const shelfCells = strata.shelves.reduce((sum, shelf) => sum + shelf.cells, 0);
    const span = maxDist - tipReserve - shelfCells;

    if (span < 1) {
        throw new Error(
            `岛体主轮廓放不下：岛缘最大间距 ${maxDist} 格，要留锥底 ${tipReserve} 格 + 岩层平台 ${shelfCells} 格。` +
                `请调小 ISLAND_BODY 的 layerShelfMeters / minorShelfMeters，或减少岩层数。`
        );
    }

    /**
     * 第 level 层的内边界（岛缘距离，格）；超过 coneLevels 表示主轮廓已经收完。
     * 下限取 1 格：收进量四舍五入到 0 会让上段几十层挤在同一个距离上，
     * 岛面边缘就会与地表脱空（岩壁整段丢失）。留 1 格后，这几层叠成一堵竖直的岛缘崖壁。
     */
    const insetOf = (level: number): number => {
        if (level <= 0) return 0;
        if (level > coneLevels) return maxDist + 1;
        const curve = span * Math.pow(level / coneLevels, ISLAND_CONE_EXPONENT);
        let shelves = 0;
        for (const shelf of strata.shelves) {
            if (shelf.level <= level) shelves += shelf.cells;
        }
        return Math.min(maxDist, Math.max(1, Math.round(curve) + shelves));
    };

    /**
     * 反表：距离 d 的格子落在**最浅**的那一层上。
     * 上限用 max(lo + 1, …)：收进量不变时至少撑住一圈，否则那一层会一个格子都不剩。
     */
    const levelByDist = new Int16Array(maxDist + 2);
    for (let level = 1; level <= coneLevels; level += 1) {
        const lo = insetOf(level);
        const hi = Math.max(lo + 1, insetOf(level + 1));
        for (let d = lo; d < hi && d <= maxDist; d += 1) {
            if (levelByDist[d] === 0) levelByDist[d] = level;
        }
    }

    /* 最后一个内边界之内：锥底。它是一圈「浅平台」，岩根从这里往下垂 */
    const tipStart = insetOf(coneLevels);
    for (let d = tipStart; d <= maxDist; d += 1) {
        if (levelByDist[d] === 0) levelByDist[d] = coneLevels;
    }

    return { levelByDist, tipStart };
}

/** 崩口：一处「扇区 × 深度」窗口 */
interface Notch {
    /** 起始扇区（窗口按扇区环绕） */
    sector: number;
    /** 起始层号 */
    level: number;
}

/** 岩根齿列：锥底沿长边切成一排齿，齿长不一 */
interface RootPlan {
    /** 齿沿哪条轴排（锥底长边的方向） */
    along: 'x' | 'z';
    /** 齿的起点（长轴格坐标） */
    origin: number;
    /** 齿距（格） */
    spacing: number;
    /** 每颗齿的下垂长度（层） */
    lengths: number[];
}

export interface IslandBodyField {
    /** 每格的岩面层号（1..depth）；岛外为 0 */
    depthOf: Int16Array;
    /** 每格岩体的最下一层（含为落差补的岩壁）；岛外为 0 */
    topOf: Int16Array;
    /** 岛体总层数 */
    depth: number;
    /** 锥轴：岛缘距离场最深的那一格（扇区棱面与岩根都以它为中心） */
    axis: { x: number; z: number };
    /** 逐层色键（长度 = 总层数） */
    keyByDepth: GlobalColorKey[];
}

/** 水平方位 → 扇区号（以锥轴为中心，逆时针从 +x 起算） */
function sectorOf(x: number, z: number, axis: { x: number; z: number }, sectors: number): number {
    const angle = Math.atan2(z - axis.z, x - axis.x);
    const unit = (angle / (Math.PI * 2) + 0.5) % 1;
    return Math.min(sectors - 1, Math.floor(unit * sectors));
}

/** 某个扇区在某一段深度上的棱面偏移（层） */
function facetBandOffset(sector: number, band: number): number {
    return (hash2(sector * 41 + 7, band * 53 + 13) - 0.5) * 2 * ISLAND_BODY.facetLevels;
}

/**
 * 扇区棱面偏移（层）。
 * 同一扇区、同一深度段内共用一个偏移，段与段之间线性过渡 ——
 * 段内过渡不产生落差，因此不需要竖直补壁；落差只留在**扇区之间**，
 * 那正是「一块块折面」的来源。
 *
 * 幅度按深度爬升：岛缘那一圈不留落差。岛缘的崖壁本来就靠「收进量不变的那几层
 * 叠成一堵墙」来成立，在这里落一个落差会在墙上开出口子 —— 壳就不封闭了。
 */
function facetOffset(sector: number, baseLevel: number): number {
    const refresh = ISLAND_BODY.facetRefreshLevels;
    const band = Math.floor(baseLevel / refresh);
    const t = (baseLevel % refresh) / refresh;
    const from = facetBandOffset(sector, band);
    const to = facetBandOffset(sector, band + 1);
    const ramp = Math.min(1, baseLevel / ISLAND_BODY.facetRampLevels);
    return Math.round((from + (to - from) * t) * ramp);
}

function notchOffset(sector: number, baseLevel: number, notches: Notch[], sectors: number): number {
    for (const notch of notches) {
        const distance = (sector - notch.sector + sectors) % sectors;
        if (distance >= ISLAND_BODY.notchSpanSectors) continue;
        if (baseLevel < notch.level) continue;
        if (baseLevel >= notch.level + ISLAND_BODY.notchSpanLevels) continue;
        return ISLAND_BODY.notchLevels;
    }
    return 0;
}

/** 岩根：齿心最深、齿端回到锥底，一颗齿就是一个楔形 */
function rootOffset(vx: number, vz: number, baseLevel: number, coneLevels: number, roots: RootPlan): number {
    if (baseLevel < coneLevels) return 0;

    const along = roots.along === 'x' ? vx : vz;
    const at = (along - roots.origin) / roots.spacing;
    const index = Math.floor(at);
    if (index < 0 || index >= roots.lengths.length) return 0;

    const taper = 1 - Math.abs((at - index) * 2 - 1);
    return Math.round(roots.lengths[index] * taper);
}

async function buildBodyField(input: IslandInput, slicer: Slicer): Promise<IslandBodyField> {
    const { grid, mask, island } = input;
    const { width, height, voxelMeters } = grid;

    /* 岛缘距离场：岛缘格为 1，越往里越大；最深的那一格就是锥轴 */
    const dist = await distanceToIslandEdge(mask, width, height, slicer);
    let maxDist = 0;
    let axisAt = 0;
    for (let i = 0; i < mask.length; i += 1) {
        if (slicer.shouldYield(HOT_LOOP_SPAN)) await slicer.yield();
        if (mask[i] === 0 || dist[i] <= maxDist) continue;
        maxDist = dist[i];
        axisAt = i;
    }
    const axisVx = axisAt % width;
    const axis = { x: axisVx + 0.5, z: (axisAt - axisVx) / width + 0.5 };

    const depth = Math.max(
        1,
        Math.round(
            island.rockLayers.reduce((sum, layer) => sum + layer.thicknessMeters, 0) / voxelMeters
        )
    );
    const coneLevels = Math.min(depth, Math.max(1, Math.round(depth * ISLAND_BODY.coneClosureRatio)));

    const strata = planStrata(island.rockLayers, voxelMeters, coneLevels);
    const profile = buildProfile(maxDist, coneLevels, strata, voxelMeters);

    const sectors = ISLAND_BODY.facetSectors;
    const notchLayout = seededRandom(ISLAND_SEED);
    const notches: Notch[] = [];
    for (let i = 0; i < ISLAND_BODY.notchCount; i += 1) {
        notches.push({
            sector: Math.floor(notchLayout() * sectors),
            /* 崩口只落在主轮廓的中上段：锥底那点体量，崩没了就断根了 */
            level: Math.round(coneLevels * (0.12 + notchLayout() * 0.68))
        });
    }
    const roots = planRoots(mask, dist, width, profile.tipStart, voxelMeters);

    /* 逐格叠成深度场：主轮廓 → 棱面 → 崩口 → 岩根 */
    const depthOf = new Int16Array(mask.length);
    for (let i = 0; i < mask.length; i += 1) {
        /* 这一格要算一次 atan2（sectorOf）+ 三次哈希查表，属热循环：隔 span 次再读时钟 */
        if (slicer.shouldYield(HOT_LOOP_SPAN)) await slicer.yield();
        if (mask[i] === 0) continue;
        const vx = i % width;
        const vz = (i - vx) / width;

        const base = profile.levelByDist[Math.min(dist[i], maxDist)];
        const sector = sectorOf(vx + 0.5, vz + 0.5, axis, sectors);
        const offset =
            facetOffset(sector, base) +
            notchOffset(sector, base, notches, sectors) +
            rootOffset(vx, vz, base, coneLevels, roots);

        depthOf[i] = Math.min(depth, Math.max(1, base + offset));
    }

    /*
     * 每个格子的岩体下沿：邻居比它深 2 层以上时要竖直补一段岩壁（补到邻居的岩面），
     * 差 1 层不用补 —— 体素的斜对角接触已经封住射线了。
     * 这一步同时决定体素量：平滑处每格只发一片，只有落差处才补。
     */
    const topOf = new Int16Array(mask.length);
    for (let vz = 0; vz < height; vz += 1) {
        for (let vx = 0; vx < width; vx += 1) {
            const at = vz * width + vx;
            const surface = depthOf[at];
            if (surface === 0) continue;

            let deepest = surface;
            if (vx > 0 && depthOf[at - 1] > deepest) deepest = depthOf[at - 1];
            if (vx < width - 1 && depthOf[at + 1] > deepest) deepest = depthOf[at + 1];
            if (vz > 0 && depthOf[at - width] > deepest) deepest = depthOf[at - width];
            if (vz < height - 1 && depthOf[at + width] > deepest) deepest = depthOf[at + width];

            topOf[at] = deepest >= surface + 2 ? deepest : surface;
        }
        if (slicer.shouldYield()) await slicer.yield();
    }

    return { depthOf, topOf, depth, axis, keyByDepth: strata.keyByDepth };
}

/**
 * 岩根齿列：锥底（岛缘距离超过 tipStart 的那一片）沿**长边**切成一排齿。
 * 齿长在最短与最长之间按哈希取，因此每颗齿长短不一 —— 这就是「连根拔起」的读法来源。
 */
function planRoots(
    mask: Uint8Array,
    dist: Uint16Array,
    width: number,
    tipStart: number,
    voxelMeters: number
): RootPlan {
    let minVx = Infinity;
    let maxVx = -Infinity;
    let minVz = Infinity;
    let maxVz = -Infinity;

    for (let i = 0; i < mask.length; i += 1) {
        if (mask[i] === 0 || dist[i] < tipStart) continue;
        const vx = i % width;
        const vz = (i - vx) / width;
        minVx = Math.min(minVx, vx);
        maxVx = Math.max(maxVx, vx);
        minVz = Math.min(minVz, vz);
        maxVz = Math.max(maxVz, vz);
    }

    const along: 'x' | 'z' = maxVx - minVx >= maxVz - minVz ? 'x' : 'z';
    const origin = along === 'x' ? minVx : minVz;
    const extent = (along === 'x' ? maxVx - minVx : maxVz - minVz) + 1;

    const spacing = Math.max(2, metersToVoxels(ISLAND_BODY.rootSpacingMeters, voxelMeters));
    const count = Math.max(1, Math.round(extent / spacing));
    const [shortest, longest] = ISLAND_BODY.rootLengthLevels;
    const layout = seededRandom(ISLAND_SEED ^ 0x2f19);
    const lengths: number[] = [];
    for (let i = 0; i < count; i += 1) {
        lengths.push(Math.round(shortest + layout() * (longest - shortest)));
    }

    return { along, origin, spacing, lengths };
}

/* ----------------------------------------------------------------
   2. 表面壳
---------------------------------------------------------------- */

/**
 * 把深度场发射成一圈表面壳：每格发 [岩面, 岩体下沿] 这一段。
 * 平滑处这一段只有一格，落差处（平台、棱面、崩口、岩根）才补成一段岩壁。
 *
 * 【性能排查 · 临时】随岛体一起停用（原因见 buildIsland 第 1 步的说明）。
 * 恢复岛体：把本段注释去掉，并把 buildIsland 里 emitShell 的调用一起放开。
 *
 * 这是全流程体素量最大的一步（三十多万格，落差处还要一格一格补壁），
 * 因此按扫描行让出主线程。
 */
async function emitShell(
    model: VoxelModel,
    field: IslandBodyField,
    grid: GridSystem,
    slicer: Slicer
): Promise<void> {
    const { width, height } = grid;
    const { depthOf, topOf, keyByDepth } = field;

    for (let vz = 0; vz < height; vz += 1) {
        for (let vx = 0; vx < width; vx += 1) {
            const at = vz * width + vx;
            const surface = depthOf[at];
            if (surface === 0) continue;

            for (let level = surface; level <= topOf[at]; level += 1) {
                model.set(vx, -level, vz, keyByDepth[level - 1]);
            }
        }
        if (slicer.shouldYield()) await slicer.yield();
    }
}

/* ----------------------------------------------------------------
   3. 岛下碎岩：数据给方位与深度，落点贴着岩面现算
---------------------------------------------------------------- */

/**
 * 沿「锥轴 → 目标方位」的射线，找岩面最接近目标深度的那一格 —— 碎岩与云霭贴的就是它。
 *
 * 【为什么不直接取「正好等于目标深度」的那一格】扇区棱面与崩口本就会把岩壁推移几层，
 * 同一条记录深度在某些方位上恰好没有岩体。取最近的岩面既不会挂空，
 * 也仍然守着数据的本意：方位照用，深度用岩壁的实际深度。
 */
function nearestWallAlong(
    field: IslandBodyField,
    grid: GridSystem,
    dirX: number,
    dirZ: number,
    level: number
): { vx: number; vz: number; surface: number; t: number } | null {
    const reach = Math.ceil(Math.hypot(grid.width, grid.height));
    let best: { vx: number; vz: number; surface: number; t: number } | null = null;
    let bestGap = Infinity;

    /* 半步取样：一层岩壁在「到岛缘的距离」上只有一两格厚，整步取样会跨过去 */
    for (let step = 2; step <= reach * 2; step += 1) {
        const t = step / 2;
        const vx = Math.round(field.axis.x + dirX * t);
        const vz = Math.round(field.axis.z + dirZ * t);
        if (vx < 0 || vz < 0 || vx >= grid.width || vz >= grid.height) break;

        const at = vz * grid.width + vx;
        const surface = field.depthOf[at];
        if (surface === 0) continue;

        const gap = Math.abs(surface - level);
        if (gap >= bestGap) continue;
        bestGap = gap;
        best = { vx, vz, surface, t };
    }

    return best;
}

/* ----------------------------------------------------------------
   4. 岛缘小建筑：亭 / 塔
---------------------------------------------------------------- */

/** 小建筑要对称，偶数格会让中轴偏心一格，因此向上取奇数 */
function oddCells(meters: number, voxelMeters: number): number {
    const cells = Math.max(3, metersToVoxels(meters, voxelMeters));
    return cells % 2 === 0 ? cells + 1 : cells;
}

/** 亭：台基 + 四角立柱 + 逐层收进的攒尖顶 */
function stampPavilion(model: VoxelModel, cx: number, cz: number, voxelMeters: number): void {
    const base = oddCells(PAVILION.baseMeters, voxelMeters);
    const half = (base - 1) / 2;
    const pillarTop = 1 + metersToVoxels(PAVILION.pillarHeightMeters, voxelMeters);

    model.box(cx - half, 1, cz - half, cx + half, 1, cz + half, 'plinth');

    for (const dx of [-half, half]) {
        for (const dz of [-half, half]) {
            model.box(cx + dx, 2, cz + dz, cx + dx, pillarTop, cz + dz, 'wall');
        }
    }

    const eaveHalf = half + metersToVoxels(PAVILION.eaveOverhangMeters, voxelMeters);
    for (let h = eaveHalf; h >= 0; h--) {
        const y = pillarTop + 1 + (eaveHalf - h);
        model.box(cx - h, y, cz - h, cx + h, y, cz + h, h === 0 ? 'trim' : 'roof');
    }
}

/** 塔：台基 + 塔身（隔层带一圈窗）+ 塔刹 */
function stampTower(model: VoxelModel, cx: number, cz: number, voxelMeters: number): void {
    const base = oddCells(TOWER.baseMeters, voxelMeters);
    const half = (base - 1) / 2;
    const shaftTop = 1 + metersToVoxels(TOWER.shaftHeightMeters, voxelMeters);

    model.box(cx - half, 1, cz - half, cx + half, 1, cz + half, 'plinth');

    for (let y = 2; y <= shaftTop; y++) {
        const band = (y - 2) % 2 === 1;
        for (let dx = -half; dx <= half; dx++) {
            for (let dz = -half; dz <= half; dz++) {
                const isEdge = Math.abs(dx) === half || Math.abs(dz) === half;
                model.set(cx + dx, y, cz + dz, band && isEdge ? 'glass' : 'wall');
            }
        }
    }

    let y = shaftTop + 1;
    for (let h = half; h >= 0; h--) {
        for (let dx = -h; dx <= h; dx++) {
            for (let dz = -h; dz <= h; dz++) {
                model.set(cx + dx, y, cz + dz, h === 0 ? 'gold' : 'roof');
            }
        }
    }
}

/** 按 kind 分发到具体形制（kind 已由后端校验，这里只做穷尽分派） */
function stampRimProp(
    model: VoxelModel,
    prop: IslandRimProp,
    at: { vx: number; vz: number },
    voxelMeters: number
): void {
    if (prop.kind === 'pavilion') {
        stampPavilion(model, at.vx, at.vz, voxelMeters);
        return;
    }
    stampTower(model, at.vx, at.vz, voxelMeters);
}

/* ----------------------------------------------------------------
   5. 碎岩本体
---------------------------------------------------------------- */

/** 碎岩：立方体削掉 12 条棱，得到一块带棱角的岩块；顶面覆土，读起来像「被连根拔起的石头」 */
function stampDebris(
    model: VoxelModel,
    item: IslandDebris,
    at: { vx: number; vz: number; depthCells: number },
    voxelMeters: number
): void {
    const size = oddCells(item.sizeMeters, voxelMeters);
    const half = (size - 1) / 2;
    const depthCells = at.depthCells;
    const bodyKey =
        DEBRIS_ROCK_KEYS[Math.floor(hash2(at.vx + depthCells, at.vz) * DEBRIS_ROCK_KEYS.length)];

    for (let dx = -half; dx <= half; dx++) {
        for (let dy = -half; dy <= half; dy++) {
            for (let dz = -half; dz <= half; dz++) {
                const edgeX = Math.abs(dx) === half;
                const edgeY = Math.abs(dy) === half;
                const edgeZ = Math.abs(dz) === half;
                /* 同时贴在两个相对面上 = 立方体的棱，削掉棱角才有石头的形 */
                if ((edgeX && edgeY) || (edgeX && edgeZ) || (edgeY && edgeZ)) continue;

                const key = edgeY && dy > 0 ? 'soil' : bodyKey;
                model.set(at.vx + dx, -depthCells + dy, at.vz + dz, key);
            }
        }
    }
}

/* ----------------------------------------------------------------
   6. 岛底云霭
---------------------------------------------------------------- */

interface Mist {
    mesh: THREE.InstancedMesh;
    material: THREE.MeshBasicMaterial;
}

/**
 * 岛底云霭：围着岛体下段挂一圈半透明的云团（体素块拼成，与天空的云同一个读法）。
 * 它的作用是**柔化锥底** —— 视线不会钉在岩根尖上，岛底消散在雾里。
 */
function buildMist(field: IslandBodyField, grid: GridSystem): Mist {
    const layout = seededRandom(ISLAND_SEED ^ 0x51f7);
    const blockCells = metersToVoxels(ISLAND_MIST.blockMeters, grid.voxelMeters);
    const spread = blockCells * ISLAND_MIST.spreadFactor;
    const flatten = blockCells * ISLAND_MIST.flattenFactor;
    const [minGap, maxGap] = ISLAND_MIST.gapMeters;
    const [minBlocks, maxBlocks] = ISLAND_MIST.blocks;
    const [minDepth, maxDepth] = ISLAND_MIST.depthRatio;
    const blocks: { x: number; y: number; z: number }[] = [];

    for (let i = 0; i < ISLAND_MIST.count; i += 1) {
        const angle = (i / ISLAND_MIST.count) * Math.PI * 2 + (layout() - 0.5) * 0.6;
        const dirX = Math.cos(angle);
        const dirZ = Math.sin(angle);
        const level = Math.round((minDepth + layout() * (maxDepth - minDepth)) * field.depth);

        const wall = nearestWallAlong(field, grid, dirX, dirZ, level);
        if (!wall) continue;

        const gap = (minGap + layout() * (maxGap - minGap)) / grid.voxelMeters;
        const cx = field.axis.x + dirX * (wall.t + gap);
        const cz = field.axis.z + dirZ * (wall.t + gap);

        /* 团内的块互相压叠（散布半径 < 块边长），叠成一团软雾而不是一堆浮冰 */
        const count = minBlocks + Math.floor(layout() * (maxBlocks - minBlocks + 1));
        for (let b = 0; b < count; b += 1) {
            blocks.push({
                x: cx + (layout() - 0.5) * 2 * spread,
                y: -wall.surface + (layout() - 0.5) * 2 * flatten,
                z: cz + (layout() - 0.5) * 2 * spread
            });
        }
    }

    const material = new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false
    });
    const geometry = new THREE.BoxGeometry(blockCells, blockCells, blockCells);
    const mesh = new THREE.InstancedMesh(geometry, material, blocks.length);
    mesh.name = 'islandMist';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;

    /* 矩阵按「相对锥轴」写：整个云霭组挂在锥轴上，转起来就是绕岛自转 */
    const dummy = new THREE.Object3D();
    for (let i = 0; i < blocks.length; i += 1) {
        const block = blocks[i];
        dummy.position.set(block.x - field.axis.x, block.y, block.z - field.axis.z);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;

    return { mesh, material };
}

/* ----------------------------------------------------------------
   7. 装配
---------------------------------------------------------------- */

export async function buildIsland(input: IslandInput, slicer: Slicer): Promise<IslandHandle> {
    const { grid, mask, island, theme, reducedMotion } = input;
    const { voxelMeters } = grid;
    const warnings: RenderWarning[] = [];

    /* ---------- 1. 深度场 + 岛体表面壳 ---------- */
    const field = await buildBodyField(input, slicer);
    const body = new VoxelModel();
    /* 【性能排查 · 临时】岛体表面壳停发（岛面以下的岩层 / 扇区棱面 / 崩口 / 岩根）。
       它是几何量的绝对大头（约 33 万体素 = 每体素一个完整立方体 ≈ 400 万三角形），
       先整块不发射，用来验证「岛体是不是 GPU 占用的主因」。
       恢复岛体：把下面这行 emitShell 的注释去掉即可。 */
    await emitShell(body, field, grid, slicer);

    /* ---------- 2. 岛下碎岩：贴着岩面外面挂 ---------- */
    const debris = new VoxelModel();
    let debrisCount = 0;
    for (const item of island.debris) {
        const point = grid.lonLatToVoxel(item.lat, item.lon);
        const dx = point.vx - field.axis.x;
        const dz = point.vz - field.axis.z;
        const distance = Math.hypot(dx, dz);

        if (distance < 1) {
            warnings.push({
                id: item.id,
                kind: 'island',
                name: `碎岩 ${item.id}`,
                reason: '落点与锥轴重合，方位无法确定，未参与渲染'
            });
            continue;
        }

        const level = Math.min(
            field.depth,
            Math.max(1, Math.round(item.depthMeters / voxelMeters))
        );
        const dirX = dx / distance;
        const dirZ = dz / distance;
        const wall = nearestWallAlong(field, grid, dirX, dirZ, level);

        if (!wall) {
            warnings.push({
                id: item.id,
                kind: 'island',
                name: `碎岩 ${item.id}`,
                reason: `深 ${item.depthMeters} m 处该方位上没有岩体，未参与渲染`
            });
            continue;
        }

        /* 让开自身半径：岩块刚好漂在岩壁之外，不插进岩体里 */
        const standoff = Math.floor(oddCells(item.sizeMeters, voxelMeters) / 2) + DEBRIS_GAP_CELLS;
        const vx = Math.round(field.axis.x + dirX * (wall.t + standoff));
        const vz = Math.round(field.axis.z + dirZ * (wall.t + standoff));

        if (vx < 0 || vz < 0 || vx >= grid.width || vz >= grid.height) {
            warnings.push({
                id: item.id,
                kind: 'island',
                name: `碎岩 ${item.id}`,
                reason: '沿该方位让开自身半径后落到了网格之外，未参与渲染'
            });
            continue;
        }

        /* 深度用岩壁的实际深度：岩块与岩面齐平，才读得出「刚从岩壁上剥落」 */
        stampDebris(debris, item, { vx, vz, depthCells: wall.surface }, voxelMeters);
        debrisCount += 1;
        if (slicer.shouldYield()) await slicer.yield();
    }

    /* ---------- 3. 岛缘小建筑 ---------- */
    const props = new VoxelModel();
    let rimPropCount = 0;
    for (const item of island.rimProps) {
        const point = grid.lonLatToVoxel(item.lat, item.lon);
        const vx = Math.round(point.vx);
        const vz = Math.round(point.vz);
        if (vx < 0 || vz < 0 || vx >= grid.width || vz >= grid.height || mask[vz * grid.width + vx] === 0) {
            warnings.push({
                id: item.id,
                kind: 'island',
                name: `岛缘小建筑 ${item.id}（${item.kind}）`,
                reason: '落点不在岛面内，悬空的小建筑无法成立，未参与渲染'
            });
            continue;
        }
        stampRimProp(props, item, { vx, vz }, voxelMeters);
        rimPropCount += 1;
        if (slicer.shouldYield()) await slicer.yield();
    }

    /* ---------- 4. 装配 ---------- */
    const baseLookup = createSlotLookup(RIM_PROP_PALETTE_KEY);
    const material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.86,
        metalness: 0.02,
        flatShading: true
    });
    /* 岛体不投影：它体量最大、又在场景底部，自投影看不出收益，代价却翻倍 */
    const bodyMesh = await createVoxelMesh(await body.toArray(slicer), material, baseLookup, slicer, {
        castShadow: false
    });
    bodyMesh.mesh.name = 'islandBody';
    const debrisMesh = await createVoxelMesh(await debris.toArray(slicer), material, baseLookup, slicer, {
        castShadow: false
    });
    debrisMesh.mesh.name = 'islandDebris';
    const propMesh = await createVoxelMesh(await props.toArray(slicer), material, baseLookup, slicer, {
        castShadow: true
    });
    propMesh.mesh.name = 'islandRimProps';

    /* 碎岩与云霭挂在锥轴上：转这个组就是绕岛自转，岛面与岩体不动 */
    const mist = buildMist(field, grid);
    const drift = new THREE.Group();
    drift.name = 'islandDrift';
    drift.position.set(field.axis.x, 0, field.axis.z);
    debrisMesh.mesh.position.set(-field.axis.x, 0, -field.axis.z);
    drift.add(debrisMesh.mesh, mist.mesh);

    const group = new THREE.Group();
    group.name = 'island';
    /* 【性能排查 · 临时】岛面以下整体不入场景：
       bodyMesh（岩体表面壳）与 drift（岛下碎岩 + 岛底云霭 —— 二者都挂在锥轴上、贴着岩面定位）
       一起停画；岩体没了，碎岩与云霭没有可依附的岩壁，留着只会浮在半空。
       岛缘小建筑（亭 / 塔）落在岛面上，照常保留。
       恢复岛体：把下面这行 group.add 的注释去掉，并删掉单加 propMesh 的那一行即可。 */
    group.add(bodyMesh.mesh, propMesh.mesh, drift);
    // group.add(propMesh.mesh);

    let driftTime = 0;
    const animate = !reducedMotion;

    function applyTheme(next: ThemeName | ThemeConfig): void {
        const config = resolveThemeConfig(next);

        mist.material.color.setHex(config.islandMist.color);
        mist.material.opacity = config.islandMist.opacity;
        mist.mesh.visible = config.islandMist.opacity > 0;
    }

    function update(dt: number): void {
        if (!animate) return;
        driftTime += dt;
        drift.rotation.y += ISLAND_DRIFT.spinSpeed * dt;
        drift.position.y = Math.sin(driftTime * ISLAND_DRIFT.bobSpeed) * ISLAND_DRIFT.bobCells;
    }

    function dispose(): void {
        material.dispose();
        mist.material.dispose();
        mist.mesh.geometry.dispose();
    }

    applyTheme(theme);

    return {
        group,
        voxelCount: body.size + debris.size,
        rimPropCount,
        debrisCount,
        warnings,
        applyTheme,
        update,
        dispose
    };
}
