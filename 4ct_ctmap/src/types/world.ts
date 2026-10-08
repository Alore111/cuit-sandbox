/* ================================================================
   渲染层的产出类型
   —— UI 只读这些「轻量快照」，不接触任何 three.js 对象；
      渲染层也就不会把 3D 细节漏到界面层。
================================================================ */

/** 一栋建筑渲染后的实际形制（与数据集里的推定值分开，便于对照量化误差） */
export interface BuildingRuntime {
    id: string;
    /** 实际生成顶点（体素层号），含冠部/矮栏等超出名义高度的部分 */
    apexVoxels: number;
    /** 足迹包围盒（格），已含出檐与拾取放宽 */
    footprint: { width: number; depth: number };
    /** 该栋实际生成的体素数 */
    voxelCount: number;
}

export interface WorldStats {
    voxelMeters: number;
    gridSize: { width: number; height: number };
    /** 岛面轮廓包围盒的实际跨度（米） */
    spanMeters: { x: number; z: number };
    /** 岛面内的格子数 */
    islandCells: number;
    /** 岛面内各地皮类型的格子数，key = 地皮类型 key（图例据此算占比） */
    terrainCellsByType: Record<string, number>;
    terrainVoxels: number;
    waterVoxels: number;
    buildingCount: number;
    buildingVoxels: number;
    /** 岛体（倒锥岩层）体素数 */
    islandVoxels: number;
    /** 岛缘小建筑的座数 */
    rimPropCount: number;
    /** 岛下碎岩的块数 */
    debrisCount: number;
    /** 路灯灯杆根数与成对落位的组数 */
    lampCount: number;
    lampPairCount: number;
    /** 装饰物：花草灌木株数、飞鸟只数、萤火虫只数 */
    plantCount: number;
    birdCount: number;
    fireflyCount: number;
    totalVoxels: number;
}

/**
 * 渲染告警：数据合法但栅格化后一格都出不来。
 * 由渲染层汇总（只有它拿得到精确的栅格化结果），在 HUD 上显性化，不静默丢弃。
 */
export interface RenderWarning {
    id: string;
    kind: 'building' | 'parcel' | 'island';
    name: string;
    reason: string;
}
