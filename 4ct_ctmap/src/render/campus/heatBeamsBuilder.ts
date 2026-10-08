import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { LocationHeat, HeatLevel } from '../../contract';
import type { ThemeName } from '../../types/theme';
import type { GridSystem } from '../../utils/geo';
import { resolveThemeConfig, THEMES, HEAT_PALETTE_KEYS, type GlobalColorKey, type ThemeConfig } from '../theme/palette';
import { HEAT_FIELD } from './heatField';

export interface HeatBeamsHandle {
    group: THREE.Group;
    update: (dt: number) => void;
    applyTheme: (themeOrConfig: ThemeName | ThemeConfig) => void;
    replaceHeats: (heats: LocationHeat[], grid: GridSystem) => void;
    setVisible: (visible: boolean) => void;
    setLevelFilter: (minLevel: HeatLevel) => void;
    dispose: () => void;
}

/* 每个热点独立的光柱：
   · 交叉薄片（XZ 两向）避免视角切到薄片侧面时消失；
   · Additive Blending + Shader 渐隐，没有柱体外轮廓；
   · 底部宽、向上柔和衰减，高度直接跟随 heatValue / heightRatio。 */
const SHAFT_VERTEX = /* glsl */ `
    attribute float aPhase;
    attribute float aSpeed;
    uniform float uTime;
    varying vec2 vUv;
    void main() {
        vUv = uv;
        vec3 local = position;
        // 轻摇曳，像空气里的光，不改变高度语义。
        local.x += sin(uTime * aSpeed + aPhase) * 0.04;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(local, 1.0);
    }
`;

const SHAFT_FRAGMENT = /* glsl */ `
    uniform vec3 uColor;
    uniform float uTime;
    uniform float uBaseOpacity;
    uniform float uDayBoost;   // 白天：1.0=不增亮；>1.0 把光柱在白天背景上拉出来
    varying vec2 vUv;
    void main() {
        // 垂直：底部最实，向上柔和消散；降低幂次让柱体更高更散。
        float vertical = pow(1.0 - vUv.y, 1.28);
        // 水平 1：把 vUv.x 的硬边用更大的 soft 区间散开（0.08 ~ 0.92），让光更散。
        float edgeFade = smoothstep(0.0, 0.08, vUv.x) * smoothstep(1.0, 0.92, vUv.x);
        // 水平 2：径向 —— 到中心线的距离 → 内圈高外圈低。
        float radial = 1.0 - smoothstep(0.0, 0.64, abs(vUv.x - 0.5) * 2.0);
        radial = pow(radial, 1.6);
        float horizontal = edgeFade * mix(0.52, 1.0, radial);
        // 整体呼吸，不改变相对高度；让光柱像空气对流。
        float breathe = 0.82 + 0.18 * sin(uTime * 0.7 + vUv.y * 2.4);
        float alpha = vertical * horizontal * breathe * uBaseOpacity * uDayBoost;
        // 颜色额外乘 radial + vertical：中心更纯饱和色，外圈偏淡，表现丁达尔散色。
        vec3 color = uColor * mix(0.72, 1.12, radial) * mix(0.9, 1.08, vertical) * uDayBoost;
        gl_FragColor = vec4(color * alpha, alpha);
    }
`;

const GROUND_HALO_FRAGMENT = /* glsl */ `
    uniform vec3 uColor;
    uniform float uTime;
    uniform float uBaseOpacity;
    uniform float uDayBoost;
    varying vec2 vUv;
    void main() {
        // 径向光晕：紧贴地面、中心亮向外更远处消散，扩大范围让它"更大一圈"。
        vec2 d = vUv - 0.5;
        float r = length(d) * 2.0;
        float halo = smoothstep(1.0, 0.0, r);
        // 降幂让外圈更散、边缘不硬收。
        halo = pow(halo, 1.12);
        float breathe = 0.88 + 0.12 * sin(uTime * 0.68);
        float alpha = halo * breathe * uBaseOpacity * uDayBoost;
        vec3 color = uColor * uDayBoost;
        gl_FragColor = vec4(color * alpha, alpha);
    }
`;

function levelRank(level: HeatLevel): number {
    return level === 'critical' ? 4 : level === 'high' ? 3 : level === 'medium' ? 2 : 1;
}

/** 交叉薄片几何，避免侧视角"看不见光柱"。 */
function buildCrossPlaneGeometry(): THREE.BufferGeometry {
    const plane = new THREE.PlaneGeometry(1, 1);
    const crossed = plane.clone();
    crossed.rotateY(Math.PI / 2);
    const merged = mergeGeometries([plane, crossed]);
    plane.dispose();
    crossed.dispose();
    return merged;
}

/** 地面光晕平面（贴地）。 */
function buildGroundPlaneGeometry(): THREE.PlaneGeometry {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    return geo;
}

function resolveHeatColor(theme: ThemeName, heat: LocationHeat): THREE.Color {
    const paletteKey = heat.customColor
        ? null
        : HEAT_PALETTE_KEYS[heat.heatLevel];
    if (heat.customColor) return new THREE.Color(heat.customColor);
    const raw = THEMES[theme].voxel[(paletteKey ?? 'heatLow') as GlobalColorKey];
    return new THREE.Color(raw ?? 0x59d1a3);
}

function resolveHeightRatio(heat: LocationHeat): number {
    // 热度值永远是高度的第一驱动力；heightRatio 仅作为自定义补充，不覆盖热力度。
    const heatFactor = Math.max(0.18, Math.min(1, heat.heatValue / 100));
    if (heat.heightRatio == null) return heatFactor;
    // 两者取较大者，但不越界：热度不会被 heightRatio 压低。
    return Math.max(heatFactor, Math.max(0.15, Math.min(1, heat.heightRatio)));
}

export function buildHeatBeams(
    heats: LocationHeat[],
    grid: GridSystem,
    theme: ThemeName,
    reducedMotion = false,
): HeatBeamsHandle {
    const group = new THREE.Group();
    group.name = 'heatShafts';

    let currentTheme = theme;
    let currentGrid = grid;
    let minLevel: HeatLevel = 'low';
    let currentHeats: LocationHeat[] = heats;
    let elapsed = 0;

    const crossGeom = buildCrossPlaneGeometry();
    const groundGeom = buildGroundPlaneGeometry();
    const entries = new Map<string, {
        shaft: THREE.InstancedMesh;
        halo: THREE.Mesh;
        shaftMat: THREE.ShaderMaterial;
        haloMat: THREE.ShaderMaterial;
        phase: Float32Array;
        speed: Float32Array;
    }>();

    function resolveDayBoost(theme: ThemeName): number {
        // 白天 Additive 会被浅蓝/白色背景"吃掉"，需要整体 boost 不透明度 + 颜色亮度
        // 让光柱在日景也清晰可见；夜间不额外加亮，保持夜空对比度。
        // 之前 1.75 导致光柱太亮，建筑被染红，现在 1.45 在明亮与"不盖建筑"间取平衡。
        return theme === 'day' ? 1.45 : 1.0;
    }

    function createShaftMaterial(color: THREE.Color, level: HeatLevel, theme: ThemeName): THREE.ShaderMaterial {
        // 保持 Additive，但打开 depthTest：光柱在建筑 far side 会被建筑遮挡，
        // 建筑剪影依然清晰可见；用户会感觉到"建筑挡住了光"。
        // depthWrite=false 保证光柱不写深度，不会互相遮挡或阻挡其他半透明对象。
        const baseOpacity =
            level === 'critical' ? 0.72 :
            level === 'high' ? 0.62 :
            level === 'medium' ? 0.52 : 0.42;
        return new THREE.ShaderMaterial({
            uniforms: {
                uTime: { value: 0 },
                uColor: { value: color.clone() },
                uBaseOpacity: { value: baseOpacity },
                uDayBoost: { value: resolveDayBoost(theme) },
            },
            vertexShader: SHAFT_VERTEX,
            fragmentShader: SHAFT_FRAGMENT,
            transparent: true,
            depthWrite: false,
            depthTest: true,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
        });
    }

    function createHaloMaterial(color: THREE.Color, level: HeatLevel, theme: ThemeName): THREE.ShaderMaterial {
        // halo 贴地，如果 depthTest=true 会被地面/建筑地面截掉；保留 depthTest=false，
        // 但稍微降一点不透明度，避免与光柱合起来盖过建筑剪影。
        const baseOpacity =
            level === 'critical' ? 0.52 :
            level === 'high' ? 0.44 :
            level === 'medium' ? 0.36 : 0.30;
        return new THREE.ShaderMaterial({
            uniforms: {
                uTime: { value: 0 },
                uColor: { value: color.clone() },
                uBaseOpacity: { value: baseOpacity },
                uDayBoost: { value: resolveDayBoost(theme) },
            },
            vertexShader: /* glsl */ `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: GROUND_HALO_FRAGMENT,
            transparent: true,
            depthWrite: false,
            depthTest: false,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
        });
    }

    /* ------------------- 构建/复用 ------------------- */
    function upsertEntry(heat: LocationHeat): void {
        if (levelRank(heat.heatLevel) < levelRank(minLevel)) {
            // 低于当前筛选级：已有的移除，不再新建。
            const old = entries.get(heat.id);
            if (old) {
                group.remove(old.shaft, old.halo);
                old.shaft.geometry.dispose();
                old.shaftMat.dispose();
                old.halo.geometry.dispose();
                old.haloMat.dispose();
                entries.delete(heat.id);
            }
            return;
        }

        const color = resolveHeatColor(currentTheme, heat);
        const heightRatio = resolveHeightRatio(heat);
        // 放大柱高：用户反馈"光柱再高一点"；原基础高度×1.9，整体观感接近丁达尔光束。
        const HEIGHT_GAIN = 1.9;
        // 放大宽度/光半径：用户反馈"光再散一点、半径再大一点"；宽×1.75，halo×2.1。
        const WIDTH_GAIN = 1.75;
        const HALO_GAIN = 2.1;
        const rawHeight = Math.max(2.4, HEAT_FIELD.maxHeightMeters / currentGrid.voxelMeters * heightRatio);
        const height = rawHeight * HEIGHT_GAIN;
        const baseWidth = Math.max(1.6, 4.6 * (0.32 + heightRatio)) * WIDTH_GAIN;
        const { vx, vz } = currentGrid.lonLatToVoxel(heat.position[0], heat.position[1]);
        const world = currentGrid.voxelToWorld(vx, vz);
        const dayBoost = resolveDayBoost(currentTheme);

        const existing = entries.get(heat.id);
        if (existing) {
            // 复用：只改颜色、高度、宽度、位置，不重建几何。
            const lvl = heat.heatLevel;
            existing.shaftMat.uniforms.uColor.value.copy(color);
            existing.haloMat.uniforms.uColor.value.copy(color);
            // 基础透明度随等级变化。
            existing.shaftMat.uniforms.uBaseOpacity.value =
                lvl === 'critical' ? 0.72 :
                lvl === 'high' ? 0.62 :
                lvl === 'medium' ? 0.52 : 0.42;
            existing.haloMat.uniforms.uBaseOpacity.value =
                lvl === 'critical' ? 0.52 :
                lvl === 'high' ? 0.44 :
                lvl === 'medium' ? 0.36 : 0.30;
            // 主题切换时白天 boost 也要同步，否则白天看不见。
            existing.shaftMat.uniforms.uDayBoost.value = dayBoost;
            existing.haloMat.uniforms.uDayBoost.value = dayBoost;

            const dummy = new THREE.Object3D();
            dummy.position.set(world.x, HEAT_FIELD.groundY + height / 2, world.z);
            dummy.scale.set(baseWidth, height, baseWidth);
            dummy.updateMatrix();
            existing.shaft.setMatrixAt(0, dummy.matrix);
            existing.shaft.instanceMatrix.needsUpdate = true;

            existing.halo.position.set(world.x, HEAT_FIELD.groundY + 0.02, world.z);
            const haloSize = Math.max(3.2, baseWidth * HALO_GAIN);
            existing.halo.scale.set(haloSize, haloSize, haloSize);
            return;
        }

        // 新建：单实例 InstancedMesh，保留未来做合并时的扩展空间。
        const shaftMat = createShaftMaterial(color, heat.heatLevel, currentTheme);
        const shaft = new THREE.InstancedMesh(crossGeom, shaftMat, 1);
        shaft.frustumCulled = false;
        shaft.renderOrder = 5;
        shaft.name = `heatShaft-${heat.id}`;

        const dummy = new THREE.Object3D();
        dummy.position.set(world.x, HEAT_FIELD.groundY + height / 2, world.z);
        dummy.scale.set(baseWidth, height, baseWidth);
        dummy.updateMatrix();
        shaft.setMatrixAt(0, dummy.matrix);
        shaft.instanceMatrix.needsUpdate = true;

        const phase = new Float32Array(1);
        const speed = new Float32Array(1);
        phase[0] = Math.random() * Math.PI * 2;
        speed[0] = 0.18 + Math.random() * 0.42;
        crossGeom.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
        crossGeom.setAttribute('aSpeed', new THREE.InstancedBufferAttribute(speed, 1));

        const haloMat = createHaloMaterial(color, heat.heatLevel, currentTheme);
        const halo = new THREE.Mesh(groundGeom, haloMat);
        halo.frustumCulled = false;
        halo.renderOrder = 4;
        halo.name = `heatHalo-${heat.id}`;
        const haloSize = Math.max(3.2, baseWidth * HALO_GAIN);
        halo.position.set(world.x, HEAT_FIELD.groundY + 0.02, world.z);
        halo.scale.set(haloSize, haloSize, haloSize);

        group.add(shaft, halo);
        entries.set(heat.id, { shaft, halo, shaftMat, haloMat, phase, speed });
    }

    function rebuild(): void {
        const keep = new Set<string>();
        for (const heat of currentHeats) {
            keep.add(heat.id);
            upsertEntry(heat);
        }
        // 删除不再存在的光柱。
        for (const [id, old] of Array.from(entries.entries())) {
            if (keep.has(id)) continue;
            group.remove(old.shaft, old.halo);
            old.shaft.geometry.dispose();
            old.shaftMat.dispose();
            old.halo.geometry.dispose();
            old.haloMat.dispose();
            entries.delete(id);
        }
    }

    function applyTheme(next: ThemeName | ThemeConfig): void {
        currentTheme = typeof next === 'string' ? next : resolveThemeConfig(next).name;
        // 主题切换不改变光柱结构，只重算颜色；因此在重建一次的同时顺手把现有条目也重刷一遍。
        for (const heat of currentHeats) upsertEntry(heat);
    }

    rebuild();

    return {
        group,
        update(dt) {
            if (reducedMotion || !group.visible) return;
            elapsed += dt;
            for (const entry of entries.values()) {
                entry.shaftMat.uniforms.uTime.value = elapsed;
                entry.haloMat.uniforms.uTime.value = elapsed;
            }
        },
        applyTheme,
        replaceHeats(next, nextGrid) {
            currentHeats = next;
            currentGrid = nextGrid;
            rebuild();
        },
        setVisible(visible) { group.visible = visible; },
        setLevelFilter(next) {
            if (next === minLevel) return;
            minLevel = next;
            rebuild();
        },
        dispose() {
            for (const entry of entries.values()) {
                entry.shaft.geometry.dispose();
                entry.shaftMat.dispose();
                entry.halo.geometry.dispose();
                entry.haloMat.dispose();
            }
            entries.clear();
            crossGeom.dispose();
            groundGeom.dispose();
            group.clear();
        },
    };
}
