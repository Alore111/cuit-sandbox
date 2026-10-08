/* ================================================================
   昼夜过渡控制器
   —— 管理 night↔day 的过渡动画：
      · night→day：走 night → DAWN → day 三段插值（日出暖色）
      · day→night：走 day → DAWN → night 三段插值（日落暖色，反向播放 DAWN）
      · 过渡期间每帧输出一个插值 ThemeConfig + 日月方位，
        场景各模块按它重写着色，不重建几何。
      · 过渡时长 0.8 秒（近瞬时切换，但仍保留可感知的暖色中段）。

   【日月弧线的口径】
   昼夜两个静态主题的日月都固定落在 ORB_DIRECTION（仰角约 45°），主光也按它摆。
   过渡动画的日月弧线必须「首尾都回到 ORB_DIRECTION」：
     · 否则切换收尾的瞬间，主光会从低角度弹回高位，整场光影跳一下；
     · 端点不归位还会让日月留在水平线以下（切回夜晚看不到月亮）。
   因此弧线取「中途压低、两端归位」的形态：过渡中段日月扫到接近地平线，
   产生日出/日落的低角度暖光与长影，随后平滑归位。
================================================================ */

import * as THREE from 'three';
import type { ThemeName } from '../../types/theme';
import { DAWN, THEMES, lerpThemeConfig, type ThemeConfig } from './palette';
import { ORB_DIRECTION } from '../sky/skyField';

/** 过渡总时长（秒） */
const TRANSITION_DURATION = 0.8;

/**
 * 标准日月仰角（度）：直接由 ORB_DIRECTION 反推，
 * 保证弧线两端与静态主题的日月方位完全重合（收尾零跳变）。
 */
const CANONICAL_ELEVATION_DEG = THREE.MathUtils.radToDeg(Math.asin(ORB_DIRECTION.y));

/** 过渡中段日月压低到的最低仰角（度）：制造低角度暖光与长影 */
const DIP_ELEVATION_DEG = 6;

/** ORB_DIRECTION 在水平面的单位投影（方位角方向），按仰角重建日月方位时复用它 */
const ORB_HORIZONTAL = new THREE.Vector2(ORB_DIRECTION.x, ORB_DIRECTION.z).normalize();

const DEG_TO_RAD = Math.PI / 180;

/**
 * smoothstep 缓动：起止平滑，中间稍快。
 * 让过渡开头和结尾有「定住」的感觉，不会突然开始 / 突然停止。
 */
function smoothstep(t: number): number {
    return t * t * (3 - 2 * t);
}

/**
 * 由过渡进度 t（0=起点主题，1=终点主题）推算日月方位。
 *
 * 仰角曲线：两端 = 标准仰角，中段压到 DIP_ELEVATION_DEG，
 * 即 elevation(t) = CANONICAL − (CANONICAL − DIP) · sin(πt)。
 * 水平方位恒定为 ORB_DIRECTION 的方位角，确保与主光方向永远同步。
 */
export function computeCelestialDirection(t: number): THREE.Vector3 {
    const elevation = CANONICAL_ELEVATION_DEG
        - (CANONICAL_ELEVATION_DEG - DIP_ELEVATION_DEG) * Math.sin(Math.PI * t);
    const elevRad = elevation * DEG_TO_RAD;
    const horizontal = Math.cos(elevRad);

    return new THREE.Vector3(
        ORB_HORIZONTAL.x * horizontal,
        Math.sin(elevRad),
        ORB_HORIZONTAL.y * horizontal
    );
}

export interface ThemeTransitionFrame {
    /** 当前帧的插值配置（含天空日月颜色，直接透传给 scene 各模块） */
    config: ThemeConfig;
    /** 当前帧的日月方位（同时驱动天空球体与主光方向） */
    orbDirection: THREE.Vector3;
}

export interface ThemeTransitionController {
    /** 当前是否正在过渡 */
    readonly active: boolean;
    /** 当前过渡的目标主题 */
    readonly targetTheme: ThemeName;
    /** 启动一次新的过渡（支持中途反向） */
    start: (from: ThemeName, to: ThemeName) => void;
    /** 每帧调用，返回当前帧的插值配置与日月方位；未在过渡时返回 null */
    update: (dt: number) => ThemeTransitionFrame | null;
}

export function createThemeTransition(): ThemeTransitionController {
    let active = false;
    let fromTheme: ThemeName = 'night';
    let target: ThemeName = 'day';
    let elapsed = 0;

    function start(from: ThemeName, to: ThemeName): void {
        fromTheme = from;
        target = to;
        elapsed = 0;
        active = true;
    }

    function update(dt: number): ThemeTransitionFrame | null {
        if (!active) return null;

        elapsed += dt;
        const rawT = Math.min(elapsed / TRANSITION_DURATION, 1);

        if (rawT >= 1) {
            /* 终点帧不返回插值配置：由调用方按最终主题走静态 applyTheme 收尾，
               避免停机后再插值一次造成收尾抖动。 */
            active = false;
            return null;
        }

        const t = smoothstep(rawT);

        /* 三段插值：
         * from=night → night → DAWN → day；from=day → day → DAWN → night。
         * 中段经过 DAWN 色板，保证中间态是写实的暖橙地平线而非冷灰。 */
        const [startConfig, endConfig] = fromTheme === 'night'
            ? [THEMES.night, THEMES.day]
            : [THEMES.day, THEMES.night];
        const config = t <= 0.5
            ? lerpThemeConfig(startConfig, DAWN, t * 2)
            : lerpThemeConfig(DAWN, endConfig, (t - 0.5) * 2);

        return { config, orbDirection: computeCelestialDirection(t) };
    }

    return {
        get active() { return active; },
        get targetTheme() { return target; },
        start,
        update
    };
}
