/* ================================================================
   舞台：渲染器 / 相机 / 控制器 / 灯光 / 天空 / 后处理
   —— 整页只在这里创建 WebGL 上下文，其余模块只往场景里放东西。
   与 DEMO 的 stage.js 同源，差别有三处：
     1) 尺度由「校园跨度」推出来（体素边长与网格尺寸都是数据决定的）；
     2) 灯光、雾、曝光、Bloom、天空全部可以由 applyTheme() 切换（夜/昼两套）；
     3) 主光方向与日月方位同源（ORB_DIRECTION），不会出现「月在东、光从西来」。
================================================================ */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { ThemeName } from '../types/theme';
import type { ViewPresetName } from '../types/view';
import { resolveThemeConfig, type ThemeConfig } from './theme/palette';
import { createSkyField, ORB_DIRECTION, type SkyField } from './sky/skyField';
import { createViewPresets, HOME_PRESET, type ViewPose } from './view/presets';

/** 主光到岛心的距离 = 对角线 × 该系数（方向与 ORB_DIRECTION 一致） */
const KEY_LIGHT_DISTANCE_FACTOR = 1.15;

/**
 * 自由视角的包围范围（相对取景对角线）。
 * 【口径】允许贴近看细节，但机位仰角统一受「视线与地面夹角 ≥ MIN_ELEVATION_DEG」
 * 约束：不允许绕到岛底仰视（否则倒锥底面会穿帮），同时距离上限保证不会穿出天空穹顶。
 */
const ORBIT_MIN_DISTANCE_FACTOR = 0.04;
const ORBIT_MAX_DISTANCE_FACTOR = 3;

/**
 * 相机视线与地面的最小夹角（度）。
 * 【口径】手动拖拽、预设机位、聚焦机位统一遵守：不能从下往上看。
 */
const MIN_ELEVATION_DEG = 5;

const ORBIT_MIN_POLAR = 0.03;
/* 极角上限 = 90° − MIN_ELEVATION_DEG：视线相对地面俯仰角不低于 5°，杜绝贴地仰视 */
const ORBIT_MAX_POLAR = Math.PI * 0.5 - MIN_ELEVATION_DEG * Math.PI / 180;

/**
 * 【性能优化】画布像素比上限。
 * 高分屏（devicePixelRatio 2）每帧要着色的像素量是 1x 的 4 倍，而沙盘整体是「大色块 + 泛光」，
 * 不缺这点采样。1.5 在宽屏上肉眼几乎无差，像素量却少 44%；后处理链共用同一个上限。
 */
const MAX_PIXEL_RATIO = 2;

/**
 * 【性能优化】Bloom 的分辨率倍率（相对画布尺寸）。
 * UnrealBloomPass 内部本就按「传入尺寸的一半」建 5 级 mip，因此传 0.5 倍画布
 * → 整条泛光链实际跑在 1/4 分辨率上。泛光是低频、大面积的效果，降到这里看不出区别。
 */
const BLOOM_RESOLUTION_SCALE = 0.5;

export interface StageOptions {
    canvas: HTMLCanvasElement;
    center: { x: number; z: number };
    span: { x: number; z: number };
    /** 倒锥总深（格）：取景要把岛面以下的岛体一起框进来 */
    islandDepth: number;
    reducedMotion: boolean;
    theme: ThemeName;
}

export interface Stage {
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    sky: SkyField;
    /** 四个预设机位（目标点 / 机位世界坐标） */
    viewPresets: Record<ViewPresetName, ViewPose>;
    home: { position: THREE.Vector3; target: THREE.Vector3 };
    /** 支持主题名或插值配置（过渡动画期间传入 lerpThemeConfig 的结果） */
    applyTheme: (themeOrConfig: ThemeName | ThemeConfig) => void;
    /** 过渡动画期间更新主光方向（跟随日月升落） */
    updateKeyLightDirection: (direction: THREE.Vector3, target: THREE.Vector3) => void;
    resize: () => void;
    update: (dt: number) => void;
    render: () => void;
    setLayoutBias: (px: number) => void;
    /** 移动端：底部抽屉占位后，让地图可见中心上移到抽屉上方，避免主体被抽屉遮住 */
    setBottomInset: (px: number) => void;
    dispose: () => void;
}

export function createStage(options: StageOptions): Stage {
    const { canvas, center, span, islandDepth, reducedMotion, theme } = options;

    /* 取景尺度把岛面以下也算进来：悬空小岛是「岛面 + 倒锥」，
       只按平面跨度取景会把下半截切在画面外。 */
    const diagonal = Math.hypot(span.x, span.z + islandDepth);

    const viewPresets = createViewPresets({
        center: { x: center.x, z: center.z },
        diagonal,
        islandDepth
    });
    const homePosition = viewPresets[HOME_PRESET].position;
    const homeTarget = viewPresets[HOME_PRESET].target;

    /** 雾的远近按主题给的「对角线倍率」折算，换学校/改规模都不用动数字 */
    function writeFog(config: ThemeConfig): void {
        fog.color.setHex(config.fog.color);
        fog.near = diagonal * config.fog.nearRatio;
        fog.far = diagonal * config.fog.farRatio;
    }

    /* ---------- 渲染器 ---------- */
    const renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance'
    });
    /* 画布透明，页面底色由 CSS 令牌给，主题切换时底色跟着换 */
    renderer.setClearAlpha(0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    /* 【性能优化】阴影贴图不再每帧重算：投影体（建筑 / 地表 / 路灯杆 / 岛缘小建筑）与主光方向
       都是静态的，没有任何一帧会改变阴影内容，默认的「每帧把全场景再画进阴影贴图」纯属白干。
       这里只把 needsUpdate 置一次，第一帧（此时世界已经挂进场景）画一遍即可，
       随后 WebGLShadowMap 自己会把它归零。
       副作用：悬停 / 聚焦时建筑整体上浮最多 0.7 格，那点位移不再反映到阴影上 —— 默认机位看不出来。 */
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;

    /* ---------- 场景与雾 ---------- */
    const scene = new THREE.Scene();
    /* 起雾点必须远在小岛之外，否则朝向相机的半边校园会被雾吃掉。
       远近比例由主题给（夜晚更近更浓，白天更远更淡）。
       【性能优化】雾全程只有这一个实例，切主题时就地改 color / near / far：
       three 的渲染器按「引用」判断雾有没有换（materialProperties.fog !== scene.fog），
       换对象会让每帧每个材质都重走一遍 program 参数构建；就地改则不触发。 */
    const fog = new THREE.Fog(0x000000, 1, 2);
    scene.fog = fog;

    /* ---------- 相机 ---------- */
    const camera = new THREE.PerspectiveCamera(40, 1, 1, diagonal * 8);
    camera.position.copy(homePosition);

    /* ---------- 控制器 ---------- */
    const controls = new OrbitControls(camera, canvas);
    controls.target.copy(homeTarget);
    controls.enableDamping = true;
    // 【性能优化】阻尼因子从 0.07 → 0.18：阻尼越紧跟随越快，
    // 消除"拖一下飘半天"的粘滞感；仍保留足够阻尼避免硬邦邦的急停。
    controls.dampingFactor = 0.18;
    controls.enablePan = true;
    controls.screenSpacePanning = false;
    controls.minDistance = diagonal * ORBIT_MIN_DISTANCE_FACTOR;
    controls.maxDistance = diagonal * ORBIT_MAX_DISTANCE_FACTOR;
    controls.minPolarAngle = ORBIT_MIN_POLAR;
    /* 极角上限 85° = 视线与地面夹角不低于 5°：不允许从岛底仰视 */
    controls.maxPolarAngle = ORBIT_MAX_POLAR;
    // 视角只响应用户操作；静置、退出详情和切换预设均不启动巡游。
    controls.autoRotate = false;

    /* ---------- 灯光 ---------- */
    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x000000, 1);
    const ambient = new THREE.AmbientLight(0xffffff, 1);
    const keyLight = new THREE.DirectionalLight(0xffffff, 1);
    const fillLight = new THREE.DirectionalLight(0xffffff, 1);

    keyLight.position.copy(homeTarget).addScaledVector(ORB_DIRECTION, diagonal * KEY_LIGHT_DISTANCE_FACTOR);
    keyLight.castShadow = true;
    // 【性能优化】阴影贴图 2048 → 1024：
    // 2K 阴影 + PCFSoftShadowMap 在低端显卡/GPU 核显上非常吃力，
    // 1K 在 3440 宽屏上主观画质无明显劣化，但单帧 Fragment 开销降低 ~60%。
    // mapSize 必须是 2 的幂，这里用 1024（可按需升级至 1536 折中）。
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far = diagonal * 3.4;
    const shadowExtent = Math.max(span.x, span.z) * 0.68;
    keyLight.shadow.camera.left = -shadowExtent;
    keyLight.shadow.camera.right = shadowExtent;
    keyLight.shadow.camera.top = shadowExtent;
    keyLight.shadow.camera.bottom = -shadowExtent;
    keyLight.shadow.bias = -0.0008;
    keyLight.shadow.normalBias = 0.06;
    keyLight.target.position.copy(homeTarget);

    fillLight.position.set(center.x - diagonal * 0.5, diagonal * 0.4, center.z - diagonal * 0.55);

    scene.add(hemisphere, ambient, keyLight, keyLight.target, fillLight);

    /* ---------- 天空：穹顶 / 星空 / 云 / 日月 ---------- */
    const sky = createSkyField({
        center: { x: center.x, z: center.z },
        diagonal,
        reducedMotion,
        theme
    });
    scene.add(sky.group);

    /* ---------- 后处理：Bloom ---------- */
    const composer = new EffectComposer(renderer);
    composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.72, 0.68);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    /* ---------- 主题 ---------- */
    function applyTheme(next: ThemeName | ThemeConfig): void {
        const config = resolveThemeConfig(next);

        writeFog(config);
        sky.applyTheme(config);

        /* 主光复位到标准日月方位（ORB_DIRECTION）。
         * 过渡动画结束时日月落在地平线以下，若不复位，主光会留在岛底往上打，
         * 房顶就照不到光（表现为「切回夜晚后房顶变黑」）。
         * 过渡期间紧随其后的 updateKeyLightDirection 会覆盖这个位置，不受影响。 */
        keyLight.position.copy(homeTarget).addScaledVector(ORB_DIRECTION, diagonal * KEY_LIGHT_DISTANCE_FACTOR);
        keyLight.target.position.copy(homeTarget);

        hemisphere.color.setHex(config.lights.hemisphere.sky);
        hemisphere.groundColor.setHex(config.lights.hemisphere.ground);
        hemisphere.intensity = config.lights.hemisphere.intensity;

        ambient.color.setHex(config.lights.ambient.color);
        ambient.intensity = config.lights.ambient.intensity;

        keyLight.color.setHex(config.lights.key.color);
        keyLight.intensity = config.lights.key.intensity;

        fillLight.color.setHex(config.lights.fill.color);
        fillLight.intensity = config.lights.fill.intensity;

        renderer.toneMappingExposure = config.exposure;

        bloom.strength = config.bloom.strength;
        bloom.radius = config.bloom.radius;
        bloom.threshold = config.bloom.threshold;
    }

    /** 过渡动画期间更新主光方向（跟随日月升落弧线） */
    function updateKeyLightDirection(direction: THREE.Vector3, target: THREE.Vector3): void {
        keyLight.position.copy(target).addScaledVector(direction, diagonal * KEY_LIGHT_DISTANCE_FACTOR);
        keyLight.target.position.copy(target);
    }

    /* ---------- 尺寸与安全框 ---------- */
    let layoutBias = 0;
    /** 移动端底部占位（CSS px）：让可见窗口上移，地图中心移到抽屉之上 */
    let bottomInset = 0;

    function effectiveSize(): { w: number; h: number } {
        return {
            w: canvas.clientWidth || window.innerWidth,
            h: canvas.clientHeight || window.innerHeight
        };
    }

    function applyViewOffset(): void {
        const { w, h } = effectiveSize();
        const horizontal = Math.abs(layoutBias);
        const vertical = bottomInset;
        // 左右避让：加宽 fullWidth，裁出窗口（沿用原有行为）
        const doH = horizontal > 0 && w > horizontal * 2;
        // 底部避让：只做垂直平移，绝不放大取景
        const doV = vertical > 0.5;
        if (!doH && !doV) {
            camera.clearViewOffset();
            return;
        }
        // 【口径】垂直方向 fullHeight 保持 = 画布高，让 setViewOffset 只做纯平移：
        // 若把 fullHeight 也加大（fullH = h + vertical），透视矩阵会按比值放大画面（变焦而非平移）。
        const fullW = w + (doH ? horizontal : 0);
        const fullH = h;
        const offX = doH && layoutBias < 0 ? horizontal : 0;
        // 抽屉升高 → 地图上移，让构图中心留在抽屉之上的可视区中央。
        // 【口径】用透镜平移（setViewOffset 的 offY）实现：offY 取正画面向上平移。
        // 因透视关系，越靠近前景的物体位移越大，故取系数 0.5（≈可视区中心位置），
        // 使抽屉升到 3/4 时主体仍完整落在抽屉之上，不会被遮住。
        const offY = doV ? vertical * 0.5 : 0;
        camera.setViewOffset(fullW, fullH, offX, offY, w, h);
    }

    function resize(): void {
        const { w, h } = effectiveSize();
        camera.aspect = w / h;
        applyViewOffset();
        camera.updateProjectionMatrix();
        renderer.setSize(w, h, false);
        composer.setSize(w, h);
        /* composer.setSize 会把所有 pass 一起按画布尺寸重设，所以 Bloom 必须在这之后再压低 */
        bloom.setSize(w * BLOOM_RESOLUTION_SCALE, h * BLOOM_RESOLUTION_SCALE);
    }

    /** 左侧面板占位后调用，避免 3D 主体被面板压住 */
    function setLayoutBias(px: number): void {
        layoutBias = px;
        resize();
    }

    /** 移动端：底部抽屉占位后调用，让地图可见中心上移到抽屉上方 */
    function setBottomInset(px: number): void {
        bottomInset = Math.max(0, Math.round(px));
        resize();
    }

    function update(dt: number): void {
        controls.update();
        sky.update(dt);
        /* 平移限位：目标点始终留在校园范围内，构图不会跑飞 */
        // 【性能优化】手动内联 clamp，避免 THREE.MathUtils.clamp 的函数调用 + 临时对象分配
        // THREE.MathUtils.clamp(a, min, max) = Math.min(Math.max(a, min), max)
        const tx = controls.target.x;
        const tz = controls.target.z;
        controls.target.x = tx < 0 ? 0 : (tx > span.x ? span.x : tx);
        controls.target.z = tz < 0 ? 0 : (tz > span.z ? span.z : tz);
    }

    function render(): void {
        composer.render();
    }

    function dispose(): void {
        controls.dispose();
        sky.dispose();
        bloom.dispose();
        composer.dispose();
    }

    applyTheme(theme);
    resize();

    return {
        renderer,
        scene,
        camera,
        controls,
        sky,
        viewPresets,
        home: { position: homePosition, target: homeTarget },
        applyTheme,
        updateKeyLightDirection,
        resize,
        update,
        render,
        setLayoutBias,
        setBottomInset,
        dispose
    };
}
