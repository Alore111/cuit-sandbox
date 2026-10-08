/* ================================================================
   信标（Beacon）
   —— 在 3D 地图中标注「某个点位」的醒目光效：
       · 中心一根竖直光柱（交叉薄片 + Additive，底部实、向上消散）；
       · 光柱底部一圈贴地光晕，把锚点本身也照亮；
       · 数十个光斑粒子从锚点沿光柱向上飘动、头尾渐隐，形成「能量上涌」的动态感。

   定位：只关心世界坐标 (x, z) 与高度，不依赖网格/事件；
        调用方拿到 world 坐标后 new Beacon(...) 并 setPosition/setVisible 即可。

   生命周期（与 heatBeams 同款约定）：
       · 构造后把 .group 加入 3D scene；
       · 每帧在渲染循环里调 update(dt)；
       · 主题切换调 applyTheme(theme)；
       · 不再使用时调 dispose()（释放几何/材质/纹理，并把它从场景移除）。
================================================================ */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ThemeName } from '../types/theme';
import { resolveThemeConfig, THEMES, type ThemeConfig } from './theme/palette';

/* ---------------- 配置常量 ---------------- */

/** 光柱底部距地平面的基线高度（世界单位，贴近地表：与事件投影锚点同口径 1.1） */
const DEFAULT_BASE_Y = 1.1;
/** 光柱默认总高（世界单位） */
const DEFAULT_HEIGHT = 240;
/** 光柱交叉薄片宽度（世界单位） */
const SHAFT_WIDTH = 4.2;
/** 光斑粒子数量 */
const PARTICLE_COUNT = 14;
/** 光斑粒子直径（世界单位） */
const PARTICLE_SIZE = 1.15;
/** 光斑相对光柱中心的水平散开半径区间（世界单位） */
const PARTICLE_RADIUS_MIN = 0.5;
const PARTICLE_RADIUS_MAX = 4;
/** 光斑沿光柱上升一圈所需秒数（reducedMotion 下静止） */
const PARTICLE_CYCLE_SEC = 3.4;

/* ---------------- Shader：光柱 ---------------- */

/**
 * 光柱：底部最实、顶部消散；水平方向中心亮、边缘柔。
 * Shader 直接做径向 + 垂直双重衰减，不产生硬轮廓。
 */
const SHAFT_VERTEX = /* glsl */ `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const SHAFT_FRAGMENT = /* glsl */ `
    uniform vec3 uColor;
    uniform float uTime;
    uniform float uBaseOpacity;
    uniform float uDayBoost;
    varying vec2 vUv;
    void main() {
        // 垂直：底部最实，向上柔和消散（幂次越高衰减越快）。
        float vertical = pow(1.0 - vUv.y, 1.5);
        // 水平 1：薄片自身软边（避免与相邻片接缝处的硬边）。
        float edgeFade = smoothstep(0.0, 0.12, vUv.x) * smoothstep(1.0, 0.88, vUv.x);
        // 水平 2：径向——中心线更亮，边缘更暗，体现圆柱的体感。
        float radial = 1.0 - smoothstep(0.0, 0.7, abs(vUv.x - 0.5) * 2.0);
        radial = pow(radial, 1.5);
        // 轻微呼吸，让光柱看起来是活的（不改变高度语义）。
        float breathe = 0.86 + 0.14 * sin(uTime * 0.9 + vUv.y * 2.2);
        float alpha = vertical * edgeFade * mix(0.45, 1.0, radial) * breathe * uBaseOpacity * uDayBoost;
        // 中心颜色更纯饱和，外圈自然淡化。
        vec3 color = uColor * mix(0.82, 1.15, radial) * uDayBoost;
        gl_FragColor = vec4(color * alpha, alpha);
    }
`;

/* ---------------- Shader：地面光晕 ---------------- */

/** 贴地光环：从中心向外缘消散，慢速呼吸，用于把「锚点位置」本身照亮。 */
const HALO_FRAGMENT = /* glsl */ `
    uniform vec3 uColor;
    uniform float uTime;
    uniform float uBaseOpacity;
    uniform float uDayBoost;
    varying vec2 vUv;
    void main() {
        vec2 d = vUv - 0.5;
        float r = length(d) * 2.0;
        float halo = pow(smoothstep(1.0, 0.0, r), 1.25);
        float breathe = 0.9 + 0.1 * sin(uTime * 0.72);
        float alpha = halo * breathe * uBaseOpacity * uDayBoost;
        vec3 color = uColor * uDayBoost;
        gl_FragColor = vec4(color * alpha, alpha);
    }
`;

/* ---------------- 光斑粒子贴图（canvas 生成径向辉点） ---------------- */

/** 生成一张 64×64 的径向渐变圆点贴图，所有光斑粒子共享。 */
function createParticleTexture(): THREE.Texture {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.35, 'rgba(255,255,255,0.75)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

/* ---------------- 公共接口 ---------------- */

export interface BeaconOptions {
    /** 锚点世界坐标（光柱与光斑的中心） */
    position: { x: number; z: number };
    /** 光柱总高（世界单位），默认 24 */
    height?: number;
    /** 光柱根部 y（世界单位），默认贴近地表 1.1 */
    baseY?: number;
    /** 主题：决定默认颜色与白天的增亮系数 */
    theme: ThemeName;
    /** 是否响应 prefers-reduced-motion：true 时粒子不再上飘，仅保留静态光柱与光晕 */
    reducedMotion?: boolean;
    /** 可选自定义颜色（hex 或 THREE.Color），覆盖主题默认色；不传用主题 gold */
    color?: THREE.ColorRepresentation;
}

export class Beacon {
    /** 整个信标挂在这个 group 下，调用方加入 scene 即可 */
    readonly group: THREE.Group;

    private readonly height: number;
    private readonly baseY: number;
    private theme: ThemeName;
    private readonly reducedMotion: boolean;

    /* 光柱与其材质 */
    private readonly shaft: THREE.Mesh;
    private readonly shaftMat: THREE.ShaderMaterial;
    /* 地面光晕与其材质 */
    private readonly halo: THREE.Mesh;
    private readonly haloMat: THREE.ShaderMaterial;
    /* 上飘光斑：各自独立 SpriteMaterial 便于逐个控制透明度 */
    private readonly particles: THREE.Sprite[];
    private readonly particleMats: THREE.SpriteMaterial[];
    private readonly particlePhases: number[];
    private readonly particleAngles: number[];
    private readonly particleRadii: number[];

    /** 是否被用户自定义颜色覆盖（applyTheme 不覆盖它） */
    private customColor: THREE.Color | null;

    private elapsed = 0;
    /** 信标当前锚点（世界坐标），移动锚点时更新 */
    private posX: number;
    private posZ: number;

    constructor(options: BeaconOptions) {
        const {
            position,
            theme,
            reducedMotion = false,
            height = DEFAULT_HEIGHT,
            baseY = DEFAULT_BASE_Y,
            color,
        } = options;

        this.height = Math.max(2, height);
        this.baseY = baseY;
        this.theme = theme;
        this.reducedMotion = reducedMotion;
        this.posX = position.x;
        this.posZ = position.z;

        /* —— 默认色：取主题色板的 gold（琥珀），白天自动增亮 —— */
        this.customColor = color != null ? new THREE.Color(color) : null;

        const defaultColor = this.customColor ?? new THREE.Color(THEMES[theme].voxel.gold);
        const dayBoost = this.resolveDayBoost(theme);

        this.group = new THREE.Group();
        this.group.name = 'beacon';

        /* —— 光柱：交叉薄片，双面 Additive —— */
        const crossGeom = buildCrossPlaneGeometry();
        this.shaftMat = new THREE.ShaderMaterial({
            uniforms: {
                uTime: { value: 0 },
                uColor: { value: defaultColor.clone() },
                uBaseOpacity: { value: 0.62 },
                uDayBoost: { value: dayBoost },
            },
            vertexShader: SHAFT_VERTEX,
            fragmentShader: SHAFT_FRAGMENT,
            transparent: true,
            depthWrite: false,
            depthTest: true,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
        });
        this.shaft = new THREE.Mesh(crossGeom, this.shaftMat);
        this.shaft.frustumCulled = false;
        this.shaft.renderOrder = 5;
        this.group.add(this.shaft);

        /* —— 地面光晕：贴地平放，不遮挡建筑剪影（depthTest=false） —— */
        this.haloMat = new THREE.ShaderMaterial({
            uniforms: {
                uTime: { value: 0 },
                uColor: { value: defaultColor.clone() },
                uBaseOpacity: { value: 0.42 },
                uDayBoost: { value: dayBoost },
            },
            vertexShader: SHAFT_VERTEX,
            fragmentShader: HALO_FRAGMENT,
            transparent: true,
            depthWrite: false,
            depthTest: false,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
        });
        const haloGeom = new THREE.PlaneGeometry(1, 1);
        haloGeom.rotateX(-Math.PI / 2);
        this.halo = new THREE.Mesh(haloGeom, this.haloMat);
        this.halo.frustumCulled = false;
        this.halo.renderOrder = 4;
        this.group.add(this.halo);

        /* —— 光斑粒子：围绕中心小半径散开，共享同一张辉点贴图 —— */
        const texture = createParticleTexture();
        this.particles = [];
        this.particleMats = [];
        this.particlePhases = [];
        this.particleAngles = [];
        this.particleRadii = [];
        const angleBase = Math.random() * Math.PI * 2;
        for (let i = 0; i < PARTICLE_COUNT; i++) {
            const mat = new THREE.SpriteMaterial({
                map: texture,
                color: defaultColor.clone(),
                transparent: true,
                opacity: 0,
                depthWrite: false,
                depthTest: true,
                blending: THREE.AdditiveBlending,
            });
            const sprite = new THREE.Sprite(mat);
            sprite.scale.set(PARTICLE_SIZE, PARTICLE_SIZE, PARTICLE_SIZE);
            sprite.renderOrder = 6;
            // 每个粒子有独立的相位 / 环绕角度 / 半径：视觉上「源源不绝」而非整齐队列
            this.particlePhases.push(Math.random());
            this.particleAngles.push(angleBase + (i / PARTICLE_COUNT) * Math.PI * 2 + (Math.random() - 0.5) * 0.9);
            this.particleRadii.push(PARTICLE_RADIUS_MIN + Math.random() * (PARTICLE_RADIUS_MAX - PARTICLE_RADIUS_MIN));
            this.group.add(sprite);
            this.particles.push(sprite);
            this.particleMats.push(mat);
        }

        /* 首次摆放：把形状一帧内摆到锚点（避免闪现在坐标原点） */
        this.applyPosition();
    }

    /* ---------------- 对外操作 ---------------- */

    /** 设置锚点（世界坐标）。只更新位置，不重建几何。 */
    setPosition(x: number, z: number): void {
        this.posX = x;
        this.posZ = z;
        this.applyPosition();
    }

    /** 覆盖颜色（不传则回到主题默认色）。 */
    setColor(color: THREE.ColorRepresentation | null | undefined): void {
        this.customColor = color != null ? new THREE.Color(color) : null;
        const next = this.customColor ?? new THREE.Color(THEMES[this.theme].voxel.gold);
        this.shaftMat.uniforms.uColor.value.copy(next);
        this.haloMat.uniforms.uColor.value.copy(next);
        for (const mat of this.particleMats) mat.color.copy(next);
    }

    setVisible(visible: boolean): void {
        this.group.visible = visible;
    }

    /** 主题切换：只重算颜色与白天的增亮系数，不重建结构。 */
    applyTheme(themeOrConfig: ThemeName | ThemeConfig): void {
        const config = resolveThemeConfig(themeOrConfig);
        const themeName: ThemeName = typeof themeOrConfig === 'string' ? themeOrConfig : config.name;
        this.theme = themeName;
        const dayBoost = this.resolveDayBoost(themeName);
        this.shaftMat.uniforms.uDayBoost.value = dayBoost;
        this.haloMat.uniforms.uDayBoost.value = dayBoost;
        // 未自定义颜色时跟随主题默认色；自定义色保持不变
        if (!this.customColor) {
            const next = new THREE.Color(config.voxel.gold);
            this.shaftMat.uniforms.uColor.value.copy(next);
            this.haloMat.uniforms.uColor.value.copy(next);
            for (const mat of this.particleMats) mat.color.copy(next);
        }
    }

    /** 每帧更新：驱动光斑上飘与光效呼吸。 */
    update(dt: number): void {
        if (!this.group.visible) return;
        this.elapsed += dt;

        // reducedMotion：保留静态光柱与光晕，但不让粒子飘动
        if (this.reducedMotion) {
            this.shaftMat.uniforms.uTime.value = this.elapsed;
            this.haloMat.uniforms.uTime.value = this.elapsed;
            return;
        }

        this.shaftMat.uniforms.uTime.value = this.elapsed;
        this.haloMat.uniforms.uTime.value = this.elapsed;

        for (let i = 0; i < this.particles.length; i++) {
            // 生命周期 0..1：从锚点出发，沿光柱上升到顶部，头尾渐隐
            const t = (this.elapsed / PARTICLE_CYCLE_SEC + this.particlePhases[i]) % 1;
            const y = this.baseY + t * this.height;
            const radius = this.particleRadii[i];
            const angle = this.particleAngles[i];
            const px = this.posX + Math.cos(angle) * radius;
            const pz = this.posZ + Math.sin(angle) * radius;
            this.particles[i].position.set(px, y, pz);
            // sin(t·π)：起点与终点为 0，中部最亮
            this.particleMats[i].opacity = Math.sin(t * Math.PI) * 0.95;
        }
    }

    /** 释放几何 / 材质 / 纹理，并从父场景移除 group。 */
    dispose(): void {
        this.shaft.geometry.dispose();
        this.shaftMat.dispose();
        this.halo.geometry.dispose();
        this.haloMat.dispose();
        for (const mat of this.particleMats) {
            mat.map?.dispose();
            mat.dispose();
        }
        this.particles.length = 0;
        this.particleMats.length = 0;
        this.group.clear();
    }

    /* ---------------- 内部 ---------------- */

    private resolveDayBoost(theme: ThemeName): number {
        // 与 heatBeams 同口径：白天 Additive 会被浅色背景吃掉，需要整体提亮；夜间不额外加。
        return theme === 'day' ? 1.45 : 1.0;
    }

    /** 把光柱 / 光晕 / 锚点基线摆到当前 (posX, posZ)。 */
    private applyPosition(): void {
        const y = this.baseY;
        this.shaft.position.set(this.posX, y + this.height / 2, this.posZ);
        this.shaft.scale.set(SHAFT_WIDTH, this.height, SHAFT_WIDTH);
        this.halo.position.set(this.posX, y + 0.02, this.posZ);
        const haloSize = Math.max(3.2, SHAFT_WIDTH * 3.4);
        this.halo.scale.set(haloSize, haloSize, haloSize);
        for (let i = 0; i < this.particles.length; i++) {
            const radius = this.particleRadii[i];
            const angle = this.particleAngles[i];
            this.particles[i].position.set(
                this.posX + Math.cos(angle) * radius,
                this.baseY,
                this.posZ + Math.sin(angle) * radius,
            );
        }
    }
}

/** 交叉薄片几何（两片互相垂直），避免侧视角「看不见光柱」。 */
function buildCrossPlaneGeometry(): THREE.BufferGeometry {
    const plane = new THREE.PlaneGeometry(1, 1);
    const crossed = plane.clone();
    crossed.rotateY(Math.PI / 2);
    const merged = mergeGeometries([plane, crossed]);
    plane.dispose();
    crossed.dispose();
    return merged;
}