/* ================================================================
   3D 场景的生命周期与状态同步
   —— 这是界面层与渲染层之间唯一的接线处：
      · 数据集就绪 → 建世界、装事件、起主循环；
      · 悬停/选中 → 只有一个刷新入口 syncStates()，3D 表现与界面高亮永远同源；
      · 主题切换 → 只重写着色，不重建场景。

   建世界是分帧异步的（见 render/scheduler）：装配段因此拆成 mount()，
   由异步的前置段在构建完成后调用；构建期间本 effect 被清理则整个结果丢弃。

   渲染循环刻意不放在 React 的渲染周期里：它只读写 store，
   React 只负责 HUD 的声明式渲染，60fps 的循环不会因重渲染被拖慢。
================================================================ */

import { useEffect, useRef, type RefObject } from 'react';
import * as THREE from 'three';
import { BUILDING_STATE } from '../../render/theme/palette';
import { createThemeTransition } from '../../render/theme/themeTransition';
import { createStage, type Stage } from '../../render/stage';
import { createPicker, type Picker } from '../../render/picking';
import { createFocusController, type FocusController } from '../../render/view/focus';
import { buildWorld, type World } from '../../render/world/worldBuilder';
import { buildHeatBeams, type HeatBeamsHandle } from '../../render/campus/heatBeamsBuilder';
import { Beacon } from '../../render/beacon';
import { attachBeaconManager, detachBeaconManager, updateBeacons, applyBeaconTheme } from '../../render/beaconManager';
import { resolveEventColor } from '../../contract/campusLive';
import { useMapStore } from '../../store/mapStore';
import { useSelectionStore } from '../../store/selectionStore';
import { useUiStore } from '../../store/uiStore';
import { useCampusLiveStore } from '../../store/campusLiveStore';
import { useLocateStore } from '../../store/locateStore';
import { eventProjection } from '../eventProjection';
import { locateProjection } from '../locateProjection';

/** 位移超过这个像素数就算「拖拽视角」，抬手时不触发选中 */
const DRAG_THRESHOLD_PX = 4;

interface Scene {
    stage: Stage;
    world: World;
    picker: Picker;
    focus: FocusController;
    heatBeams?: HeatBeamsHandle;
    /** 事件锚点信标：事件详情打开时标注点位 */
    beacon?: Beacon;
    /** 昼夜过渡控制器 */
    transition: ReturnType<typeof createThemeTransition>;
    /** 从 store 同步到渲染层的订阅取消函数 */
    unsubscribeLive?: () => void;
}

export function useMapScene(canvasRef: RefObject<HTMLCanvasElement>): void {
    const dataset = useMapStore((state) => state.dataset);
    const setWorld = useMapStore((state) => state.setWorld);
    const theme = useUiStore((state) => state.theme);
    const layoutBias = useUiStore((state) => state.layoutBias);
    const bottomInset = useUiStore((state) => state.bottomInset);
    const viewPreset = useUiStore((state) => state.viewPreset);
    const eventFocusRequest = useUiStore((state) => state.eventFocusRequest);
    const detailEventId = useCampusLiveStore((state) => state.detailEventId);

    const sceneRef = useRef<Scene | null>(null);

    /* ---------------- 数据集就绪 → 建世界 ---------------- */
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !dataset) return;

        /* 构建是分帧异步的（见 render/scheduler）：本 effect 的 cleanup 有可能在它跑完之前就执行
           （数据集被换掉 / 组件卸载）。用 cancelled 标记本次装配是否作废 —— 作废时把建好的世界
           直接丢掉，绝不往已经卸载的场景里塞半个世界。 */
        let cancelled = false;
        /** 装配完成后才有；本 effect 的 cleanup 据此拆卸 */
        let teardown: (() => void) | null = null;

        /** 构建失败：原样上报，不留一个空画面 */
        function reportSceneError(error: unknown): void {
            useMapStore.setState({
                status: 'error',
                error: error instanceof Error ? error.message : String(error)
            });
        }

        void (async () => {
            const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

            let world: World;
            try {
                world = await buildWorld(dataset, useUiStore.getState().theme, reducedMotion);
            } catch (error) {
                reportSceneError(error);
                return;
            }
            if (cancelled) {
                world.dispose();
                return;
            }

            let stage: Stage;
            try {
                stage = createStage({
                    canvas,
                    center: world.grid.center,
                    span: world.grid.size,
                    islandDepth: world.islandDepth,
                    reducedMotion,
                    theme: useUiStore.getState().theme
                });
            } catch (error) {
                /* 世界已建好、舞台没起来：把世界的材质释放掉，别留在内存里 */
                world.dispose();
                reportSceneError(error);
                return;
            }

            teardown = mount(world, stage, reducedMotion, canvas);
        })();

        return () => {
            cancelled = true;
            teardown?.();
        };
    }, [dataset, canvasRef, setWorld]);

    /**
     * 世界与舞台就绪后的装配：接线、事件、主循环。返回值即拆卸函数。
     * 单独成函数是因为「建世界」那一步现在是异步的（见上面的 effect）。
     */
    function mount(
        world: World,
        stage: Stage,
        reducedMotion: boolean,
        canvas: HTMLCanvasElement
    ): () => void {
        stage.scene.add(world.group);

        /* ---------- 校园实况：连续热力光晕 ---------- */
        const liveState = useCampusLiveStore.getState();
        const heatBeams = buildHeatBeams(
            liveState.snapshot?.heatList ?? [],
            world.grid,
            useUiStore.getState().theme,
            reducedMotion,
        );
        heatBeams.setVisible(liveState.showHeat);
        heatBeams.setLevelFilter(liveState.heatFilterLevel);
        stage.scene.add(heatBeams.group);

        /* ---------- 事件锚点信标：事件详情打开时标注点位 ---------- */
        const beacon = new Beacon({
            position: { x: world.grid.center.x, z: world.grid.center.z },
            theme: useUiStore.getState().theme,
            reducedMotion,
        });
        beacon.setVisible(false);
        stage.scene.add(beacon.group);

        /* 订阅 campusLiveStore：
         *   · snapshot 变化 → replaceHeats
         *   · showHeat 变化 → setVisible
         *   · heatFilterLevel 变化 → setLevelFilter
         * 全部走 zustand.subscribe（不放在 React 重渲染里），避免 60fps 循环被 React 打断。
         */
        let prevSnapshot = liveState.snapshot;
        const unsubscribeLive = useCampusLiveStore.subscribe((s) => {
            if (s.snapshot !== prevSnapshot) {
                prevSnapshot = s.snapshot;
                if (s.snapshot) {
                    heatBeams.replaceHeats(s.snapshot.heatList, world.grid);
                } else {
                    heatBeams.replaceHeats([], world.grid);
                }
            }
            heatBeams.setVisible(s.showHeat);
            heatBeams.setLevelFilter(s.heatFilterLevel);
        });

        const focus = createFocusController(stage.camera, stage.controls, stage.home);
        const picker = createPicker(stage.camera, canvas, world.buildings.proxies);
        const transition = createThemeTransition();
        sceneRef.current = { stage, world, picker, focus, heatBeams, beacon, transition, unsubscribeLive };

        /* 挂接 window.mapBeacons 管理器所需的场景句柄（重建保留的自定义信标） */
        attachBeaconManager({ grid: world.grid, scene: stage.scene, focus }, reducedMotion);

        setWorld({
            stats: world.stats,
            warnings: world.warnings,
            buildingRuntime: world.buildingRuntime
        });

        /* ---------------- 唯一的刷新入口 ---------------- */
        let hoveredId: string | null = null;
        let selectedId: string | null = null;

        function syncStates(): void {
            for (const item of world.buildings.items) {
                const id = item.building.id;
                const state =
                    id === selectedId
                        ? BUILDING_STATE.FOCUS
                        : id === hoveredId
                          ? BUILDING_STATE.HOVER
                          : BUILDING_STATE.IDLE;
                world.buildings.setState(id, state);
            }
        }

        /* 悬停每变一次都要同步（高亮），相机只在选中项真的换了才动 */
        const unsubscribe = useSelectionStore.subscribe((state) => {
            const selectedChanged = state.selectedId !== selectedId;

            hoveredId = state.hoveredId;
            selectedId = state.selectedId;
            syncStates();

            if (!selectedChanged) return;

            if (selectedId === null) {
                focus.reset();
                return;
            }

            const item = world.buildings.get(selectedId);
            if (!item) return;

            focus.focusOn({
                center: item.center,
                apexVoxels: item.apexVoxels,
                footprint: item.footprint
            });
        });

        /* ---------------- 指针事件 ---------------- */
        let pointer: { x: number; y: number } | null = null;
        let pointerDown: { x: number; y: number } | null = null;
        let dragged = false;

        const onPointerMove = (event: PointerEvent): void => {
            pointer = { x: event.clientX, y: event.clientY };
        };
        const onPointerDown = (event: PointerEvent): void => {
            pointerDown = { x: event.clientX, y: event.clientY };
            dragged = false;
        };
        const onPointerUp = (event: PointerEvent): void => {
            if (
                pointerDown &&
                Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) >
                    DRAG_THRESHOLD_PX
            ) {
                dragged = true;
            }
            pointerDown = null;
        };
        const onPointerLeave = (): void => {
            pointer = null;
            pointerDown = null;
            dragged = false;
            useSelectionStore.getState().setHovered(null);
        };
        const onClick = (event: MouseEvent): void => {
            /* 拖拽旋转视角时抬手会附带一次 click，这里要挡掉，否则转个视角就选中了 */
            if (dragged) {
                dragged = false;
                return;
            }
            // 点击事件不多，但直接走缓存路径可以省下一次 GBCR 回流
            useSelectionStore.getState().select(picker.pickWithRect(event.clientX, event.clientY, canvasRect));
            // 详情抽屉打开时，点击画布空白（实际是 scrim 拦截，到不了这里）不应清事件高亮。
            if (!useCampusLiveStore.getState().detailEventId) {
                useCampusLiveStore.getState().setHoveredEvent(null);
                useCampusLiveStore.getState().selectEvent(null);
            }
        };
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                const liveState = useCampusLiveStore.getState();
                // 1) 先关详情抽屉（不复位镜头）
                if (liveState.detailEventId) {
                    liveState.openDetail(null);
                    return;
                }
                // 2) 再清事件高亮
                if (liveState.selectedEventId || liveState.hoveredEventId) {
                    liveState.setHoveredEvent(null);
                    liveState.selectEvent(null);
                    return;
                }
                // 3) 最后才是建筑聚焦复位
                useSelectionStore.getState().select(null);
            }
        };

        /* ---------------- 预声明缓存与工具（onResize 依赖） ---------------- */
        // 【性能优化】缓存 canvas 的 bounding rect：
        // getBoundingClientRect 强制浏览器回流，每帧调用开销 ~0.1ms × 多次 = 掉帧。
        // 只在 resize / pointerenter 时重算，主循环直接读缓存。
        // canvasRect 同时供 picking 和 projectEvents 使用，避免两处都调 GBCR。
        let canvasRect = { left: 0, top: 0, width: 0, height: 0 };
        function refreshCanvasRect(): void {
            const r = canvas!.getBoundingClientRect();
            canvasRect = { left: r.left, top: r.top, width: r.width, height: r.height };
        }
        refreshCanvasRect();

        // projectionDirty 必须在 onResize 之前声明，否则 onResize 引用的是未定义变量
        let projectionDirty = true;

        /* ---------------- 尺寸 ---------------- */
        const onResize = (): void => {
            stage.resize();
            refreshCanvasRect(); // 窗口/面板尺寸变化后必须重取 canvas 相对视口的偏移
            projectionDirty = true;
        };
        window.addEventListener('resize', onResize);
        stage.setLayoutBias(useUiStore.getState().layoutBias);

        canvas.addEventListener('pointermove', onPointerMove);
        canvas.addEventListener('pointerdown', onPointerDown);
        canvas.addEventListener('pointerup', onPointerUp);
        canvas.addEventListener('pointerleave', onPointerLeave);
        canvas.addEventListener('click', onClick);
        // 鼠标首次进入画布时刷新一次：防止页面初始滚动条出现 / 其他面板折叠后 canvas 位移但未触发 resize
        canvas.addEventListener('pointerenter', refreshCanvasRect);
        window.addEventListener('keydown', onKeyDown);

        /* ---------------- 主循环 ---------------- */
        const clock = new THREE.Clock();
        let frameId = 0;
        const projected = new THREE.Vector3();
        const viewPosition = new THREE.Vector3();
        const previousView = new THREE.Matrix4();
        const previousProjection = new THREE.Matrix4();
        let projectionSnapshot = liveState.snapshot;
        /* 定位目标引用：目标变化时强制重投影（相机可能没动，但锚点位置变了） */
        let projectionLocateTarget = useLocateStore.getState().target;

        // 【性能优化】resolveHover 脏检测：
        // raycaster 每帧扫一遍 proxy 盒代价不小，若 pointer 坐标未变就跳过。
        // 【口径决策】不做 Matrix4 比较：matrixWorldInverse 是 getter（隐含 updateMatrixWorld 开销），
        // 加上 16-float equals 每帧 ~0.04ms。用户拖动视角时 pointer 一定在变（鼠标按住拖动），
        // 松手后阻尼飘的 1~2 帧即便 hover 未更新也无感知。这样脏检测从"每帧矩阵比较"
        // 降为"每帧 2 个 int 比较"，空闲悬停状态零额外开销。
        let lastHoverPointerX = -1;
        let lastHoverPointerY = -1;

        let projectionFirstRun = true;
        function projectEvents(): void {
            const snapshot = useCampusLiveStore.getState().snapshot;
            const locateTarget = useLocateStore.getState().target;
            const camera = stage.camera;
            // Strict Mode remount 后 previousView/Projection 都是 Identity，
            // 与未动的 camera 的 real matrices 可能相等（因为 remount 后 new 的 stage 与旧的 camera 相同）
            // 加上 projectionFirstRun 强制第一帧 publish，保证 remount 也有 anchors。
            // 【性能优化】先做 early return，不满足时才调用 camera.updateMatrixWorld()，
            // 避免相机静止时每帧强制更新矩阵（~0.05ms 无谓开销）。
            if (!projectionFirstRun && !projectionDirty && snapshot === projectionSnapshot &&
                locateTarget === projectionLocateTarget &&
                previousView.equals(camera.matrixWorldInverse) &&
                previousProjection.equals(camera.projectionMatrix)) return;
            // early return 不通过 → 相机或事件数据真的变了，再同步矩阵
            camera.updateMatrixWorld();
            projectionFirstRun = false;
            projectionDirty = false;
            projectionSnapshot = snapshot;
            projectionLocateTarget = locateTarget;
            previousView.copy(camera.matrixWorldInverse);
            previousProjection.copy(camera.projectionMatrix);
            const rect = canvasRect; // 直接用缓存，不触发回流
            eventProjection.publish((snapshot?.events ?? []).map((event) => {
                // 无坐标的事件只在列表中展示，不编造位置或指向其他地点。
                if (!event.position) return { id: event.id, x: 0, y: 0, visible: false };
                const { vx, vz } = world.grid.lonLatToVoxel(...event.position);
                const point = world.grid.voxelToWorld(vx, vz);
                const building = event.locationId ? world.buildings.get(event.locationId) : undefined;
                projected.set(point.x, building ? building.apexVoxels + 1 : 1.1, point.z);
                viewPosition.copy(projected).applyMatrix4(camera.matrixWorldInverse);
                projected.project(camera);
                return {
                    id: event.id,
                    x: rect.left + (projected.x + 1) * rect.width / 2,
                    y: rect.top + (1 - projected.y) * rect.height / 2,
                    visible: viewPosition.z < 0 && projected.z >= -1 && projected.z <= 1 &&
                        Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1,
                };
            }));
            /* 统一定位目标（地点铭牌）：place 类型锚点跟随相机投影 */
            locateProjection.publish(
                locateTarget && locateTarget.kind === 'place' && locateTarget.position
                    ? (() => {
                          const { vx, vz } = world.grid.lonLatToVoxel(...locateTarget.position);
                          const point = world.grid.voxelToWorld(vx, vz);
                          const building = locateTarget.buildingId
                              ? world.buildings.get(locateTarget.buildingId)
                              : undefined;
                          projected.set(point.x, building ? building.apexVoxels + 1 : 1.1, point.z);
                          viewPosition.copy(projected).applyMatrix4(camera.matrixWorldInverse);
                          projected.project(camera);
                          return [{
                              id: 'locate-place',
                              x: rect.left + (projected.x + 1) * rect.width / 2,
                              y: rect.top + (1 - projected.y) * rect.height / 2,
                              visible: viewPosition.z < 0 && projected.z >= -1 && projected.z <= 1 &&
                                  Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1,
                          }];
                      })()
                    : []
            );
        }

        function resolveHover(): void {
            if (!pointer || dragged || focus.animating) return;
            // 【性能优化】脏检测只比较 pointer 坐标（2 个 int 比较，零分配零 getter）。
            // 用户按住鼠标拖动视角时 → pointer 每帧变化 → 正常拾取；
            // 松手后仅剩 controls 阻尼 → pointer 不变 → 跳过拾取（1~2 帧 hover 延迟无感）；
            // 鼠标悬停不动 → pointer 不变 → 完全跳过，零额外开销。
            if (pointer.x === lastHoverPointerX && pointer.y === lastHoverPointerY) return;
            lastHoverPointerX = pointer.x;
            lastHoverPointerY = pointer.y;
            const id = picker.pickWithRect(pointer.x, pointer.y, canvasRect);
            if (id !== useSelectionStore.getState().hoveredId) {
                useSelectionStore.getState().setHovered(id);
            }
        }

        function frame(): void {
            const dt = Math.min(clock.getDelta(), 0.05);
            // 【性能优化】执行顺序调整：
            //   transition → update → projectEvents → resolveHover → render
            // projectEvents 放在 render 之前：它要修改 DOM 样式，浏览器会在下一次"样式计算"阶段
            // 合并这些变更，不会因 stage.render() 已经提交 GPU 而错过这帧的合成时机。
            // 也就是铭牌坐标更新与 WebGL 绘制的 pixel 同时出现在屏幕上，消除「拖影感」。

            /* 昼夜过渡动画：每帧生成插值配置，应用到场景全部视觉参数。
             * order 要点：applyTheme 会把主光/日月复位到标准方位，紧随其后的
             * updateKeyLightDirection / updateCelestial 再用本帧弧线方位覆盖，
             * 因此这里的调用顺序不能颠倒。 */
            const scene = sceneRef.current;
            if (scene) {
                const result = scene.transition.update(dt);
                if (result) {
                    const { config, orbDirection } = result;
                    stage.applyTheme(config);
                    world.applyTheme(config);
                    stage.updateKeyLightDirection(orbDirection, stage.home.target);
                    stage.sky.updateCelestial(orbDirection, config.sky.orb.body, config.sky.orb.glow);
                    scene.heatBeams?.applyTheme(config);
                    scene.beacon?.applyTheme(config);
                } else if (scene.transition.active === false && useUiStore.getState().transitioning) {
                    /* 过渡刚结束：按最终主题走静态收尾（主光/日月一并归位） */
                    useUiStore.getState().finishTransition();
                }
            }

            stage.update(dt);
            focus.update(dt);
            world.update(dt);
            sceneRef.current?.heatBeams?.update(dt);
            sceneRef.current?.beacon?.update(dt);
            updateBeacons(dt);
            projectEvents();
            resolveHover();
            stage.render();
            frameId = requestAnimationFrame(frame);
        }
        frameId = requestAnimationFrame(frame);

        return () => {
            cancelAnimationFrame(frameId);
            // React 18 Strict Mode 会 mount → unmount → remount，此 cleanup 在"中间 unmount"执行，
            // 若此时 publish([])，会把 eventProjection 的 latest 清掉，导致 remount 后 subscribe()
            // 立即收到空数组，而 projectEvents 又因 camera 静止被判"无脏"不重发，铭牌永无位置。
            // 改为只在真正退出页（dataset/canvas 真变）时不再 push 空数组；EventCalloutLayer 自己会因
            // snapshot.showEvents=false 或 effect cleanup 清 ref，不会残留标签。
            unsubscribe();
            sceneRef.current?.unsubscribeLive?.();
            canvas.removeEventListener('pointermove', onPointerMove);
            canvas.removeEventListener('pointerdown', onPointerDown);
            canvas.removeEventListener('pointerup', onPointerUp);
            canvas.removeEventListener('pointerleave', onPointerLeave);
            canvas.removeEventListener('click', onClick);
            canvas.removeEventListener('pointerenter', refreshCanvasRect); // 【优化】配对清理新增的监听
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('resize', onResize);

            stage.scene.remove(world.group);
            sceneRef.current?.heatBeams && stage.scene.remove(sceneRef.current.heatBeams.group);
            sceneRef.current?.beacon && stage.scene.remove(sceneRef.current.beacon.group);
            world.dispose();
            sceneRef.current?.heatBeams?.dispose();
            sceneRef.current?.beacon?.dispose();
            /* 摘掉管理器句柄；自定义信标经纬度数据保留，下次场景重建自动恢复 */
            detachBeaconManager();
            stage.dispose();
            stage.renderer.dispose();
            sceneRef.current = null;
        };
    }

    /* ---------------- 主题切换：启动过渡动画 ---------------- */
    const transitioning = useUiStore((state) => state.transitioning);
    const targetTheme = useUiStore((state) => state.targetTheme);

    useEffect(() => {
        const scene = sceneRef.current;
        if (!scene) return;

        if (transitioning) {
            /* 启动过渡动画：从当前主题过渡到目标主题 */
            scene.transition.start(theme, targetTheme);
        } else {
            /* 非过渡状态（初始化 / 过渡结束收尾）：直接应用最终主题 */
            scene.stage.applyTheme(theme);
            scene.world.applyTheme(theme);
            scene.heatBeams?.applyTheme(theme);
            scene.beacon?.applyTheme(theme);
            applyBeaconTheme(theme);
        }
    }, [transitioning, theme, targetTheme]);

    /* ---------------- 安全框：让沙盘避开左侧面板 ---------------- */
    useEffect(() => {
        sceneRef.current?.stage.setLayoutBias(layoutBias);
    }, [layoutBias]);

    /* ---------------- 安全框：底部抽屉占位时让地图上移（移动端） ---------------- */
    useEffect(() => {
        sceneRef.current?.stage.setBottomInset(bottomInset);
    }, [bottomInset]);

    /* ---------------- 预设机位：与聚焦共用同一套补间 ---------------- */
    useEffect(() => {
        const scene = sceneRef.current;
        if (!scene) return;

        const pose = scene.stage.viewPresets[viewPreset];
        scene.focus.moveTo(pose.position, pose.target);
    }, [viewPreset]);

    /* ---------------- 事件铭牌聚焦：点击铭牌 → 镜头推到事件锚点 ---------------- */
    useEffect(() => {
        const scene = sceneRef.current;
        const request = eventFocusRequest;
        if (!scene || !request) return;

        const snapshot = useCampusLiveStore.getState().snapshot;
        const event = snapshot?.events.find((e) => e.id === request.eventId);
        // 无坐标的事件没有锚点可推（投影层也不渲染它的铭牌），不移动镜头
        if (!event || !event.position) return;

        // 与事件铭牌投影同一套换算：经纬度 → 体素 → 世界坐标的 x/z
        const { vx, vz } = scene.world.grid.lonLatToVoxel(...event.position);
        const point = scene.world.grid.voxelToWorld(vx, vz);
        // 锚点高度：事件挂在建筑上时看建筑中段；否则贴近地表（与投影的锚点高度同口径）
        const building = event.locationId ? scene.world.buildings.get(event.locationId) : undefined;
        const anchorY = building ? building.apexVoxels * 0.45 : 1.1;
        // 取景距离 = 网格对角线 × 系数，保证锚点与周边落在视野内
        const diagonal = Math.hypot(scene.world.grid.size.x, scene.world.grid.size.z);
        scene.focus.focusOnPoint(
            new THREE.Vector3(point.x, anchorY, point.z),
            Math.max(diagonal * 0.3, 60)
        );
    }, [eventFocusRequest]);

    /* ---------------- 事件锚点信标：详情打开时显示并移到锚点，关闭时隐藏 ---------------- */
    useEffect(() => {
        const scene = sceneRef.current;
        if (!scene) return;

        if (!detailEventId) {
            scene.beacon?.setVisible(false);
            return;
        }

        const snapshot = useCampusLiveStore.getState().snapshot;
        const event = snapshot?.events.find((e) => e.id === detailEventId);
        // 无坐标的事件不可锚定，信标不显示
        if (!event || !event.position) {
            scene.beacon?.setVisible(false);
            return;
        }

        const { vx, vz } = scene.world.grid.lonLatToVoxel(...event.position);
        const point = scene.world.grid.voxelToWorld(vx, vz);

        // 颜色跟随事件分类色，与铭牌/详情标签同口径
        const categoryColor = resolveEventColor(event.category, 'category');
        scene.beacon?.setPosition(point.x, point.z);
        scene.beacon?.setColor(categoryColor);
        // 光柱高度用构造时的默认值：光柱是「标注光效」而非「高度数据」，
        // 恒定高度观感统一，超出建筑顶少许更醒目。
        scene.beacon?.setVisible(true);
    }, [detailEventId]);
}
