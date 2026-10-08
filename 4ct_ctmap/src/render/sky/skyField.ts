/* ================================================================
   天空：穹顶 / 星空 / 云 / 日月
   —— 二期「主题即昼夜」的天空部分。颜色全部由主题色板给，
      尺寸全部由校园对角线推出来（换学校、改规模都不用改这里）。

   【三条约束】
   1) 所有天空件都在相机远平面之内、小岛之外，且一律不参与阴影；
   2) 材质一律 fog: false —— 否则雾会把天空一起吃掉，昼夜都糊成一片；
   3) 只用确定性伪随机（seededRandom），刷新后星空与云的形状完全一致。
================================================================ */

import * as THREE from 'three';
import type { ThemeName } from '../../types/theme';
import { resolveThemeConfig, type ThemeConfig } from '../theme/palette';
import { seededRandom } from '../voxel/random';

/**
 * 日月方位（单位向量）。
 * 主光也按这个方向摆 —— 否则会出现「月在东、光从西来」的割裂感。
 *
 * 取仰角 45°、世界方位「右上前方」（与一期主光的水平方位一致，只是压低了仰角让阴影更长）。
 * 【口径】日月在这个方位上：默认机位是俯视，日月落在画面外，转视角仰拍即可看到；
 * 这是刻意的取舍 —— 把日月压到默认画面里就只能是「岛后偏下」的低位，
 * 主光跟着压低会让岛面几乎照不到，白天就不再像白天。
 */
export const ORB_DIRECTION = new THREE.Vector3(0.602, 0.707, 0.372).normalize();

/** 穹顶半径 = 对角线 × 该系数（相机最远约 3.3 倍对角线，仍在穹顶之内） */
const DOME_RADIUS_FACTOR = 4;
/** 日月到球心的距离 = 穹顶半径 × 该系数 */
const ORB_DISTANCE_FACTOR = 0.78;
/** 日月本体半径 = 对角线 × 该系数（比真实月亮放大若干倍，远看才有存在感） */
const ORB_RADIUS_FACTOR = 0.05;
/** 光晕半径相对本体的倍率 */
const ORB_GLOW_SCALE = 2.6;
const ORB_GLOW_OPACITY = 0.22;

/** 星的颗数 */
const STAR_COUNT = 1400;
/** 星壳半径 = 穹顶半径 × 该系数（略靠内，免得贴着穹顶比深度） */
const STAR_SHELL_FACTOR = 0.94;
const STAR_SIZE_PX = 2;
/** 亮星占比：其余为暗星，用两级大小与颜色拉开层次 */
const STAR_BRIGHT_RATIO = 0.18;

/** 云的团数 */
const CLOUD_COUNT = 10;
const CLOUD_BLOCKS = [5, 9] as const;
/** 云的方块边长 = 对角线 × 该系数 */
const CLOUD_BLOCK_FACTOR = 0.016;
/** 云的高度带（对角线倍数区间） */
const CLOUD_ALTITUDE = [0.1, 0.3] as const;
/** 云的水平散布半径（对角线倍数） */
const CLOUD_SPREAD_FACTOR = 1.15;
/** 云的水平漂移速度（对角线倍数 / 秒） */
const CLOUD_DRIFT_FACTOR = 0.0035;

const DOME_VERTEX_SHADER = /* glsl */ `
varying vec3 vDir;
void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const DOME_FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uBottom;
varying vec3 vDir;
void main() {
    float h = clamp(vDir.y, -1.0, 1.0);
    /* 幂次小于 1，让地平线附近的过渡带更宽、天顶色收得更靠上 */
    vec3 col = h >= 0.0
        ? mix(uHorizon, uTop, pow(h, 0.55))
        : mix(uHorizon, uBottom, pow(-h, 0.55));
    gl_FragColor = vec4(col, 1.0);
}
`;

export interface SkyFieldOptions {
    /** 小岛中心的水平坐标（穹顶与日月都以此为球心） */
    center: { x: number; z: number };
    /** 校园对角线（米）—— 天空所有尺寸的基准 */
    diagonal: number;
    reducedMotion: boolean;
    theme: ThemeName;
}

export interface SkyField {
    group: THREE.Group;
    /** 支持主题名或插值配置（过渡动画期间传入 lerpThemeConfig 的结果） */
    applyTheme: (themeOrConfig: ThemeName | ThemeConfig) => void;
    /**
     * 过渡动画期间更新日月位置与颜色。
     * direction = 日月方位单位向量；body/glow = 球体颜色。
     */
    updateCelestial: (direction: THREE.Vector3, body: number, glow: number) => void;
    /** 云的水平漂移（reducedMotion 下不动） */
    update: (dt: number) => void;
    dispose: () => void;
}

interface CloudHandle {
    group: THREE.Group;
    /** 米 / 秒 */
    speed: number;
    /** 越过 ±wrapX 就回卷，避免销毁重建 */
    wrapX: number;
}

export function createSkyField(options: SkyFieldOptions): SkyField {
    const { center, diagonal, reducedMotion, theme } = options;

    const group = new THREE.Group();
    group.name = 'sky';
    group.position.set(center.x, 0, center.z);

    const domeRadius = diagonal * DOME_RADIUS_FACTOR;

    /* ---------- 穹顶：内翻球 + 三段竖向渐变 ---------- */
    const domeUniforms = {
        uTop: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uBottom: { value: new THREE.Color() }
    };
    const domeGeometry = new THREE.SphereGeometry(domeRadius, 32, 24);
    const domeMaterial = new THREE.ShaderMaterial({
        uniforms: domeUniforms,
        vertexShader: DOME_VERTEX_SHADER,
        fragmentShader: DOME_FRAGMENT_SHADER,
        side: THREE.BackSide,
        /* 穹顶不写深度：它是最远的背景，绝不能挡住任何东西 */
        depthWrite: false,
        fog: false
    });
    const dome = new THREE.Mesh(domeGeometry, domeMaterial);
    dome.name = 'skyDome';
    dome.renderOrder = -10;
    group.add(dome);

    /* ---------- 星空：Points，白天整体隐藏 ---------- */
    const starLayout = seededRandom(0x5eed);
    const starPositions = new Float32Array(STAR_COUNT * 3);
    const starColors = new Float32Array(STAR_COUNT * 3);
    const starShell = domeRadius * STAR_SHELL_FACTOR;
    const dimStar = new THREE.Color(0x9fb0d8);
    const brightStar = new THREE.Color(0xffffff);
    for (let i = 0; i < STAR_COUNT; i += 1) {
        /* 只铺上半球：赤道以下在小岛底下，看不到 */
        const y = starLayout();
        const phi = starLayout() * Math.PI * 2;
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        starPositions[i * 3] = Math.cos(phi) * r * starShell;
        starPositions[i * 3 + 1] = y * starShell;
        starPositions[i * 3 + 2] = Math.sin(phi) * r * starShell;

        const isBright = starLayout() < STAR_BRIGHT_RATIO;
        const tint = isBright ? brightStar : dimStar;
        const fade = isBright ? 1 : 0.45 + starLayout() * 0.4;
        starColors[i * 3] = tint.r * fade;
        starColors[i * 3 + 1] = tint.g * fade;
        starColors[i * 3 + 2] = tint.b * fade;
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    starGeometry.setAttribute('color', new THREE.BufferAttribute(starColors, 3));
    const starMaterial = new THREE.PointsMaterial({
        size: STAR_SIZE_PX,
        sizeAttenuation: false,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        fog: false
    });
    const stars = new THREE.Points(starGeometry, starMaterial);
    stars.name = 'skyStars';
    group.add(stars);

    /* ---------- 云：体素方块团，缓慢水平漂移 ---------- */
    const cloudLayout = seededRandom(0xc10d);
    const blockEdge = diagonal * CLOUD_BLOCK_FACTOR;
    const cloudGeometry = new THREE.BoxGeometry(blockEdge, blockEdge, blockEdge);
    const cloudMaterial = new THREE.MeshBasicMaterial({ transparent: true, fog: false });
    const cloudSpread = diagonal * CLOUD_SPREAD_FACTOR;
    const cloudDrift = diagonal * CLOUD_DRIFT_FACTOR;
    const clouds: CloudHandle[] = [];

    for (let i = 0; i < CLOUD_COUNT; i += 1) {
        const cloud = new THREE.Group();
        const blockCount = CLOUD_BLOCKS[0] + Math.floor(cloudLayout() * (CLOUD_BLOCKS[1] - CLOUD_BLOCKS[0] + 1));
        const mesh = new THREE.InstancedMesh(cloudGeometry, cloudMaterial, blockCount);
        mesh.name = `cloud-${i}`;
        /* 云不参与阴影，也不参与拾取 */
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        const matrix = new THREE.Matrix4();
        for (let b = 0; b < blockCount; b += 1) {
            /* 方块在团内横向铺开、竖向压扁，读起来才像云而不是一堆石头 */
            const ox = (cloudLayout() - 0.5) * blockEdge * 5;
            const oz = (cloudLayout() - 0.5) * blockEdge * 3;
            const oy = (cloudLayout() - 0.5) * blockEdge * 0.8;
            matrix.makeTranslation(ox, oy, oz);
            mesh.setMatrixAt(b, matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
        cloud.add(mesh);

        const altitude = CLOUD_ALTITUDE[0] + cloudLayout() * (CLOUD_ALTITUDE[1] - CLOUD_ALTITUDE[0]);
        const angle = cloudLayout() * Math.PI * 2;
        const radius = cloudSpread * (0.45 + cloudLayout() * 0.5);
        cloud.position.set(Math.cos(angle) * radius, diagonal * altitude, Math.sin(angle) * radius);
        cloud.rotation.y = cloudLayout() * Math.PI * 2;
        group.add(cloud);

        clouds.push({
            group: cloud,
            speed: cloudDrift * (0.7 + cloudLayout() * 0.6),
            wrapX: cloudSpread
        });
    }

    /* ---------- 日月：本体 + 外层光晕 ---------- */
    const orbRadius = diagonal * ORB_RADIUS_FACTOR;
    const orbBodyMaterial = new THREE.MeshBasicMaterial({ fog: false });
    const orbBody = new THREE.Mesh(new THREE.SphereGeometry(orbRadius, 24, 16), orbBodyMaterial);
    orbBody.name = 'skyOrbBody';

    const orbGlowMaterial = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: ORB_GLOW_OPACITY,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false
    });
    const orbGlow = new THREE.Mesh(
        new THREE.SphereGeometry(orbRadius * ORB_GLOW_SCALE, 24, 16),
        orbGlowMaterial
    );
    orbGlow.name = 'skyOrbGlow';

    const orb = new THREE.Group();
    orb.name = 'skyOrb';
    orb.add(orbBody, orbGlow);
    orb.position.copy(ORB_DIRECTION).multiplyScalar(domeRadius * ORB_DISTANCE_FACTOR);
    group.add(orb);

    /* ---------- 主题 ---------- */
    function applyTheme(next: ThemeName | ThemeConfig): void {
        const sky = resolveThemeConfig(next).sky;

        domeUniforms.uTop.value.setHex(sky.dome.top);
        domeUniforms.uHorizon.value.setHex(sky.dome.horizon);
        domeUniforms.uBottom.value.setHex(sky.dome.bottom);

        starMaterial.opacity = sky.starOpacity;
        stars.visible = sky.starOpacity > 0;

        cloudMaterial.color.setHex(sky.cloud.color);
        cloudMaterial.opacity = sky.cloud.opacity;

        orbBodyMaterial.color.setHex(sky.orb.body);
        orbGlowMaterial.color.setHex(sky.orb.glow);
        orb.scale.setScalar(sky.orb.scale);

        /* 日月复位到标准方位。过渡动画结束时日月落在地平线以下，
         * 若不复位，切回静态主题后日月会一直停在地下（看不到月亮）。
         * 过渡期间紧随其后的 updateCelestial 会覆盖这个位置，不受影响。 */
        orb.position.copy(ORB_DIRECTION).multiplyScalar(domeRadius * ORB_DISTANCE_FACTOR);
    }

    /** 过渡动画期间更新日月方位与颜色（不重建几何，只改位置与材质） */
    function updateCelestial(direction: THREE.Vector3, body: number, glow: number): void {
        orb.position.copy(direction).multiplyScalar(domeRadius * ORB_DISTANCE_FACTOR);
        orbBodyMaterial.color.setHex(body);
        orbGlowMaterial.color.setHex(glow);
    }

    const driftEnabled = !reducedMotion;

    function update(dt: number): void {
        if (!driftEnabled) return;
        for (const cloud of clouds) {
            cloud.group.position.x += cloud.speed * dt;
            if (cloud.group.position.x > cloud.wrapX) cloud.group.position.x -= cloud.wrapX * 2;
        }
    }

    function dispose(): void {
        domeGeometry.dispose();
        domeMaterial.dispose();
        starGeometry.dispose();
        starMaterial.dispose();
        cloudGeometry.dispose();
        cloudMaterial.dispose();
        for (const cloud of clouds) {
            for (const child of cloud.group.children) {
                if (child instanceof THREE.InstancedMesh) child.dispose();
            }
        }
        orbBody.geometry.dispose();
        orbBodyMaterial.dispose();
        orbGlow.geometry.dispose();
        orbGlowMaterial.dispose();
        group.clear();
    }

    applyTheme(theme);

    return { group, applyTheme, updateCelestial, update, dispose };
}
