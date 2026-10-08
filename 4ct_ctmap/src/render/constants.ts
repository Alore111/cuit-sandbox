/* ================================================================
   渲染层常量
   —— 【口径】所有「质感参数」一律以米定义，运行时按 school.voxelMeters 折算成格数。
      这样改分辨率（2m → 3m → 1.5m）只需要改数据里的 voxelMeters，
      这里一个数字都不用动，观感也不会跟着分辨率漂。

   米值是按「DEMO 在 3m 下的实际效果」反推的（例如 DEMO 的 SOIL_DEPTH = 2 层 × 3m = 6m），
   目的是换分辨率只提细、不改观感，而不是趁机重新设计质感。
================================================================ */

/** 以米定义的质感参数 */
export const RENDER_METERS = {
    /** 板楼窗带的竖向间隔 */
    windowBandInterval: 6,
    /** 树冠常规高度 */
    canopyHeight: 3,
    /** 树冠高树阈值：哈希超过阈值时再抬一层 */
    canopyTallHeight: 6,
    /** 小于此占地面积的建筑不建模 */
    minFootprintAreaM2: 27
} as const;

/**
 * 主轮廓剖面指数。
 * —— 岛面之下第 y 层（占总深 y/D）的**收进量** = 主轮廓跨度 × (y/D)^指数。
 *    指数 = 1 是直锥（上段就开始明显内收）；指数 > 1 时上段收得慢、下段收得快，
 *    得到「上段近乎垂直的岛壁 + 下段收得快」的悬浮岛形；取 2 时上段崖壁约 45° 倾角。
 *    岩体的总深不在这里 —— 它由数据里的 island.rockLayers 厚度之和决定。
 */
export const ISLAND_CONE_EXPONENT = 2;

/* ----------------------------------------------------------------
   岛体（岛面以下）：层次感 / 破碎感 / 梦幻感
   —— 【口径】尺寸一律以米给，运行时按 school.voxelMeters 折算；
      「层数 / 扇区数 / 格数」是计数，不折算。
      岩层数、每一层的配色、平台落在第几层，全部由数据 island.rockLayers 决定，
      这里只放「怎么把这些层叠出层次与破碎」的观感参数。
---------------------------------------------------------------- */

export const ISLAND_BODY = {
    /** 主轮廓收束用掉总深的比例：其余深度留给锥底之下的岩根 */
    coneClosureRatio: 0.78,
    /** 锥底停在离「岛缘距离场」峰值还差多少米处（越小锥底越尖、平台越窄） */
    tipReserveMeters: 12,
    /** 每个岩层底界留出的平台宽度（米）—— 层次感的主要来源 */
    layerShelfMeters: 10,
    /** 厚岩层内部再插一圈次级平台的间距与宽度（米） */
    minorShelfSpacingMeters: 100,
    minorShelfMeters: 6,
    /** 扇区棱面：扇区数 / 偏移幅度（层）/ 相位重掷间隔（层）/ 幅度爬到满的层数 */
    facetSectors: 18,
    facetLevels: 6,
    facetRefreshLevels: 14,
    facetRampLevels: 40,
    /** 崩口：处数 / 下沉幅度（层）/ 竖向跨度（层）/ 扇区跨度（个） */
    notchCount: 5,
    notchLevels: 24,
    notchSpanLevels: 40,
    notchSpanSectors: 3,
    /** 岩根：齿的间距（米）/ 最短与最长（层） */
    rootSpacingMeters: 26,
    rootLengthLevels: [16, 44]
} as const;

/** 岛底云霭：把锥底与岩根柔化掉，不让视线钉在一个尖上 */
export const ISLAND_MIST = {
    /** 云团团数 */
    count: 18,
    /** 云团所在深度占总深的比例区间（压在下半段，才够得着锥底与岩根） */
    depthRatio: [0.42, 0.8],
    /** 云团离岩壁的水平净距（米） */
    gapMeters: [15, 100],
    /** 每团的体素块数区间 */
    blocks: [8, 14] as const,
    /** 体素块边长（米） */
    blockMeters: 30,
    /**
     * 团内散布半径 = 块边长 × 该系数。
     * 必须小于 1 才互相压叠、糊成一团雾；大于 1 就散成一堆各自独立的方块。
     */
    spreadFactor: 0.8,
    /** 竖向压扁比例：云比块的高更扁，才不像浮冰 */
    flattenFactor: 0.3
} as const;

/** 岛下的微动效：碎岩与云霭绕锥轴极慢自转 + 上下浮动（reducedMotion 下完全静止） */
export const ISLAND_DRIFT = {
    /** 自转角速度（弧度/秒） */
    spinSpeed: 0.012,
    /** 上下浮动的幅度（格）与速率（弧度/秒） */
    bobCells: 1.2,
    bobSpeed: 0.28
} as const;

/* ----------------------------------------------------------------
   结构层数：构件计数，不是尺寸，因此不按米表达
   —— 台基 1 层 + 墙体至少 1 层 + 屋面 1 层 = 地面以上至少 3 层
---------------------------------------------------------------- */

export const PLINTH_LAYERS = 1;
export const ROOF_LAYERS = 1;
export const MIN_BODY_LAYERS = 1;
export const MIN_TOTAL_VOXELS = PLINTH_LAYERS + MIN_BODY_LAYERS + ROOF_LAYERS;

/** 拾取代理盒在足迹外再放宽的体素数（既把出檐盖进去，也让点击判定更宽容） */
export const PROXY_PADDING = 1;

/**
 * 屋面剖面（拱顶与双坡屋面共用）
 *
 * DEMO 的做法是「每抬一层就水平收一格」= 45° 直坡，大跨建筑会得到又高又陡的锥壳，而且没有出檐。
 * 这里拆成两个独立的口径：
 *
 * 1) 檐口附近收得多（缓）、越靠中心收得越少（陡）——
 *    收进量随「距檐口的距离」从 ROOF_EDGE_RUN 线性收到 1 格，
 *    于是剖面是「四周缓、中间陡」的穹形，而不是直坡；
 * 2) 屋面边缘比建筑轮廓外扩 ROOF_OVERHANG 格（出檐）。
 *
 * 【为什么不设「最大抬升」】剖面按距檐口的距离参数化，屋面会一路收到顶（不是按层数截断），
 * 因此总高度由剖面自然决定：檐口越缓，同样跨度下收顶用的层数越少、总高越低。
 */

/** 檐口附近每抬一层所收进的格数：越大檐口越缓（2.5 ≈「两三格抬升一个高度」，4 更缓） */
export const ROOF_EDGE_RUN = 4;

/** 屋面边缘外扩的体素数（出檐） */
export const ROOF_OVERHANG = 1;

/** 屋面收到顶后中心每抬一层收进的最少格数 —— 1 格即体素能达到的最陡（45°）。
 * 中心收得越少，穹顶越饱满；取 1 时不出现平顶。 */
export const ROOF_CENTER_RUN = 1;

/**
 * 屋面至少分几层收顶。
 * 檐口坡度过缓时，进深小的建筑会被一层收没、退化成平屋顶；
 * 用这条下限给它们自动换用更小的檐口收进量，保住坡屋顶的形态。
 */
export const ROOF_MIN_LAYERS = 4;

/** 本栋屋面实际可用的檐口收进量（进深小则自动收窄，见 ROOF_MIN_LAYERS） */
export function roofEdgeRunFor(reach: number): number {
    const allowed = Math.max(2, Math.floor(reach / ROOF_MIN_LAYERS));
    return Math.min(ROOF_EDGE_RUN, allowed);
}

/**
 * 距檐口 distanceFromEave 格处，每抬一层应收进几格。
 * @param distanceFromEave 已经收进的水平距离（格）
 * @param reach 从檐口到中心的水平距离（格）
 * @param edgeRun 檐口处的收进量（由 roofEdgeRunFor 得出）
 */
export function roofInsetAt(distanceFromEave: number, reach: number, edgeRun: number): number {
    const t = reach <= 0 ? 1 : Math.min(1, distanceFromEave / reach);
    const run = edgeRun - (edgeRun - ROOF_CENTER_RUN) * t;
    return Math.max(ROOF_CENTER_RUN, Math.round(run));
}

/** 地平面层号：地表体素所在层，其上第一层是 y = 1，建筑与树冠都从这里起 */
export const GROUND_Y = 0;

/** 米 → 格：四舍五入，下限 1 格（0 格的构件等于不存在，不是我们想要的语义） */
export function metersToVoxels(meters: number, voxelMeters: number): number {
    return Math.max(1, Math.round(meters / voxelMeters));
}

/** 面积 → 格数：用于「最小占地」这类面积判据 */
export function areaToVoxelCells(areaM2: number, voxelMeters: number): number {
    return Math.max(1, Math.round(areaM2 / (voxelMeters * voxelMeters)));
}

/** 当前分辨率下实际使用的格数（每建一次世界算一遍） */
export interface DetailVoxels {
    windowBandInterval: number;
    canopyHeight: number;
    canopyTallHeight: number;
    minFootprintCells: number;
}

export function createDetailVoxels(voxelMeters: number): DetailVoxels {
    return {
        windowBandInterval: metersToVoxels(RENDER_METERS.windowBandInterval, voxelMeters),
        canopyHeight: metersToVoxels(RENDER_METERS.canopyHeight, voxelMeters),
        canopyTallHeight: metersToVoxels(RENDER_METERS.canopyTallHeight, voxelMeters),
        minFootprintCells: areaToVoxelCells(RENDER_METERS.minFootprintAreaM2, voxelMeters)
    };
}
