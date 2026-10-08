/* ================================================================
   校园实况信息契约（Campus Live Data Contract）
   —— 定义校园实况融合所需的全部数据结构、常量与枚举。
      【口径】前后端各持一份完全相同的副本（同步要求同 types.ts）。

   核心模块：
   1. 地点热度 (LocationHeat)   —— 用于热力光柱可视化（由事件自动派生）
   2. 统一校园事件 (UnifiedCampusEvent) —— 合并原 CampusEvent + 二课活动，
                                            唯一事件类型，支持第三方接口接入。
   3. 第三方事件接口配置 (EventApiConfig) —— 编辑页面定义的 URL / 请求头 / 字段映射。
================================================================ */

import type { LonLat } from './types';

/** ================================
 *  1. 地点热度模块
 *  ================================ */

/** 热度等级（用于视觉呈现的分级） */
export type HeatLevel = 'low' | 'medium' | 'high' | 'critical';

/** 热度来源类型 */
export type HeatSourceType =
    | 'people_count'      // 实时人数
    | 'check_in_count'    // 签到人次
    | 'activity_count'    // 活动数量
    | 'post_count'        // 动态/帖子数量
    | 'composite';        // 综合热度

/** 单个地点的热度数据 */
export interface LocationHeat {
    id: string;
    /** 关联的建筑ID或地点ID（与 buildings.id 对齐，若无则为自定义地点ID） */
    locationId: string;
    /** 地点名称 */
    locationName: string;
    /** 地点地理文本（如 '110100'） */
    geoText: string;
    /** 经纬度坐标：[纬度, 经度] */
    position: LonLat;
    /** 热度值：0~100 的标准化分数 */
    heatValue: number;
    /** 热度等级 */
    heatLevel: HeatLevel;
    /** 热度来源类型 */
    sourceType: HeatSourceType;
    /** 真实人数（如果有） */
    peopleCount?: number;
    /** 相对高度系数（光柱高度，0~1，0=最短，1=最高） */
    heightRatio?: number;
    /** 颜色覆盖（#rrggbb，不填则按 heatLevel 映射） */
    customColor?: string;
    /** 关联的事件IDs */
    relatedEventIds?: string[];
    /** 统计时间戳（毫秒） */
    updatedAt: number;
}

/** 热度聚合统计（用于概览面板） */
export interface HeatSummary {
    totalHotSpots: number;
    criticalCount: number;
    highCount: number;
    mediumCount: number;
    lowCount: number;
    campusAvgHeat: number;
    updatedAt: number;
}

/** ================================
 *  2. 校园事件模块
 *  ================================ */

/** 事件紧急程度 */
export type EventSeverity = 'info' | 'warning' | 'urgent' | 'special';

/** 事件分类（与业务字典对齐） */
export type EventCategory =
    | 'lecture'         // 讲座报告
    | 'competition'     // 竞赛活动
    | 'performance'     // 演出活动
    | 'sports'          // 体育赛事
    | 'meeting'         // 会议集会
    | 'emergency'       // 紧急通知
    | 'maintenance'     // 设施维护
    | 'promotion'       // 宣传推广
    | 'festival'        // 节日庆典
    | 'other';

/** 事件状态 */
export type EventStatus = 'upcoming' | 'ongoing' | 'ended' | 'cancelled';

/** 单个校园事件 */
export interface CampusEvent {
    id: string;
    /** 事件标题 */
    title: string;
    /** 事件简短描述（1~2句话） */
    description: string;
    /** 事件分类 */
    category: EventCategory;
    /** 紧急程度 */
    severity: EventSeverity;
    /** 状态 */
    status: EventStatus;
    /** 关联的地点ID */
    locationId?: string;
    /** 地点名称（冗余展示用） */
    locationName?: string;
    /** 经纬度坐标（如果有精确位置） */
    position?: LonLat;
    /** position 当前坐标系（Node 统一输出为 wgs84，前端无需再换算） */
    coordSystem?: 'gcj02' | 'wgs84';
    /** 真实地理文字：源站给的地址区域串/详细地址，Node 端据此匹配地点补 position */
    geoText?: string;
    /** 开始时间（ISO 字符串） */
    startTime?: string;
    /** 结束时间（ISO 字符串） */
    endTime?: string;
    /** 主办单位 */
    organizer?: string;
    /** 预计/实际参与人数 */
    participantCount?: number;
    /** 封面图URL */
    coverImageUrl?: string;
    /** 关联的二课活动ID */
    relatedActivityId?: string;
    /** 标签 */
    tags?: string[];
    /** —— 新增：第三方跳转 URL，有值时详情抽屉显示"跳转到原页面"按钮 —— */
    jumpUrl?: string;
    /** 发布时间（毫秒） */
    createdAt: number;
    /** 最后更新时间（毫秒） */
    updatedAt: number;
}

/** 事件过滤选项（字典项） */
export interface EventCategoryOption {
    key: EventCategory;
    label: string;
    /** 前端色板使用的全局色键 */
    paletteKey: string;
}

export interface EventSeverityOption {
    key: EventSeverity;
    label: string;
    paletteKey: string;
}

/** ================================
 *  3. 第二课堂活动模块
 *  —— 字段与 backend_core 的 EkActivity 表 + SecondClass 组件对齐
 *  ================================ */

/** 活动状态（与第二课堂官方状态码对齐） */
export type ActivityStatus =
    | 'available'     // 0 - 可报名
    | 'registered'    // 1 - 已报名
    | 'defaulted'     // 2 - 违约名单
    | 'unavailable';  // 3 - 不可报名

/** 活动模块（与 ModuleCodeText 对齐） */
export type ActivityModule =
    | 'thought'           // 思想成长
    | 'volunteer'         // 志愿公益
    | 'academic'          // 学业学习
    | 'innovation'        // 创新创业
    | 'art'               // 文化艺术
    | 'sports'            // 体育健身
    | 'practice'          // 社会实践
    | 'skill'             // 技能培训
    | 'other';

/** 活动级别 */
export type ActivityLevel =
    | 'national'          // 国家级
    | 'provincial'        // 省级
    | 'municipal'         // 市级
    | 'school'            // 校级
    | 'college'           // 院级
    | 'club';             // 社团级

/** 签到方式 */
export type SignInMethod =
    | 'none'              // 无需签到
    | 'geo'               // 地理位置签到
    | 'qr'                // 二维码签到
    | 'photo'             // 拍照签到
    | 'captcha'           // 验证码签到
    | 'combo';            // 组合签到

/** 二课活动精简信息（地图层用） */
export interface SecondClassActivity {
    id: string;
    /** 二课官方活动ID（ektId，与 backend_core EkActivity.ektId 对齐） */
    ektId?: string;
    /** 活动名称 */
    activityName: string;
    /** 活动类型文本 */
    activityTypeText?: string;
    /** 所属模块 */
    moduleCode: ActivityModule;
    /** 所属模块文本 */
    moduleCodeText?: string;
    /** 活动级别 */
    activityLevel?: ActivityLevel;
    /** 活动级别文本 */
    activityLevelText?: string;
    /** 活动地址区域（用于地点匹配，与 ActivityAddressAreaStr 对齐） */
    addressAreaStr?: string;
    /** 活动详细地址 */
    address?: string;
    /** 经纬度坐标（与 EkActivity.longitude / latitude 对齐） */
    position?: LonLat;
    /** 关联的地点ID */
    locationId?: string;
    /** 活动时间文本（原始文本，用于展示） */
    activityTimeText?: string;
    /** 解析后的开始时间（ISO） */
    startTime?: string;
    /** 解析后的结束时间（ISO） */
    endTime?: string;
    /** 签到时间文本 */
    signInTimeText?: string;
    /** 签退时间文本 */
    signOutTimeText?: string;
    /** 是否需要签到 */
    needSignIn?: boolean;
    /** 是否需要签退 */
    needSignOut?: boolean;
    /** 签到方式 */
    signInMethod?: SignInMethod;
    /** 学分 */
    score?: string;
    /** 可参与人数上限 */
    limitNumber?: number;
    /** 已报名人数 */
    registeredCount?: number;
    /** 是否需要审核 */
    needAudit?: boolean;
    /** 是否需要交作业 */
    needHomework?: boolean;
    /** 年级限制（文本描述） */
    gradeLimit?: string;
    /** 性别限制（文本描述） */
    sexLimit?: string;
    /** 学院限制（文本描述） */
    collegeLimit?: string;
    /** 申请单位名称 */
    applyOrgName?: string;
    /** 主办单位 */
    sponsorNames?: string;
    /** 承办单位 */
    organizerNames?: string;
    /** 学年学期 */
    yearTerm?: string;
    /** 活动状态 */
    status?: ActivityStatus;
    /** 活动状态文本 */
    statusText?: string;
    /** 活动简介 */
    introduction?: string;
    /** 海报URL（列表缩略图用） */
    posterUrl?: string;
    /** 标签 */
    tags?: string[];
    /** 覆盖范围（米，签到用） */
    coverRadiusMeters?: number;
    /** 插入时间（毫秒） */
    insertTime?: number;
    /** 更新时间（毫秒） */
    updateTime?: number;
}

/** 二课活动过滤字典项 */
export interface ActivityModuleOption {
    key: ActivityModule;
    label: string;
    paletteKey: string;
}

export interface ActivityLevelOption {
    key: ActivityLevel;
    label: string;
    paletteKey: string;
}

/** ================================
 *  4. 聚合接口：统一返回结构
 *  ================================ */

/** 校园实况统一快照（单次请求拉齐全部） */
export interface CampusLiveSnapshot {
    /** 数据版本标识 */
    version: string;
    /** 快照生成时间（毫秒） */
    snapshotAt: number;
    /** 校园概况：地点热度列表 */
    heatList: LocationHeat[];
    /** 热度概览统计 */
    heatSummary: HeatSummary;
    /** 进行中 + 即将开始的事件 */
    events: CampusEvent[];
    /** 二课活动（进行中 + 可报名） */
    activities: SecondClassActivity[];
    /** 事件分类字典 */
    eventCategoryDict: EventCategoryOption[];
    /** 事件严重程度字典 */
    eventSeverityDict: EventSeverityOption[];
    /** 二课模块字典 */
    activityModuleDict: ActivityModuleOption[];
    /** 活动级别字典 */
    activityLevelDict: ActivityLevelOption[];
}

/** 单项拉取的请求参数（可选过滤条件） */
export interface CampusLiveQuery {
    /** 是否只返回进行中的数据 */
    ongoingOnly?: boolean;
    /** 分类过滤 */
    categories?: EventCategory[];
    /** 活动模块过滤 */
    modules?: ActivityModule[];
    /** 地点ID过滤 */
    locationIds?: string[];
    /** 时间范围：起始（毫秒） */
    from?: number;
    /** 时间范围：结束（毫秒） */
    to?: number;
}

/** ================================================================
 *  常量：色板映射键 + 等级阈值
 *  ================================================================ */

/** 热度等级 → 阈值（heatValue ≥） */
export const HEAT_LEVEL_THRESHOLDS: Record<HeatLevel, number> = {
    critical: 80,
    high: 60,
    medium: 35,
    low: 0,
};

/** 热度等级 → 前端全局色板键（与 theme/palette 对齐） */
export const HEAT_PALETTE_KEYS: Record<HeatLevel, string> = {
    critical: 'heatCritical',
    high: 'heatHigh',
    medium: 'heatMedium',
    low: 'heatLow',
};

/** 事件分类 → 前端全局色板键 */
export const EVENT_CATEGORY_DEFAULTS: EventCategoryOption[] = [
    { key: 'lecture', label: '讲座报告', paletteKey: 'eventLecture' },
    { key: 'competition', label: '竞赛活动', paletteKey: 'eventCompetition' },
    { key: 'performance', label: '演出活动', paletteKey: 'eventPerformance' },
    { key: 'sports', label: '体育赛事', paletteKey: 'eventSports' },
    { key: 'meeting', label: '会议集会', paletteKey: 'eventMeeting' },
    { key: 'emergency', label: '紧急通知', paletteKey: 'eventEmergency' },
    { key: 'maintenance', label: '设施维护', paletteKey: 'eventMaintenance' },
    { key: 'promotion', label: '宣传推广', paletteKey: 'eventPromotion' },
    { key: 'festival', label: '节日庆典', paletteKey: 'eventFestival' },
    { key: 'other', label: '其他活动', paletteKey: 'eventOther' },
];

/** 事件严重程度 → 前端全局色板键 */
export const EVENT_SEVERITY_DEFAULTS: EventSeverityOption[] = [
    { key: 'info', label: '一般通知', paletteKey: 'severityInfo' },
    { key: 'warning', label: '注意事项', paletteKey: 'severityWarning' },
    { key: 'urgent', label: '紧急事项', paletteKey: 'severityUrgent' },
    { key: 'special', label: '特别推荐', paletteKey: 'severitySpecial' },
];

/** 二课模块 → 前端全局色板键 */
export const ACTIVITY_MODULE_DEFAULTS: ActivityModuleOption[] = [
    { key: 'thought', label: '思想成长', paletteKey: 'modThought' },
    { key: 'volunteer', label: '志愿公益', paletteKey: 'modVolunteer' },
    { key: 'academic', label: '学业学习', paletteKey: 'modAcademic' },
    { key: 'innovation', label: '创新创业', paletteKey: 'modInnovation' },
    { key: 'art', label: '文化艺术', paletteKey: 'modArt' },
    { key: 'sports', label: '体育健身', paletteKey: 'modSports' },
    { key: 'practice', label: '社会实践', paletteKey: 'modPractice' },
    { key: 'skill', label: '技能培训', paletteKey: 'modSkill' },
    { key: 'other', label: '其他活动', paletteKey: 'modOther' },
];

/** 活动级别 → 前端全局色板键 */
export const ACTIVITY_LEVEL_DEFAULTS: ActivityLevelOption[] = [
    { key: 'national', label: '国家级', paletteKey: 'lvlNational' },
    { key: 'provincial', label: '省级', paletteKey: 'lvlProvincial' },
    { key: 'municipal', label: '市级', paletteKey: 'lvlMunicipal' },
    { key: 'school', label: '校级', paletteKey: 'lvlSchool' },
    { key: 'college', label: '院级', paletteKey: 'lvlCollege' },
    { key: 'club', label: '社团级', paletteKey: 'lvlClub' },
];

/** ================================================================
 *  辅助函数
 *  ================================================================ */

/** 根据热度值算出热度等级 */
export function getHeatLevel(value: number): HeatLevel {
    const v = Math.max(0, Math.min(100, value));
    if (v >= HEAT_LEVEL_THRESHOLDS.critical) return 'critical';
    if (v >= HEAT_LEVEL_THRESHOLDS.high) return 'high';
    if (v >= HEAT_LEVEL_THRESHOLDS.medium) return 'medium';
    return 'low';
}

/** 将活动报名状态码 → ActivityStatus 枚举 */
export function parseActivityStatusCode(code: string | number): ActivityStatus {
    const s = String(code);
    if (s === '0') return 'available';
    if (s === '1') return 'registered';
    if (s === '2') return 'defaulted';
    return 'unavailable';
}

/** 活动状态码 → 文本 */
export function getActivityStatusText(code: ActivityStatus): string {
    const map: Record<ActivityStatus, string> = {
        available: '可报名',
        registered: '已报名',
        defaulted: '违约名单',
        unavailable: '不可报名',
    };
    return map[code] ?? '未知状态';
}

/** ================================================================
 *  UI 便捷常量（排序、标签、颜色）
 *  ================================================================ */

/** 热度等级的显示顺序（从高到低） */
export const HEAT_LEVEL_ORDER: readonly HeatLevel[] = ['critical', 'high', 'medium', 'low'];

/** 热度等级 → 中文标签 */
export const HEAT_LEVEL_LABEL: Record<HeatLevel, string> = {
    critical: '极热',
    high: '高热',
    medium: '中等',
    low: '低热',
};

/** 事件状态 → 中文标签 */
export const EVENT_STATUS_LABEL: Record<EventStatus, string> = {
    upcoming: '即将开始',
    ongoing: '进行中',
    ended: '已结束',
    cancelled: '已取消',
};

/** 事件严重度 → 中文标签（从 *_DEFAULTS 派生） */
export const EVENT_SEVERITY_LABEL: Record<EventSeverity, string> = (() => {
    const out = {} as Record<EventSeverity, string>;
    for (const o of EVENT_SEVERITY_DEFAULTS) out[o.key] = o.label;
    return out;
})();

/** 事件分类 → 中文标签 */
export const EVENT_CATEGORY_LABEL: Record<EventCategory, string> = (() => {
    const out = {} as Record<EventCategory, string>;
    for (const o of EVENT_CATEGORY_DEFAULTS) out[o.key] = o.label;
    return out;
})();

/** 二课模块 → 中文标签 */
export const ACTIVITY_MODULE_LABEL: Record<ActivityModule, string> = (() => {
    const out = {} as Record<ActivityModule, string>;
    for (const o of ACTIVITY_MODULE_DEFAULTS) out[o.key] = o.label;
    return out;
})();

/** 活动级别 → 中文标签 */
export const ACTIVITY_LEVEL_LABEL: Record<ActivityLevel, string> = (() => {
    const out = {} as Record<ActivityLevel, string>;
    for (const o of ACTIVITY_LEVEL_DEFAULTS) out[o.key] = o.label;
    return out;
})();

/** 活动状态 → 中文标签 */
export const ACTIVITY_STATUS_LABEL: Record<ActivityStatus, string> = {
    available: '可报名',
    registered: '已报名',
    defaulted: '违约名单',
    unavailable: '不可报名',
};

/** ================================================================
 *  UI 便捷颜色（HUD渲染用，直接给 #rrggbb 字符串，不依赖 theme
 *  取值与 palette.ts 中 NIGHT.voxel 保持一致，保证 HUD 与光柱配色统一
 *  ================================================================ */

type PaletteKey = { paletteKey?: string; key: string };

function paletteKeyOf(list: readonly PaletteKey[], k: string): string | undefined {
    return list.find((o) => o.key === k)?.paletteKey;
}

const VOXEL_HEX: Record<string, string> = {
    // 热度
    heatCritical: '#ff3b5c',
    heatHigh: '#ff8a3d',
    heatMedium: '#f5c043',
    heatLow: '#59d1a3',
    // 事件分类
    eventLecture: '#7aa8ff',
    eventCompetition: '#ff9a76',
    eventPerformance: '#d47bff',
    eventSports: '#5ecf8a',
    eventMeeting: '#88c5d4',
    eventEmergency: '#ff4d52',
    eventMaintenance: '#b4896a',
    eventPromotion: '#ffb347',
    eventFestival: '#ff77aa',
    eventOther: '#8a96b0',
    // 严重度
    severityInfo: '#7aa8ff',
    severityWarning: '#ffb347',
    severityUrgent: '#ff4d52',
    severitySpecial: '#d47bff',
    // 模块
    modThought: '#e86a5a',
    modVolunteer: '#5ac27a',
    modAcademic: '#6a9cff',
    modInnovation: '#ffa94d',
    modArt: '#d874d4',
    modSports: '#66c8a2',
    modPractice: '#b09670',
    modSkill: '#6db9c9',
    modOther: '#8a96b0',
    // 级别
    lvlNational: '#ff4d52',
    lvlProvincial: '#ff8a3d',
    lvlMunicipal: '#f5c043',
    lvlSchool: '#6a9cff',
    lvlCollege: '#66c8a2',
    lvlClub: '#b09670',
};

/**
 * 事件相关颜色查询（severity 或 category）
 */
export function resolveEventColor(
    v: EventSeverity | EventCategory,
    kind: 'severity' | 'category'
): string {
    const list = kind === 'severity' ? EVENT_SEVERITY_DEFAULTS : EVENT_CATEGORY_DEFAULTS;
    const key = paletteKeyOf(list as unknown as readonly PaletteKey[], v as string);
    return (key && VOXEL_HEX[key]) ?? VOXEL_HEX.eventOther;
}

export function resolveActivityModuleColor(mod: ActivityModule): string {
    const key = paletteKeyOf(ACTIVITY_MODULE_DEFAULTS as unknown as readonly PaletteKey[], mod);
    return (key && VOXEL_HEX[key]) ?? VOXEL_HEX.modOther;
}

export function resolveActivityLevelColor(lvl?: ActivityLevel): string {
    if (!lvl) return VOXEL_HEX.lvlSchool;
    const key = paletteKeyOf(ACTIVITY_LEVEL_DEFAULTS as unknown as readonly PaletteKey[], lvl);
    return (key && VOXEL_HEX[key]) ?? VOXEL_HEX.lvlSchool;
}

/** ================================================================
 *  4. 统一校园事件（UnifiedCampusEvent）
 *  —— 合并原 CampusEvent 与 SecondClassActivity，作为唯一事件类型。
 *     第三方接口按字段映射转换成此结构；前端所有展示层仅消费此结构。
 *  ================================================================ */

/** 统一校园事件 —— 默认字段名与原 CampusEvent 对齐，便于平滑迁移 */
export interface UnifiedCampusEvent {
    id: string;
    /** 事件标题 */
    title: string;
    /** 事件简短描述（1~2 句话） */
    description: string;
    /** 事件分类（lecture/competition/...） */
    category: EventCategory;
    /** 紧急程度 */
    severity: EventSeverity;
    /** 状态 */
    status: EventStatus;
    /** 关联的建筑/地点 ID，用于锚定到地图建筑 */
    locationId?: string;
    /** 地点名称（冗余展示用） */
    locationName?: string;
    /** 经纬度 [纬度, 经度]；精确位置优先级高于 locationId 锚定 */
    position?: LonLat;
    /** position 当前坐标系（Node 统一输出为 wgs84，前端无需再换算） */
    coordSystem?: 'gcj02' | 'wgs84';
    /** 真实地理文字：源站给的地址区域串/详细地址，Node 端据此匹配地点补 position */
    geoText?: string;
    /** 开始时间（ISO 字符串） */
    startTime?: string;
    /** 结束时间（ISO 字符串） */
    endTime?: string;
    /** 主办/承办/申请单位 */
    organizer?: string;
    /** 参与人数（实际或预计） */
    participantCount?: number;
    /** 封面/海报图 URL */
    coverImageUrl?: string;
    /** 标签数组 */
    tags?: string[];
    /** —— 原二课活动特有字段，保留以便映射 —— */
    /** 可报名人数上限 */
    limitNumber?: number;
    /** 已报名人数 */
    registeredCount?: number;
    /** 学分（字符串，展示用） */
    score?: string;
    /** 活动级别文本（校级/省级…），用于标签展示 */
    activityLevelText?: string;
    /** —— 新增：第三方跳转 URL，有值时详情抽屉显示"跳转到原页面"按钮 —— */
    jumpUrl?: string;
    /** 发布时间戳（毫秒） */
    createdAt: number;
    /** 最后更新时间戳（毫秒） */
    updatedAt: number;
    /** 第三方原始数据（调试用，运行时保留，不序列化） */
    __raw?: unknown;
}

/** ================================================================
 *  5. 第三方事件接口配置（EventApiConfig）
 *  —— 编辑页面定义、后端 data/event-config.json 持久化、
 *     前端读它来发请求、做字段映射。
 *  ================================================================ */

/** 单条自定义请求头（编辑页面按行管理） */
export interface EventApiHeader {
    key: string;
    value: string;
    /** 是否启用；关闭时保留条目但不发送 */
    enabled: boolean;
}

/** 字段映射：把第三方响应的字段名 → 统一事件字段名；
 *  值为空字符串或不填的键，视为使用默认同名字段。 */
export type EventFieldMapping = Partial<Record<keyof UnifiedCampusEvent, string>>;

/** 列表/详情接口的公共配置项 */
export interface EventApiEndpoint {
    /** 请求 URL（完整 URL，如 https://api.example.com/v1/events） */
    url: string;
    /** HTTP Method：列表建议 GET，详情 GET/POST 均可 */
    method: 'GET' | 'POST';
    /** 列表数据在响应体中的路径，空字符串或不填 = 默认 ApiEnvelope.data（即 data 就是数组）。
     *  层级用 "." 分隔，例如 "data.items"、"result.list"。仅支持对象属性访问，不支持数组下标。 */
    listDataPath?: string;
    /** 若启用详情接口：详情数据在响应体中的路径，空串或不填 = 默认 ApiEnvelope.data */
    detailDataPath?: string;
    /** 是否启用详情接口：关闭则列表项直接作为完整详情（不再发二次请求） */
    enableDetailEndpoint: boolean;
    /** 详情 URL 模板（仅 enableDetailEndpoint=true 时使用），支持 {id} 占位符，
     *  例如 "https://api.example.com/v1/events/{id}" */
    detailUrlTemplate?: string;
}

/** 事件搜索端点配置（与 EventApiEndpoint 同构，独立于列表/详情端点） */
export interface EventApiSearchEndpoint {
    /** 搜索请求 URL（后端会附加 ?q=关键词 或 POST body） */
    url: string;
    /** HTTP Method */
    method: 'GET' | 'POST';
    /** 搜索结果数组在响应体中的路径，空 = 默认 ApiEnvelope.data */
    listDataPath?: string;
}

/** 事件接口总配置，编辑页面编辑的就是这个对象 */
export interface EventApiConfig {
    /** 版本号，后续字段扩展时做迁移用 */
    version: number;
    /** 显示用备注，例如"校园 OA 系统"、"二课中心接口" */
    name?: string;
    /** 全局请求头，列表与详情共享（例如 Authorization: Bearer xxx） */
    headers: EventApiHeader[];
    /** 列表 + 详情接口端点 */
    endpoints: EventApiEndpoint;
    /** 独立事件搜索端点（可选）；未配置时后端从列表缓存中过滤 */
    searchEndpoints?: EventApiSearchEndpoint;
    /** 字段映射：空对象视为"全部默认同名字段"，
     *  非空只写需要覆盖的键，例如 { title: "eventName" } 表示 title 从响应的 eventName 取 */
    fieldMapping: EventFieldMapping;
    /** 最近一次保存时间戳（毫秒），后端写入时自动更新 */
    savedAt?: number;
}

/** 字段映射的"默认值"：即当 fieldMapping[key] 为空或缺省时，
 *  直接用 key 本身作为源字段名。此表列出来方便编辑页面做 placeholder 提示。 */
export const EVENT_FIELD_DEFAULTS: Record<keyof UnifiedCampusEvent, string> = {
    id: 'id',
    title: 'title',
    description: 'description',
    category: 'category',
    severity: 'severity',
    status: 'status',
    locationId: 'locationId',
    locationName: 'locationName',
    position: 'position',
    coordSystem: 'coordSystem',
    geoText: 'geoText',
    startTime: 'startTime',
    endTime: 'endTime',
    organizer: 'organizer',
    participantCount: 'participantCount',
    coverImageUrl: 'coverImageUrl',
    tags: 'tags',
    limitNumber: 'limitNumber',
    registeredCount: 'registeredCount',
    score: 'score',
    activityLevelText: 'activityLevelText',
    jumpUrl: 'jumpUrl',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
    __raw: '__raw',
};

/** ================================================================
 *  5b. 统一搜索结果类型（SearchResult）
 *  —— GET /api/search?q=关键词 的响应结构。
 *     地点（建筑/地皮/词典条目）与事件混合返回，地点优先，按匹配度降序。
 *  ================================================================ */

/** 搜索结果条目 */
export interface SearchResultItem {
    /** 结果类型：place=地点, event=事件 */
    type: 'place' | 'event';
    /** 显示名称 */
    name: string;
    /** 经纬度坐标 [lat, lon]（如果有） */
    position?: LonLat;
    /** 匹配得分（越高越匹配） */
    score: number;
    /** 地点类型额外字段 */
    placeData?: {
        /** 子类型：building=建筑, parcel=地皮, place=地点词典条目 */
        subType: 'building' | 'parcel' | 'place';
        /** 建筑 ID 数组（如果有） */
        buildingIds?: string[];
        /** 地皮 ID 数组（如果有） */
        parcelIds?: string[];
        /** 建筑/地皮类型标签 */
        typeLabel?: string;
    };
    /** 事件类型额外字段 */
    eventData?: {
        id: string;
        title: string;
        category: string;
        status: string;
        startTime?: string;
        endTime?: string;
        locationName?: string;
        description?: string;
        organizer?: string;
        tags?: string[];
        jumpUrl?: string;
    };
}

/** 统一搜索响应 */
export interface SearchResult {
    items: SearchResultItem[];
    total: number;
    query: string;
}

/** ================================================================
 *  6. 热度自动派生：由事件数组 → LocationHeat[] + HeatSummary
 *  —— 第三方接口不再单独提供热度数据，按事件在地点上的聚合：
 *      · 每发生一个事件 heatValue += 基数；
 *      · 参与人数越多 / severity 越高，基数越大；
 *      · ongoing 权重高于 upcoming / ended。
 *  ================================================================ */

/** severity 权重（越大越"热"），缺省用 info=1 */
const SEVERITY_WEIGHT: Record<EventSeverity, number> = {
    special: 4.2,
    urgent: 3.0,
    warning: 2.0,
    info: 1.0,
};

/** status 权重 */
const STATUS_WEIGHT: Record<EventStatus, number> = {
    ongoing: 1.3,
    upcoming: 1.0,
    ended: 0.35,
    cancelled: 0.1,
};

/** 聚合输入：一条事件 → 一个 (locationId 或 position) 桶 */
interface HeatBucket {
    locationId: string;
    locationName: string;
    position: LonLat;
    score: number;
    events: number;
    people: number;
    relatedEventIds: string[];
    /** 最近一条事件的更新时间，桶的 updatedAt 取它 */
    latestUpdatedAt: number;
}

function bucketKeyOf(
    ev: UnifiedCampusEvent,
    buildingsById: Map<string, { name?: string; outline?: LonLat[] }>
): { key: string; locationId: string; locationName: string; geoText: string; position: LonLat } | null {
    // 1) 精确经纬度优先
    if (ev.position && Array.isArray(ev.position) && ev.position.length === 2) {
        const pos: LonLat = [ev.position[0], ev.position[1]];
        // 有 position 但没有 locationId / locationName → 用坐标做 key，地点名兜底"自定义地点"
        let locId = ev.locationId ?? `@pos:${pos[0].toFixed(5)}_${pos[1].toFixed(5)}`;
        let locName = ev.locationName ?? '自定义地点';
        // 如果有 locationId，尝试按建筑补 name / 位置中心
        const b = ev.locationId ? buildingsById.get(ev.locationId) : undefined;
        if (b) {
            if (!ev.locationName && b.name) locName = b.name;
        }
        return { key: `pos:${locId}`, locationId: locId, locationName: locName, geoText: ev.geoText, position: pos };
    }
    // 2) 按建筑锚定（locationId 匹配 buildings.json 的中心 + 名称）
    if (ev.locationId) {
        const b = buildingsById.get(ev.locationId);
        if (b && b.outline && b.outline.length > 0) {
            let lat = 0, lon = 0;
            for (const p of b.outline) { lat += p[0]; lon += p[1]; }
            const center: LonLat = [lat / b.outline.length, lon / b.outline.length];
            const locName = ev.locationName ?? b.name ?? ev.locationId;
            return { key: `loc:${ev.locationId}`, locationId: ev.locationId, locationName: locName, geoText: ev.geoText, position: center };
        }
        // 没在 buildings 里但有 locationId + locationName 也凑合（虚拟地点）
        if (ev.locationName) {
            return null; // 没坐标，没建筑 → 不参与热度派生
        }
    }
    return null;
}

/**
 * 把 UnifiedCampusEvent[] 聚合成 LocationHeat[] + HeatSummary。
 * 【口径】没有任何事件时返回空数组，不提供空桶兜底 —— 光柱是"有事件才有光"，不是无中生有。
 * @param events  统一事件列表
 * @param buildingsById  buildings.json 按 id 索引的建筑 Map（name / outline 用来补坐标和名称）
 */
export function deriveHeatFromEvents(
    events: UnifiedCampusEvent[],
    buildingsById: Map<string, { name?: string; outline?: LonLat[] }>
): { heatList: LocationHeat[]; heatSummary: HeatSummary } {
    const buckets = new Map<string, HeatBucket>();
    const now = Date.now();

    for (const ev of events) {
        const meta = bucketKeyOf(ev, buildingsById);
        if (!meta) continue;

        // 分数组成：severity 权重 × status 权重 × (1 + log2(1 + 参与人数/50))
        const sevW = SEVERITY_WEIGHT[ev.severity] ?? 1.0;
        const staW = STATUS_WEIGHT[ev.status] ?? 1.0;
        const peopleBase = ev.participantCount ?? ev.registeredCount ?? 20;
        const peopleFactor = 1 + Math.log2(1 + peopleBase / 50);
        const score = sevW * staW * peopleFactor;

        const b = buckets.get(meta.key);
        if (b) {
            b.score += score;
            b.events += 1;
            b.people += peopleBase;
            b.latestUpdatedAt = Math.max(b.latestUpdatedAt, ev.updatedAt ?? now);
            if (b.relatedEventIds.length < 3) b.relatedEventIds.push(ev.id);
        } else {
            buckets.set(meta.key, {
                locationId: meta.locationId,
                locationName: meta.locationName,
                geoText: meta.geoText,
                position: meta.position,
                score,
                events: 1,
                people: peopleBase,
                relatedEventIds: [ev.id].slice(0, 3),
                latestUpdatedAt: ev.updatedAt ?? now,
            });
        }
    }

    // 归一化分数到 0~100 heatValue（最高的桶 = 95，其余按比例）
    let maxScore = 0;
    for (const b of buckets.values()) if (b.score > maxScore) maxScore = b.score;
    const scale = maxScore > 0 ? 95 / maxScore : 0;

    const heatList: LocationHeat[] = [];
    let idx = 0;
    for (const b of buckets.values()) {
        const raw = Math.round(b.score * scale + Math.min(5, b.events * 1.2));
        const heatValue = Math.max(5, Math.min(100, raw));
        const heatLevel = getHeatLevel(heatValue);
        heatList.push({
            id: `heat-der-${idx}-${b.locationId}`,
            locationId: b.locationId,
            locationName: b.locationName,
            geoText: b.geoText,
            position: b.position,
            heatValue,
            heatLevel,
            sourceType: 'activity_count',
            peopleCount: Math.round(b.people),
            heightRatio: Math.max(0.15, Math.min(1, heatValue / 100)),
            relatedEventIds: b.relatedEventIds,
            updatedAt: b.latestUpdatedAt,
        });
        idx += 1;
    }

    // 热度概览
    let critical = 0, high = 0, medium = 0, low = 0, sum = 0;
    for (const h of heatList) {
        sum += h.heatValue;
        if (h.heatLevel === 'critical') critical++;
        else if (h.heatLevel === 'high') high++;
        else if (h.heatLevel === 'medium') medium++;
        else low++;
    }
    const heatSummary: HeatSummary = {
        totalHotSpots: heatList.length,
        criticalCount: critical,
        highCount: high,
        mediumCount: medium,
        lowCount: low,
        campusAvgHeat: heatList.length ? Math.round((sum / heatList.length) * 10) / 10 : 0,
        updatedAt: now,
    };

    return { heatList, heatSummary };
}

/** ================================================================
 *  7. 兼容层：把 UnifiedCampusEvent[] 转换为旧 CampusEvent[] /
 *     SecondClassActivity[]，用于未迁移完成的老代码。
 *     （迁移完成后可移除）
 *  ================================================================ */
export function unifiedToLegacyEvents(events: UnifiedCampusEvent[]): CampusEvent[] {
    return events.map((e) => ({
        id: e.id,
        title: e.title,
        description: e.description,
        category: e.category,
        severity: e.severity,
        status: e.status,
        locationId: e.locationId,
        locationName: e.locationName,
        position: e.position,
        coordSystem: e.coordSystem,
        geoText: e.geoText,
        startTime: e.startTime,
        endTime: e.endTime,
        organizer: e.organizer,
        participantCount: e.participantCount,
        coverImageUrl: e.coverImageUrl,
        tags: e.tags,
        jumpUrl: e.jumpUrl,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
    }));
}

/** 旧 SecondClassActivity：几乎没地方用，迁移期直接空数组返回即可 */
export function unifiedToLegacyActivities(_events: UnifiedCampusEvent[]): SecondClassActivity[] {
    return [];
}

