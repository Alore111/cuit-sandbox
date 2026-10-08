/* ================================================================
   语义色板与双主题
   —— 【关键改造】建模阶段只决定「这块是什么材质」，主题阶段才决定「它现在是什么颜色」。
      生成器里写的是色键（'grass' / 'wall' / 'roof'…），切主题时不重建几何、不重建矩阵，
      只重算本文件末尾那张一维调色板纹理（几何里只存色槽索引）。

   色板留在前端：后端只负责给「类型 → paletteKey」，颜色属于渲染层资产，后端不该懂色彩。
   【二期补充】类型字典可以额外给一对**可选的主色调**（wallColor / roofColor，日景色），
   用来在这个类型上覆盖墙面与屋顶。数据给的只是「一天白天的基调」，墙暗部与夜景
   都由本文件按固定系数派生 —— 因此昼夜两套主题不会因为数据里只有一份颜色而割裂。
================================================================ */

import * as THREE from 'three';
import { HEX_COLOR_PATTERN } from '../../contract';
import type { HeatLevel } from '../../contract';
import type { ThemeName } from '../../types/theme';

/** 全局体素色键：地表、土壤与各类型共用的构件 */
export type GlobalColorKey =
    /* 地表 */
    | 'grass'
    | 'grassHi'
    | 'grassLo'
    | 'grove'
    | 'groveHi'
    | 'canopy'
    | 'canopyHi'
    | 'track'
    | 'trackLo'
    | 'court'
    | 'courtHi'
    | 'pave'
    | 'paveHi'
    | 'concreteRoad'
    | 'concreteRoadHi'
    | 'asphalt'
    | 'asphaltLo'
    | 'bare'
    | 'bareLo'
    | 'water'
    /* 地下层与台基 */
    | 'soil'
    | 'soilLo'
    | 'plinth'
    /* 岛体：岩层（自上而下 soil → rock → rockDeep，rockHi 是夹在中间的亮色带） */
    | 'rock'
    | 'rockHi'
    | 'rockDeep'
    /* 装饰物：灌木、花、飞鸟、路灯灯头 */
    | 'shrub'
    | 'shrubHi'
    | 'flower'
    | 'bird'
    | 'lampGlow'
    /* 建筑通用件 */
    | 'glass'
    | 'glassLit'
    | 'gold'
    | 'metal'
    /* —— 校园实况：热度光柱（4 档） —— */
    | 'heatCritical'
    | 'heatHigh'
    | 'heatMedium'
    | 'heatLow'
    /* —— 校园实况：事件分类色（用于 UI 标签与标记，也可复用在 3D 标记上） —— */
    | 'eventLecture'
    | 'eventCompetition'
    | 'eventPerformance'
    | 'eventSports'
    | 'eventMeeting'
    | 'eventEmergency'
    | 'eventMaintenance'
    | 'eventPromotion'
    | 'eventFestival'
    | 'eventOther'
    /* —— 校园实况：事件严重程度（徽章用） —— */
    | 'severityInfo'
    | 'severityWarning'
    | 'severityUrgent'
    | 'severitySpecial'
    /* —— 校园实况：二课模块色 —— */
    | 'modThought'
    | 'modVolunteer'
    | 'modAcademic'
    | 'modInnovation'
    | 'modArt'
    | 'modSports'
    | 'modPractice'
    | 'modSkill'
    | 'modOther'
    /* —— 校园实况：活动级别色 —— */
    | 'lvlNational'
    | 'lvlProvincial'
    | 'lvlMunicipal'
    | 'lvlSchool'
    | 'lvlCollege'
    | 'lvlClub';

/** 建筑类型件：颜色由该栋的 paletteKey 决定（见 BuildingSwatch） */
export type BuildingPartKey = 'wall' | 'wallLo' | 'roof' | 'trim';

export type VoxelColorKey = GlobalColorKey | BuildingPartKey;

export interface BuildingSwatch {
    wall: number;
    wallLo: number;
    roof: number;
    trim: number;
}

export interface ThemeConfig {
    name: ThemeName;
    /** 全局色键 */
    voxel: Record<GlobalColorKey, number>;
    /** 建筑配色组：key = 建筑类型字典里的 paletteKey */
    building: Record<string, BuildingSwatch>;
    /** 雾：颜色 + 起止距离（相对校园对角线，便于随规模缩放） */
    fog: { color: number; nearRatio: number; farRatio: number };
    /** 天空：穹顶渐变、星空、云、日月（二期） */
    sky: SkyConfig;
    lights: {
        hemisphere: { sky: number; ground: number; intensity: number };
        ambient: { color: number; intensity: number };
        key: { color: number; intensity: number };
        fill: { color: number; intensity: number };
    };
    exposure: number;
    bloom: { strength: number; radius: number; threshold: number };
    material: { roughness: number; metalness: number };
    water: { emissive: number; opacity: number; roughness: number; metalness: number };
    /** 路灯灯头的自发光强度：夜间拉高吃满泛光，白天压到近 0 表示「灯没开」 */
    lamp: { emissiveIntensity: number };
    /** 萤火虫的整体不透明度：白天为 0，即整体隐藏 */
    fireflies: { opacity: number };
    /** 岛底云霭：颜色 + 不透明度（只作用于光与色，不改变云团的几何） */
    islandMist: { color: number; opacity: number };
}

/** 天空配置：全部是「只作用于光与色」的参数，切换不改变几何 */
export interface SkyConfig {
    /** 穹顶竖向渐变：天顶 → 地平线 → 下方（岛底方向） */
    dome: { top: number; horizon: number; bottom: number };
    /** 星空整体不透明度（白天为 0，即整体隐藏） */
    starOpacity: number;
    /** 云团颜色与不透明度 */
    cloud: { color: number; opacity: number };
    /** 日月球体：本体色 / 自发光色 / 相对尺寸 */
    orb: { body: number; glow: number; scale: number };
}

/* ----------------------------------------------------------------
   night：夜沙盘 —— 近黑暖底 + 琥珀金高光，数值沿用 DEMO 的 palette.js
   二期「主题即昼夜」：夜晚是城市灯火，玻璃多为点亮态
---------------------------------------------------------------- */

const NIGHT: ThemeConfig = {
    name: 'night',
    voxel: {
        grass: 0x2f4a24,
        grassHi: 0x3a5a2c,
        grassLo: 0x243b1d,
        grove: 0x1f3519,
        groveHi: 0x27421f,
        canopy: 0x26401d,
        canopyHi: 0x2f4d24,
        track: 0x7a3a2a,
        trackLo: 0x5e2c20,
        court: 0x2a4c58,
        courtHi: 0x346072,
        pave: 0x4b463d,
        paveHi: 0x5b554a,
        /* 水泥路比铺装亮一档，沥青最深：三者构成浅 → 中 → 深的明度阶梯 */
        concreteRoad: 0x6a635a,
        concreteRoadHi: 0x7a7268,
        asphalt: 0x3b3730,
        asphaltLo: 0x2c2924,
        bare: 0x4a3d2b,
        bareLo: 0x3a2f21,
        water: 0x14333d,
        soil: 0x3a3229,
        soilLo: 0x272119,
        plinth: 0x36322b,
        rock: 0x2f2a24,
        rockHi: 0x453d31,
        rockDeep: 0x1d1a16,
        shrub: 0x27401f,
        shrubHi: 0x33512a,
        flower: 0xb87f9e,
        bird: 0x8c98b0,
        lampGlow: 0xffd48a,
        glass: 0x304a55,
        glassLit: 0xffc06a,
        gold: 0xffc964,
        metal: 0x6e6860,
        /* 校园实况·热度 */
        heatCritical: 0xff3b5c,
        heatHigh: 0xff8a3d,
        heatMedium: 0xf5c043,
        heatLow: 0x59d1a3,
        /* 校园实况·事件分类 */
        eventLecture: 0x7aa8ff,
        eventCompetition: 0xff9a76,
        eventPerformance: 0xd47bff,
        eventSports: 0x5ecf8a,
        eventMeeting: 0x88c5d4,
        eventEmergency: 0xff4d52,
        eventMaintenance: 0xb4896a,
        eventPromotion: 0xffb347,
        eventFestival: 0xff77aa,
        eventOther: 0x8a96b0,
        /* 校园实况·事件严重程度 */
        severityInfo: 0x7aa8ff,
        severityWarning: 0xffb347,
        severityUrgent: 0xff4d52,
        severitySpecial: 0xd47bff,
        /* 校园实况·二课模块 */
        modThought: 0xe86a5a,
        modVolunteer: 0x5ac27a,
        modAcademic: 0x6a9cff,
        modInnovation: 0xffa94d,
        modArt: 0xd874d4,
        modSports: 0x66c8a2,
        modPractice: 0xb09670,
        modSkill: 0x6db9c9,
        modOther: 0x8a96b0,
        /* 校园实况·活动级别 */
        lvlNational: 0xff4d52,
        lvlProvincial: 0xff8a3d,
        lvlMunicipal: 0xf5c043,
        lvlSchool: 0x5ecf8a,
        lvlCollege: 0x6a9cff,
        lvlClub: 0x8a96b0
    },
    building: {
        library: { wall: 0xd8cdb4, wallLo: 0xb0a68f, roof: 0x8d7f63, trim: 0xffc964 },
        teaching: { wall: 0xc9c0ae, wallLo: 0xa19a8b, roof: 0x7d7669, trim: 0xd8b878 },
        academic: { wall: 0xc2bcae, wallLo: 0x9c978b, roof: 0x787366, trim: 0xb8a888 },
        office: { wall: 0xd2c6ad, wallLo: 0xaba089, roof: 0x86795f, trim: 0xffc964 },
        dorm: { wall: 0xc7bfb2, wallLo: 0x9f998d, roof: 0x7a746a, trim: 0xc0a878 },
        canteen: { wall: 0xd0bfa2, wallLo: 0xa89a80, roof: 0x86765c, trim: 0xe0a060 },
        sports: { wall: 0xc4b8a2, wallLo: 0x9c927e, roof: 0x7e7566, trim: 0xffd47a },
        tower: { wall: 0xd6c8a8, wallLo: 0xaea288, roof: 0x8a7a58, trim: 0xffc964 },
        clinic: { wall: 0xd4cfc4, wallLo: 0xaba79e, roof: 0x84807a, trim: 0x8fd8a8 },
        observatory: { wall: 0xbcc4bb, wallLo: 0x959c94, roof: 0x6f756e, trim: 0x9fd0c0 },
        /* 天桥：桥面偏冷灰、立柱偏深、矮栏用强调色 */
        skywalk: { wall: 0x93a0a8, wallLo: 0x717d85, roof: 0x525b62, trim: 0xffc964 },
        generic: { wall: 0xc5bcaa, wallLo: 0x9d9a8d, roof: 0x79736a, trim: 0xc8b088 }
    },
    fog: { color: 0x121a33, nearRatio: 1.2, farRatio: 4 },
    sky: {
        dome: { top: 0x081026, horizon: 0x1e2a52, bottom: 0x060a16 },
        starOpacity: 1,
        cloud: { color: 0x39435f, opacity: 0.34 },
        orb: { body: 0xf4f6ee, glow: 0xa8c0ff, scale: 1 }
    },
    lights: {
        /* 夜晚只留冷月光与极弱环境光：主体亮度靠窗光与路灯的自发光撑起来 */
        hemisphere: { sky: 0x263355, ground: 0x07090f, intensity: 0.62 },
        ambient: { color: 0x141d33, intensity: 0.38 },
        key: { color: 0xc4d6ff, intensity: 1.25 },
        fill: { color: 0x33456b, intensity: 0.34 }
    },
    exposure: 1.08,
    bloom: { strength: 0.62, radius: 0.75, threshold: 0.6 },
    material: { roughness: 0.78, metalness: 0.05 },
    water: { emissive: 0x0b2630, opacity: 0.88, roughness: 0.16, metalness: 0.4 },
    lamp: { emissiveIntensity: 2.4 },
    fireflies: { opacity: 0.92 },
    /* 夜里的岛底云霭要压得比白天更暗：它是雾，不该比岛体本身还亮 */
    islandMist: { color: 0x46527a, opacity: 0.2 }
};

/* ----------------------------------------------------------------
   day：日景沙盘 —— 地表提亮、建筑浅暖白、阴影偏冷。
   注意这是「白天」而不是「把夜晚反色」：色相关系保持现实（跑道砖红、球场冷青），
   只把整体明度抬起来、把自发光压下去。
---------------------------------------------------------------- */

const DAY: ThemeConfig = {
    name: 'day',
    voxel: {
        grass: 0x8fb96a,
        grassHi: 0x9dc77a,
        grassLo: 0x7ea85c,
        grove: 0x5f8a4a,
        groveHi: 0x6d9a55,
        canopy: 0x5a8a45,
        canopyHi: 0x6b9c52,
        track: 0xb5604a,
        trackLo: 0xa2503d,
        court: 0x4f8fa8,
        courtHi: 0x5da0b8,
        pave: 0xc9c3b6,
        paveHi: 0xd6d0c4,
        concreteRoad: 0xdcd8cf,
        concreteRoadHi: 0xe8e4dc,
        asphalt: 0x8d8880,
        asphaltLo: 0x7d7871,
        bare: 0xc0a273,
        bareLo: 0xac8f60,
        water: 0x5aa8c4,
        soil: 0xb09a80,
        soilLo: 0x8e7a63,
        plinth: 0xb8b2a4,
        rock: 0x8b8172,
        rockHi: 0xa79b86,
        rockDeep: 0x5d564b,
        shrub: 0x5d8a45,
        shrubHi: 0x6f9c52,
        flower: 0xe08fb8,
        bird: 0x3a4356,
        lampGlow: 0xfff0c8,
        glass: 0x7c9aa8,
        glassLit: 0xfff2cc,
        gold: 0xe8a838,
        metal: 0x8a867e,
        /* 校园实况·热度（白天配色：更鲜艳饱和） */
        heatCritical: 0xff2d55,
        heatHigh: 0xff7a2e,
        heatMedium: 0xf5b320,
        heatLow: 0x3cc491,
        /* 校园实况·事件分类 */
        eventLecture: 0x5b8def,
        eventCompetition: 0xff8256,
        eventPerformance: 0xc85cff,
        eventSports: 0x3fc27a,
        eventMeeting: 0x5eb2c6,
        eventEmergency: 0xff3d45,
        eventMaintenance: 0xaa7754,
        eventPromotion: 0xff9f2e,
        eventFestival: 0xff5b9a,
        eventOther: 0x7080a0,
        /* 校园实况·事件严重程度 */
        severityInfo: 0x5b8def,
        severityWarning: 0xff9f2e,
        severityUrgent: 0xff3d45,
        severitySpecial: 0xc85cff,
        /* 校园实况·二课模块 */
        modThought: 0xe05045,
        modVolunteer: 0x39bf6a,
        modAcademic: 0x4f88f5,
        modInnovation: 0xff8c2a,
        modArt: 0xcc58c8,
        modSports: 0x3bb68a,
        modPractice: 0xa88a5a,
        modSkill: 0x4aa8bd,
        modOther: 0x7080a0,
        /* 校园实况·活动级别 */
        lvlNational: 0xff3d45,
        lvlProvincial: 0xff7a2e,
        lvlMunicipal: 0xf5b320,
        lvlSchool: 0x3fc27a,
        lvlCollege: 0x4f88f5,
        lvlClub: 0x7080a0
    },
    building: {
        library: { wall: 0xf2ece0, wallLo: 0xd8d1c2, roof: 0xb9a985, trim: 0xe8a838 },
        teaching: { wall: 0xeee7da, wallLo: 0xd2cbbe, roof: 0xafa691, trim: 0xd9b476 },
        academic: { wall: 0xe8e3d8, wallLo: 0xcdc7bb, roof: 0xaba391, trim: 0xc0ac8a },
        office: { wall: 0xf4ecdd, wallLo: 0xd8d0bf, roof: 0xbcae90, trim: 0xe8a838 },
        dorm: { wall: 0xece6db, wallLo: 0xd0cabd, roof: 0xb0a895, trim: 0xcbb185 },
        canteen: { wall: 0xf2e8d2, wallLo: 0xd6ccb6, roof: 0xbcab8b, trim: 0xe0a55f },
        sports: { wall: 0xe9e3d6, wallLo: 0xcdc7ba, roof: 0xafa894, trim: 0xf0c860 },
        tower: { wall: 0xf5eedd, wallLo: 0xd9d2c0, roof: 0xc2b18a, trim: 0xe8a838 },
        clinic: { wall: 0xf0efe9, wallLo: 0xd4d3cd, roof: 0xb8b7b0, trim: 0x6fbf8a },
        observatory: { wall: 0xe4e9e4, wallLo: 0xc9cec9, roof: 0xa9b0ab, trim: 0x7ec0ac },
        skywalk: { wall: 0xc9d3d8, wallLo: 0xafb9be, roof: 0x8e9aa1, trim: 0xe8a838 },
        generic: { wall: 0xe9e4d9, wallLo: 0xcec9bd, roof: 0xaea895, trim: 0xcbb48d }
    },
    fog: { color: 0xcfe2f2, nearRatio: 1.6, farRatio: 7 },
    sky: {
        dome: { top: 0x2f7fd4, horizon: 0xd6ebfa, bottom: 0xa8c6dc },
        starOpacity: 0,
        cloud: { color: 0xffffff, opacity: 0.9 },
        orb: { body: 0xfff6d2, glow: 0xffd070, scale: 1 }
    },
    lights: {
        /* 白天整体通透且光比清晰：主光强、环境光与补光压低，阴影才有存在感 */
        hemisphere: { sky: 0xe8f4ff, ground: 0xa8b090, intensity: 1.25 },
        ambient: { color: 0xc8d8e6, intensity: 0.42 },
        key: { color: 0xfff2d8, intensity: 2.5 },
        fill: { color: 0xa8ccf0, intensity: 0.35 }
    },
    exposure: 0.95,
    bloom: { strength: 0.1, radius: 0.55, threshold: 0.92 },
    material: { roughness: 0.72, metalness: 0.04 },
    water: { emissive: 0x2a6a86, opacity: 0.9, roughness: 0.12, metalness: 0.2 },
    lamp: { emissiveIntensity: 0.05 },
    fireflies: { opacity: 0 },
    islandMist: { color: 0xf2f7fc, opacity: 0.34 }
};

export const THEMES: Record<ThemeName, ThemeConfig> = { night: NIGHT, day: DAY };

/** 4 档热度等级 → 色键映射，供热力柱渲染器直接查表 */
export const HEAT_PALETTE_KEYS: Record<HeatLevel, GlobalColorKey> = {
    critical: 'heatCritical',
    high: 'heatHigh',
    medium: 'heatMedium',
    low: 'heatLow',
};

const BUILDING_PARTS: readonly BuildingPartKey[] = ['wall', 'wallLo', 'roof', 'trim'];

function isBuildingPartKey(key: VoxelColorKey): key is BuildingPartKey {
    return (BUILDING_PARTS as readonly string[]).includes(key);
}

/* ----------------------------------------------------------------
   类型主色调：数据里的 wallColor / roofColor → 一整套构件颜色
   —— 数据只写一份**日景**主色，其余两档由下面的系数派生，规则固定且全局一致：
        墙暗部 = 主色降明度、再降饱和（手调色板里「暗部偏灰」的观感）
        夜景   = 主色压明度、轻降饱和
      系数是拿现有手调色板反推出来的，不是拍脑袋 —— 用 library 一对实测：
        日景墙 0xf2ece0 → 日景墙暗部 0xd8d1c2：本规则得 0xd9d1c1
        日景墙 0xf2ece0 → 夜景墙     0xd8cdb4：本规则得 0xdbcdb1
      误差在 3/255 以内。其它类型本来就是一型一手调，按统一规则派生会有几级的差异，
      这是刻意接受的：规则可解释、可复现，比逐类型留一套系数重要。
---------------------------------------------------------------- */

/** 墙暗部相对墙面的明度 / 饱和度保留系数 */
const WALL_LOW_LIGHTNESS_KEEP = 0.88;
const WALL_LOW_SATURATION_KEEP = 0.6;

/** 夜景化的明度 / 饱和度保留系数 */
const NIGHT_LIGHTNESS_KEEP = 0.85;
const NIGHT_SATURATION_KEEP = 0.9;

/** 数据里的类型主色调：两项都可缺，缺即「跟随色板」（不派生任何颜色） */
export interface BuildingTint {
    wallColor?: string | null;
    roofColor?: string | null;
}

/** #rrggbb → 0xrrggbb；格式不对直接抛错 —— 后端已校验，这里不兜底也不猜 */
function parseHexColor(hex: string): number {
    if (!HEX_COLOR_PATTERN.test(hex)) {
        throw new Error(`建筑主色调不是 #rrggbb 形式的颜色：${hex}`);
    }
    return Number.parseInt(hex.slice(1), 16);
}

/**
 * 在 HSL 空间按系数缩放明度与饱和度（色相不动），返回新的颜色值。
 * 【必须显式指定 SRGBColorSpace】three 的 getHSL / setHSL 默认在**工作色空间**（线性）里算，
 * 而色板里所有数值都是 sRGB 的显示值 —— 不指定就会在两种空间之间来回换算，
 * 派生结果与「按手调色板反推出来的系数」对不上（实测夜墙会偏亮一档）。
 */
function scaleHsl(color: number, lightnessKeep: number, saturationKeep: number): number {
    const hsl = { h: 0, s: 0, l: 0 };
    new THREE.Color(color).getHSL(hsl, THREE.SRGBColorSpace);

    return new THREE.Color()
        .setHSL(
            hsl.h,
            Math.min(1, hsl.s * saturationKeep),
            Math.min(1, hsl.l * lightnessKeep),
            THREE.SRGBColorSpace
        )
        .getHex();
}

/**
 * 把类型主色调叠到色板配色组上。
 * 未给主的那个构件原样返回色板值：同一栋楼允许「墙用主色、顶跟随色板」，反之亦然。
 */
function applyBuildingTint(
    theme: ThemeName,
    swatch: BuildingSwatch,
    tint: BuildingTint | undefined
): BuildingSwatch {
    const wallColor = tint?.wallColor ?? null;
    const roofColor = tint?.roofColor ?? null;
    if (!wallColor && !roofColor) return swatch;

    /* 夜景系数直接乘进派生系数：两步都是同一组分量的等比缩放，合成即系数相乘 */
    const light = theme === 'night' ? NIGHT_LIGHTNESS_KEEP : 1;
    const sat = theme === 'night' ? NIGHT_SATURATION_KEEP : 1;

    return {
        wall: wallColor
            ? scaleHsl(parseHexColor(wallColor), light, sat)
            : swatch.wall,
        /* 墙暗部：目前还没有生成器用到这一档（色板里预留的「墙面暗部」），
           一并派生是为了让整组配色同源 —— 将来哪个做法要用它，颜色一定是对的 */
        wallLo: wallColor
            ? scaleHsl(
                  parseHexColor(wallColor),
                  light * WALL_LOW_LIGHTNESS_KEEP,
                  sat * WALL_LOW_SATURATION_KEEP
              )
            : swatch.wallLo,
        roof: roofColor
            ? scaleHsl(parseHexColor(roofColor), light, sat)
            : swatch.roof,
        /* 腰线/矮栏不跟主色调走：它要的是与墙面对比的强调色，交给色板 */
        trim: swatch.trim
    };
}

/**
 * 取某个全局色键的颜色（地皮色块的解析也走这里）。
 * 【口径】色板里每个键都必须在两套主题下存在：缺键一律抛错 ——
 * 宁可启动即失败，也不要静默用灰色把配色问题藏起来。
 */
export function resolveGlobalColor(theme: ThemeName, key: GlobalColorKey): number {
    const color = THEMES[theme].voxel[key];
    if (color === undefined) {
        throw new Error(`色板缺少颜色键「${key}」（主题 ${theme}）`);
    }
    return color;
}

/* ----------------------------------------------------------------
   GPU 调色板：昼夜过渡的取色通道
   —— 过渡期间若逐帧重写全部顶点色，实测单帧 ≈50ms，还要重传 68.7MB 顶点色
      缓冲（150 万个暴露面），必然卡顿。改成：
        · 几何只存「色槽索引」（Uint16，逐顶点 2 字节，总共 ≈12MB）；
        · 颜色统一由下面这张一维调色板纹理提供；
        · 换色只写 PALETTE_WIDTH 个 texel 并上传一次，开销与面数无关。
      色槽在建模时按「实际用到的色键」注册，索引一经分配便不再变化，
      因此 night / day / DAWN 与过渡插值的中间色共用同一套索引，几何完全不动。
---------------------------------------------------------------- */

/** 调色板纹理宽度（texel 数）：注册的色槽总数不得超过它 */
export const PALETTE_WIDTH = 1024;

/** 建筑配色组的身份：paletteKey + 类型主色调（同一组合的取色结果必然一致） */
interface SwatchGroup {
    readonly paletteKey: string;
    readonly tint: BuildingTint | undefined;
    /** 该组四个构件色槽的起始索引，按 BUILDING_PARTS 顺序连续排列 */
    readonly base: number;
}

/** 一个色槽：全局色键，或「某个建筑配色组的某个构件」 */
type ColorSlot =
    | { readonly kind: 'voxel'; readonly key: GlobalColorKey }
    | { readonly kind: 'building'; readonly group: SwatchGroup; readonly part: BuildingPartKey };

/** 色键 → 色槽索引；过渡期间索引恒定，颜色变化全部由调色板纹理承担 */
export type SlotLookup = (key: VoxelColorKey) => number;

const slots: ColorSlot[] = [];
const voxelSlots = new Map<GlobalColorKey, number>();
const swatchGroups = new Map<string, SwatchGroup>();

function pushSlot(slot: ColorSlot): number {
    if (slots.length >= PALETTE_WIDTH) {
        throw new Error(
            `色槽数量超过调色板容量 ${PALETTE_WIDTH}：请调大 palette.ts 的 PALETTE_WIDTH`
        );
    }
    slots.push(slot);
    return slots.length - 1;
}

/** 全局色键的色槽：一个键一个槽，跨 mesh 去重 */
function voxelSlot(key: GlobalColorKey): number {
    const known = voxelSlots.get(key);
    if (known !== undefined) return known;

    const index = pushSlot({ kind: 'voxel', key });
    voxelSlots.set(key, index);
    return index;
}

/** 建筑配色组的色槽：四个构件连续占四个槽，同组合跨 mesh 去重 */
function swatchGroup(paletteKey: string, tint: BuildingTint | undefined): SwatchGroup {
    const id = `${paletteKey}|${tint?.wallColor ?? ''}|${tint?.roofColor ?? ''}`;
    const known = swatchGroups.get(id);
    if (known) return known;

    const group: SwatchGroup = { paletteKey, tint, base: slots.length };
    for (const part of BUILDING_PARTS) pushSlot({ kind: 'building', group, part });
    swatchGroups.set(id, group);
    return group;
}

/**
 * 造「色键 → 色槽索引」的查询函数，几何在建模时按它逐面写色槽。
 * 建筑色键需要该栋的 paletteKey，缺失即抛错（与取色同一条口径）。
 */
export function createSlotLookup(buildingPaletteKey?: string, tint?: BuildingTint): SlotLookup {
    const group = buildingPaletteKey ? swatchGroup(buildingPaletteKey, tint) : undefined;

    return (key: VoxelColorKey): number => {
        if (!isBuildingPartKey(key)) return voxelSlot(key);
        if (!group) {
            throw new Error(`体素使用了建筑色键「${key}」但没有提供 paletteKey`);
        }
        return group.base + BUILDING_PARTS.indexOf(key);
    };
}

/**
 * 调色板纹理：RGBA32F / NEAREST / 无 mipmap。
 * 顶点着色器按色槽索引 NEAREST 取色，所以只要 1 个 texel 高、不需要过滤。
 * 存线性色值（与原先顶点色缓冲里的数值同源），不参与色彩空间转换。
 */
const paletteData = new Float32Array(PALETTE_WIDTH * 4);

export const PALETTE_TEXTURE = new THREE.DataTexture(
    paletteData,
    PALETTE_WIDTH,
    1,
    THREE.RGBAFormat,
    THREE.FloatType
);
PALETTE_TEXTURE.magFilter = THREE.NearestFilter;
PALETTE_TEXTURE.minFilter = THREE.NearestFilter;
PALETTE_TEXTURE.generateMipmaps = false;
PALETTE_TEXTURE.wrapS = THREE.ClampToEdgeWrapping;
PALETTE_TEXTURE.wrapT = THREE.ClampToEdgeWrapping;

const slotColor = new THREE.Color();
const slotSwatches = new Map<SwatchGroup, BuildingSwatch>();

/**
 * 按配置重算整张调色板并标记上传。
 * 这是昼夜过渡每帧唯一需要的「颜色工作」，开销只与色槽数量有关、与几何规模无关。
 * 建筑配色组每帧只派生一次（同组四个构件共用）。
 */
export function writePalette(config: ThemeConfig): void {
    slotSwatches.clear();

    for (let index = 0; index < slots.length; index += 1) {
        const slot = slots[index];
        let color: number;

        if (slot.kind === 'voxel') {
            color = config.voxel[slot.key];
            if (color === undefined) {
                throw new Error(`色板缺少颜色键「${slot.key}」（主题 ${config.name}）`);
            }
        } else {
            let swatch = slotSwatches.get(slot.group);
            if (!swatch) {
                const base = config.building[slot.group.paletteKey];
                if (!base) {
                    throw new Error(
                        `建筑配色缺少 paletteKey「${slot.group.paletteKey}」：请检查建筑类型字典与 palette.ts 的 building 表（主题 ${config.name}）`
                    );
                }
                swatch = applyBuildingTint(config.name, base, slot.group.tint);
                slotSwatches.set(slot.group, swatch);
            }
            color = swatch[slot.part];
        }

        slotColor.setHex(color);
        const at = index * 4;
        paletteData[at] = slotColor.r;
        paletteData[at + 1] = slotColor.g;
        paletteData[at + 2] = slotColor.b;
        paletteData[at + 3] = 1;
    }

    PALETTE_TEXTURE.needsUpdate = true;
}

/* ----------------------------------------------------------------
   主题插值：昼夜过渡动画的颜色混合工具
   —— 过渡期间每帧生成一个「插值 ThemeConfig」，所有子模块按它重写着色，
      不重建几何、不重建矩阵。
---------------------------------------------------------------- */

const _c = new THREE.Color();
const _c2 = new THREE.Color();

/** 两个 0x 整数颜色在 sRGB 空间线性插值 */
export function lerpHexColor(a: number, b: number, t: number): number {
    _c.setHex(a);
    _c2.setHex(b);
    _c.lerp(_c2, t);
    return _c.getHex();
}

/** 从主题名或完整配置中解析出 ThemeConfig */
export function resolveThemeConfig(themeOrConfig: ThemeName | ThemeConfig): ThemeConfig {
    return typeof themeOrConfig === 'string' ? THEMES[themeOrConfig] : themeOrConfig;
}

/**
 * 在两个 ThemeConfig 之间做线性插值，返回一个新的完整配置。
 * t=0 返回 a 的克隆，t=1 返回 b 的克隆。
 * 颜色在 sRGB 空间混合，标量直接线性插值。
 */
export function lerpThemeConfig(a: ThemeConfig, b: ThemeConfig, t: number): ThemeConfig {
    /* 全局色键 */
    const voxel = {} as Record<GlobalColorKey, number>;
    for (const key of Object.keys(a.voxel) as GlobalColorKey[]) {
        voxel[key] = lerpHexColor(a.voxel[key], b.voxel[key], t);
    }

    /* 建筑配色组 */
    const building = {} as Record<string, BuildingSwatch>;
    for (const key of Object.keys(a.building)) {
        const sa = a.building[key];
        const sb = b.building[key];
        building[key] = {
            wall: lerpHexColor(sa.wall, sb.wall, t),
            wallLo: lerpHexColor(sa.wallLo, sb.wallLo, t),
            roof: lerpHexColor(sa.roof, sb.roof, t),
            trim: lerpHexColor(sa.trim, sb.trim, t)
        };
    }

    /* 雾 */
    const fog = {
        color: lerpHexColor(a.fog.color, b.fog.color, t),
        nearRatio: a.fog.nearRatio + (b.fog.nearRatio - a.fog.nearRatio) * t,
        farRatio: a.fog.farRatio + (b.fog.farRatio - a.fog.farRatio) * t
    };

    /* 天空 */
    const sky = {
        dome: {
            top: lerpHexColor(a.sky.dome.top, b.sky.dome.top, t),
            horizon: lerpHexColor(a.sky.dome.horizon, b.sky.dome.horizon, t),
            bottom: lerpHexColor(a.sky.dome.bottom, b.sky.dome.bottom, t)
        },
        starOpacity: a.sky.starOpacity + (b.sky.starOpacity - a.sky.starOpacity) * t,
        cloud: {
            color: lerpHexColor(a.sky.cloud.color, b.sky.cloud.color, t),
            opacity: a.sky.cloud.opacity + (b.sky.cloud.opacity - a.sky.cloud.opacity) * t
        },
        orb: {
            body: lerpHexColor(a.sky.orb.body, b.sky.orb.body, t),
            glow: lerpHexColor(a.sky.orb.glow, b.sky.orb.glow, t),
            scale: a.sky.orb.scale + (b.sky.orb.scale - a.sky.orb.scale) * t
        }
    };

    /* 灯光 */
    const lights = {
        hemisphere: {
            sky: lerpHexColor(a.lights.hemisphere.sky, b.lights.hemisphere.sky, t),
            ground: lerpHexColor(a.lights.hemisphere.ground, b.lights.hemisphere.ground, t),
            intensity: a.lights.hemisphere.intensity + (b.lights.hemisphere.intensity - a.lights.hemisphere.intensity) * t
        },
        ambient: {
            color: lerpHexColor(a.lights.ambient.color, b.lights.ambient.color, t),
            intensity: a.lights.ambient.intensity + (b.lights.ambient.intensity - a.lights.ambient.intensity) * t
        },
        key: {
            color: lerpHexColor(a.lights.key.color, b.lights.key.color, t),
            intensity: a.lights.key.intensity + (b.lights.key.intensity - a.lights.key.intensity) * t
        },
        fill: {
            color: lerpHexColor(a.lights.fill.color, b.lights.fill.color, t),
            intensity: a.lights.fill.intensity + (b.lights.fill.intensity - a.lights.fill.intensity) * t
        }
    };

    /* 标量参数 */
    const exposure = a.exposure + (b.exposure - a.exposure) * t;
    const bloom = {
        strength: a.bloom.strength + (b.bloom.strength - a.bloom.strength) * t,
        radius: a.bloom.radius + (b.bloom.radius - a.bloom.radius) * t,
        threshold: a.bloom.threshold + (b.bloom.threshold - a.bloom.threshold) * t
    };
    const material = {
        roughness: a.material.roughness + (b.material.roughness - a.material.roughness) * t,
        metalness: a.material.metalness + (b.material.metalness - a.material.metalness) * t
    };
    const water = {
        emissive: lerpHexColor(a.water.emissive, b.water.emissive, t),
        opacity: a.water.opacity + (b.water.opacity - a.water.opacity) * t,
        roughness: a.water.roughness + (b.water.roughness - a.water.roughness) * t,
        metalness: a.water.metalness + (b.water.metalness - a.water.metalness) * t
    };
    const lamp = {
        emissiveIntensity: a.lamp.emissiveIntensity + (b.lamp.emissiveIntensity - a.lamp.emissiveIntensity) * t
    };
    const fireflies = {
        opacity: a.fireflies.opacity + (b.fireflies.opacity - a.fireflies.opacity) * t
    };
    const islandMist = {
        color: lerpHexColor(a.islandMist.color, b.islandMist.color, t),
        opacity: a.islandMist.opacity + (b.islandMist.opacity - a.islandMist.opacity) * t
    };

    return {
        name: t < 0.5 ? a.name : b.name,
        voxel, building, fog, sky, lights,
        exposure, bloom, material, water, lamp, fireflies, islandMist
    };
}

/* ----------------------------------------------------------------
   日出 / 日落中间态色板
   —— 线性插值 night↔day 的中间色偏冷灰，不是真实的日出暖色。
      这里显式定义 DAWN（日出）色板，过渡时走 night→DAWN→day 三段插值，
      确保中间态有暖橙地平线、低角度暖光等写实特征。
      DUSK（日落）与 DAWN 共用同一套色板，反向播放即为日落。
---------------------------------------------------------------- */

export const DAWN: ThemeConfig = {
    name: 'day',
    voxel: {
        grass: 0x5e8a3e, grassHi: 0x6d9a48, grassLo: 0x4e7530,
        grove: 0x3f5e2e, groveHi: 0x4a7035, canopy: 0x406830, canopyHi: 0x4e7a38,
        track: 0x9a4e38, trackLo: 0x84402e, court: 0x3e6e80, courtHi: 0x4a8090,
        pave: 0x8a8070, paveHi: 0x9a9080,
        concreteRoad: 0xa09888, concreteRoadHi: 0xb0a898,
        asphalt: 0x605850, asphaltLo: 0x4e4840,
        bare: 0x8a7050, bareLo: 0x786040, water: 0x3a7898,
        soil: 0x7a6850, soilLo: 0x5e5040, plinth: 0x7a7468,
        rock: 0x5e5648, rockHi: 0x7a6e5e, rockDeep: 0x3e3830,
        shrub: 0x406830, shrubHi: 0x508038, flower: 0xc888a8, bird: 0x606878,
        lampGlow: 0xffe0a0, glass: 0x587888, glassLit: 0xffd898,
        gold: 0xf0b848, metal: 0x7a7670,
        heatCritical: 0xff3558, heatHigh: 0xff8538, heatMedium: 0xf5ba40, heatLow: 0x4cd09a,
        eventLecture: 0x6898ff, eventCompetition: 0xff9068, eventPerformance: 0xcc6cff,
        eventSports: 0x4eca82, eventMeeting: 0x78bed0, eventEmergency: 0xff4848,
        eventMaintenance: 0xb08060, eventPromotion: 0xffa838, eventFestival: 0xff68a0,
        eventOther: 0x8090a8,
        severityInfo: 0x6898ff, severityWarning: 0xffa838, severityUrgent: 0xff4848,
        severitySpecial: 0xcc6cff,
        modThought: 0xe46050, modVolunteer: 0x4ec070, modAcademic: 0x5c90ff,
        modInnovation: 0xff9a3a, modArt: 0xd068d0, modSports: 0x50c090,
        modPractice: 0xb09068, modSkill: 0x5cb0c0, modOther: 0x8090a8,
        lvlNational: 0xff4848, lvlProvincial: 0xff8538, lvlMunicipal: 0xf5ba40,
        lvlSchool: 0x4eca82, lvlCollege: 0x5c90ff, lvlClub: 0x8090a8
    },
    building: {
        library: { wall: 0xe8dcc8, wallLo: 0xc0b498, roof: 0xa09070, trim: 0xf0b848 },
        teaching: { wall: 0xdcd4c4, wallLo: 0xb4ae9e, roof: 0x908878, trim: 0xd8b478 },
        academic: { wall: 0xd5d0c4, wallLo: 0xb0ab9e, roof: 0x8e8878, trim: 0xc0a888 },
        office: { wall: 0xe4d8c4, wallLo: 0xbca888, roof: 0x9e8e6e, trim: 0xf0b848 },
        dorm: { wall: 0xdad2c8, wallLo: 0xb2aa9e, roof: 0x948c80, trim: 0xc8ac80 },
        canteen: { wall: 0xe0d0b8, wallLo: 0xb8a88e, roof: 0xa0906e, trim: 0xe0a060 },
        sports: { wall: 0xd6ccba, wallLo: 0xaea48e, roof: 0x948a7e, trim: 0xf0c868 },
        tower: { wall: 0xe6dab8, wallLo: 0xbea888, roof: 0xa49468, trim: 0xf0b848 },
        clinic: { wall: 0xe2ddd4, wallLo: 0xbab6ae, roof: 0x9e9a94, trim: 0x80c898 },
        observatory: { wall: 0xd0d8d0, wallLo: 0xa8b0a8, roof: 0x848c84, trim: 0x90c8b0 },
        skywalk: { wall: 0xaeb8c0, wallLo: 0x8e98a0, roof: 0x6e7880, trim: 0xf0b848 },
        generic: { wall: 0xd8d0c0, wallLo: 0xb0a898, roof: 0x908878, trim: 0xc8b088 }
    },
    fog: { color: 0xd8c8b0, nearRatio: 1.4, farRatio: 5.5 },
    sky: {
        dome: { top: 0x1e4880, horizon: 0xf0a060, bottom: 0x887060 },
        starOpacity: 0.15,
        cloud: { color: 0xffd8b0, opacity: 0.62 },
        orb: { body: 0xffe0a0, glow: 0xff9040, scale: 1.1 }
    },
    lights: {
        hemisphere: { sky: 0x8098b8, ground: 0x483828, intensity: 0.88 },
        ambient: { color: 0x605040, intensity: 0.38 },
        key: { color: 0xffb070, intensity: 1.8 },
        fill: { color: 0x5878a0, intensity: 0.30 }
    },
    exposure: 1.02,
    bloom: { strength: 0.38, radius: 0.65, threshold: 0.72 },
    material: { roughness: 0.75, metalness: 0.045 },
    water: { emissive: 0x1e4a60, opacity: 0.88, roughness: 0.14, metalness: 0.3 },
    lamp: { emissiveIntensity: 0.8 },
    fireflies: { opacity: 0.25 },
    islandMist: { color: 0xd0c0a8, opacity: 0.26 }
};

/* ----------------------------------------------------------------
   建筑视觉状态（交互层驱动）
---------------------------------------------------------------- */

export const BUILDING_STATE = {
    IDLE: 'idle',
    HOVER: 'hover',
    FOCUS: 'focus'
} as const;

export type BuildingState = (typeof BUILDING_STATE)[keyof typeof BUILDING_STATE];

/** 状态 → 目标位移 / 自发光强度 */
export const STATE_VISUAL: Record<BuildingState, { lift: number; glow: number }> = {
    [BUILDING_STATE.IDLE]: { lift: 0, glow: 0 },
    [BUILDING_STATE.HOVER]: { lift: 0.35, glow: 0.3 },
    [BUILDING_STATE.FOCUS]: { lift: 0.7, glow: 0.58 }
};
