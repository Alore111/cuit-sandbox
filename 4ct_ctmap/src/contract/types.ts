/* ================================================================
   地图数据契约（类型与常量，不含实现）
   —— 后端用它约束 JSON 数据，前端用它约束读取结果。
      【口径】前后端**各持一份完全相同的副本**（同步要求见本目录 index.ts）：
      字段增删必须两边一起改，否则后端校验与前端渲染会对同一条数据产生分叉。
================================================================ */

/** 经纬度点：[纬度, 经度]。与 DEMO 的 OSM 数据保持同一顺序 */
export type LonLat = [number, number];

/** 体量做法：决定建筑几何的生成方式（与 MASSING_KEYS 一一对应） */
export type MassingKey = 'block' | 'shed' | 'arch' | 'tower' | 'skywalk';

/** 数据来源：osm = 抓取所得，manual = 人工录入 */
export type DataSource = 'osm' | 'manual';

/**
 * 学校与网格配置。
 * 换学校只改这一份数据：名称、品牌字、边界、体素边长、免责文案全部在这里。
 */
export interface School {
    id: string;
    name: string;
    campusName: string;
    shortName: string;
    /** HUD 徽标上的字（DEMO 里硬编码的「信」） */
    brandMark: string;
    title: string;
    subtitle: string;
    /** 单个体素对应的真实边长（米） */
    voxelMeters: number;
    /** 网格在岛面轮廓外再留的余量（米） */
    gridPaddingMeters: number;
    /** 岛面内未被任何地皮覆盖的格子所用的基础地皮类型 */
    defaultTerrainTypeKey: string;
    /** 数据编制范围：转换脚本用它过滤校外要素（**不是**渲染范围，渲染看 island.outline） */
    boundary: LonLat[];
    /** 悬空小岛：岛面轮廓、倒锥岩层、岛缘小建筑、岛下碎岩 */
    island: Island;
    /** 版权与数据来源声明 */
    attribution: string;
    /** 高度免责说明 */
    heightNote: string;
}

/** 岛下岩层：自上而下叠加，总厚度即倒锥深度 */
export interface IslandRockLayer {
    thicknessMeters: number;
    /** 前端色板里的全局色键（soil / rock / rockDeep …） */
    paletteKey: string;
}

/** 岛缘小建筑的形制 */
export type RimPropKind = 'pavilion' | 'tower';

/** 岛缘小建筑：亭 / 塔，坐落在岛面外圈的草地上 */
export interface IslandRimProp {
    id: string;
    kind: RimPropKind;
    lat: number;
    lon: number;
}

/** 岛下碎岩：悬在倒锥四周的独立岩块 */
export interface IslandDebris {
    id: string;
    lat: number;
    lon: number;
    /** 岩块中心相对岛面的下垂深度（米，正数表示在岛面之下） */
    depthMeters: number;
    /** 岩块边长（米） */
    sizeMeters: number;
}

/**
 * 悬空小岛。
 * 【口径】岛面轮廓是**一次生成后落地到数据**的（转换脚本由校园边界向外做确定性扰动），
 * 渲染层只读不算 —— 每次打开形状必须完全一致，不允许运行时随机。
 */
export interface Island {
    /** 岛面轮廓，[lat, lon]；同时决定地表铺装范围与网格尺寸 */
    outline: LonLat[];
    /** 记录用：轮廓扰动的基准幅度（米），轮廓已固化，改这个不会改变形状 */
    noiseMeters: number;
    /** 倒锥岩层，自上而下 */
    rockLayers: IslandRockLayer[];
    rimProps: IslandRimProp[];
    debris: IslandDebris[];
}

/**
 * 体量做法的几何参数。
 * 【口径】长度参数一律以米为单位、带 `Meters` 后缀，渲染层按 school.voxelMeters 折算成格数，
 * 因此改分辨率不需要重调这些参数。
 */
export type MassingParams = Record<string, number>;

/**
 * 主色调字段（wallColor / roofColor）的取值格式：`#rrggbb`，日景色。
 * 【口径】与 METERS_SUFFIX 同一套做法：**格式本身写在契约里**，后端据此校验数据、
 * 前端据此解析成颜色值，两端不许各自记一套 —— 否则会出现「后端收下了、前端解析不出来」。
 */
export const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/**
 * 建筑类型定义。
 * 【配色口径】`paletteKey` 决定这类型建筑的**整套配色组**（墙、墙暗部、顶、腰线）；
 * `wallColor` / `roofColor` 是**选填的主色调**，用来在这个类型上覆盖墙面与屋顶：
 *   - 值是日景色（`#rrggbb`），夜景由渲染层统一压暗，因此数据里只写一份；
 *   - 墙暗部（wallLo）由墙面主色派生出明暗层次，不需要单独填；
 *   - 留空（或不写）= 完全跟随 `paletteKey` 的色板，不做任何派生。
 */
export interface BuildingTypeDef {
    label: string;
    /** 经验层数（高校校园常见形制的估值，非实测） */
    floors: number;
    /** 经验层高（米） */
    floorHeight: number;
    massing: MassingKey;
    /** 前端色板里建筑配色组的 key */
    paletteKey: string;
    /** 墙面主色（#rrggbb，日景色）；留空跟随色板 */
    wallColor?: string;
    /** 屋顶主色（#rrggbb，日景色）；留空跟随色板 */
    roofColor?: string;
    massingParams?: MassingParams;
}

/** 名称关键词 → 类型（顺序即优先级，仅后端推断时使用） */
export interface NameRule {
    pattern: string;
    type: string;
}

export interface BuildingTypeDictionary {
    version: number;
    /** 推断不出类型时使用的 key */
    defaultTypeKey: string;
    types: Record<string, BuildingTypeDef>;
    nameRules: NameRule[];
    kindRules: Record<string, string>;
}

/** 地皮类型定义 */
export interface TerrainTypeDef {
    label: string;
    /** 图例排序 */
    order: number;
    /** 近似色数组：渲染时按坐标哈希取一个，形成体素艺术的色块感 */
    paletteKeys: string[];
    /** 是否在格子上抬起树冠 */
    canopy: boolean;
    /** 是否允许散布花草灌木（岛面装饰物的落点范围） */
    groundCover: boolean;
    /** 是否沿这条路两侧立路灯（不是所有路都立灯） */
    streetLamp: boolean;
    /** 是否走水面材质 */
    water: boolean;
}

export interface TerrainTypeDictionary {
    version: number;
    types: Record<string, TerrainTypeDef>;
}

export interface Dictionaries {
    buildings: BuildingTypeDictionary;
    terrain: TerrainTypeDictionary;
}

/**
 * 建筑条目（后端已解析完毕）。
 * 类型推断与「类型经验值 / 逐栋覆盖」的合成都在后端完成，前端拿到即可直接渲染。
 */
export interface Building {
    id: string;
    name: string;
    /** OSM 原始 building=* 标签；无标签时为空串 */
    kind: string;
    source: DataSource;
    /** 平面轮廓，[lat, lon] */
    outline: LonLat[];
    /** 由 outline 现算的面积（平方米），数据源里不存 */
    areaM2: number;
    typeKey: string;
    typeLabel: string;
    paletteKey: string;
    /** 类型字典给的墙面主色（#rrggbb，日景色）；null = 跟随色板 */
    wallColor: string | null;
    /** 类型字典给的屋顶主色（#rrggbb，日景色）；null = 跟随色板 */
    roofColor: string | null;
    massing: MassingKey;
    floors: number;
    /** 层高（米） */
    floorHeight: number;
    /** 推定高度（米）= floors × floorHeight */
    heightMeters: number;
    /** 推定高度折算的体素层数（后端按 school.voxelMeters 算好，渲染层直接用） */
    heightVoxels: number;
    massingParams: MassingParams;
    /** 逐栋覆盖了哪些字段（详情卡据此标注「手工指定」） */
    overriddenFields: string[];
}

/** 地皮：覆盖在地面上的多边形色块 */
export interface Parcel {
    id: string;
    name: string;
    typeKey: string;
    outline: LonLat[];
    source: DataSource;
    areaM2: number;
}

export interface DataSourceInfo {
    name: string;
    license: string;
}

export interface Manifest {
    version: string;
    updatedAt: string;
    sources: DataSourceInfo[];
}

/** 统一响应壳（沿用 4ct 既有的 { success, message, data } 约定） */
export interface ApiEnvelope<T> {
    success: boolean;
    message: string;
    data: T;
}

/* ----------------------------------------------------------------
   磁盘上的原始条目（编辑器专用）
   —— 与上面「已合成」的 Building / Parcel 不同：
      typeKey / massing / floors / floorHeight / massingParams 为 null 表示
      「跟随类型字典」，不是「取值为空」。编辑器必须按这个语义回写，
      否则一次保存就会把所有建筑变成逐栋覆盖。
---------------------------------------------------------------- */

export interface RawBuildingEntry {
    id: string;
    name?: string;
    kind?: string;
    source?: DataSource;
    outline: LonLat[];
    typeKey?: string | null;
    massing?: MassingKey | null;
    floors?: number | null;
    floorHeight?: number | null;
    massingParams?: MassingParams | null;
    /** 未识别字段原样保留：编辑器不认识的字段不能因为一次保存就丢掉 */
    [extra: string]: unknown;
}

export interface RawParcelEntry {
    id: string;
    name?: string;
    typeKey: string;
    outline: LonLat[];
    source?: DataSource;
    [extra: string]: unknown;
}

/** buildings.json / parcels.json 的外壳 */
export interface RawItemsFile<T> {
    version: number;
    items: T[];
}

/**
 * 磁盘上的建筑类型条目（编辑器专用）。
 * 与 RawBuildingEntry 同一口径：`wallColor` / `roofColor` 留空即「跟随色板」，
 * 未识别字段原样保留 —— 编辑器整份覆盖写回时不能把不认识的字段丢掉。
 */
export interface RawBuildingTypeDef extends BuildingTypeDef {
    [extra: string]: unknown;
}

/** data/dictionaries/building-types.json 的原始形状（编辑器整份覆盖写回的对象） */
export interface RawBuildingTypeDictionary extends Omit<BuildingTypeDictionary, 'types'> {
    types: Record<string, RawBuildingTypeDef>;
    [extra: string]: unknown;
}

/**
 * 前端服务层把 5 个读接口拼成的完整数据集。
 * 形状与后端的 loadMapDataset() 返回值一致，两端共用同一份定义。
 */
export interface MapDataset {
    school: School;
    dictionaries: Dictionaries;
    buildings: Building[];
    parcels: Parcel[];
    manifest: Manifest;
}
