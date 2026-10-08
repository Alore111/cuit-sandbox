import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMapStore } from './store/mapStore';
import { useCampusLiveStore } from './store/campusLiveStore';
import { useUiStore, initDeviceDetection } from './store/uiStore';
import { useLayoutBias } from './ui/hooks/useLayoutBias';
import { useMapScene } from './ui/hooks/useMapScene';
import { ErrorOverlay } from './ui/components/ErrorOverlay';
import { FxLayer } from './ui/components/FxLayer';
import { HudLayer } from './ui/components/HudLayer';
import { LoadingOverlay } from './ui/components/LoadingOverlay';
import { SceneCanvas } from './ui/components/SceneCanvas';
import { EventCalloutLayer } from './ui/components/EventCalloutLayer';
import { EventDetailDrawer } from './ui/components/EventDetailDrawer';
import { LocateMarkerLayer } from './ui/components/LocateMarkerLayer';
import { MobileLayout } from './ui/mobile/MobileLayout';

/** WebGL2 探测：不支持就明确告知，不做任何静默降级 */
function isWebGL2Supported(): boolean {
    try {
        return !!document.createElement('canvas').getContext('webgl2');
    } catch (error) {
        console.warn('[4ct-map] WebGL2 探测异常：', error);
        return false;
    }
}

export function App() {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    const load = useMapStore((state) => state.load);
    const status = useMapStore((state) => state.status);
    const error = useMapStore((state) => state.error);
    const dataset = useMapStore((state) => state.dataset);
    const world = useMapStore((state) => state.world);

    const liveInit = useCampusLiveStore((state) => state.init);
    const liveDestroy = useCampusLiveStore((state) => state.destroy);

    const isMobile = useUiStore((state) => state.isMobile);

    /* splash 揭幕动画播完后由遮罩自己回调，这里再卸载它 */
    const [splashExited, setSplashExited] = useState(false);
    const handleSplashExited = useCallback(() => setSplashExited(true), []);

    const webgl2 = useMemo(isWebGL2Supported, []);

    useLayoutBias();
    useMapScene(canvasRef);

    /* 监听分辨率断点，切换桌面/移动布局 */
    useEffect(() => initDeviceDetection(), []);

    useEffect(() => {
        if (webgl2) void load();
        return () => {
            liveDestroy();
        };
    }, [webgl2, load, liveDestroy]);

    useEffect(() => {
        if (status === 'ready' && dataset) {
            void liveInit(dataset);
        }
    }, [status, dataset, liveInit]);

    if (!webgl2) {
        return (
            <ErrorOverlay
                title="无法渲染"
                message="当前浏览器不支持 WebGL2，校园沙盘无法显示。"
            />
        );
    }

    return (
        <>
            <SceneCanvas
                canvasRef={canvasRef}
                label={dataset?.school ? `${dataset.school.name}${dataset.school.campusName}沙盘` : '校园沙盘'}
            />
            <FxLayer />
            <EventCalloutLayer />
            {/* 桌面：现有 HUD；移动：独立底部抽屉布局 */}
            {isMobile ? <MobileLayout /> : <HudLayer />}
            {/* 事件详情抽屉（独立浮层，z-index 高于搜索栏） */}
            {!isMobile && <EventDetailDrawer />}
            {/* 统一定位铭牌层：搜索结果地点点击后的地图标注 */}
            <LocateMarkerLayer />
            {/* splash 一直挂到揭幕动画播完（ready 由世界构建结果驱动） */}
            {status !== 'error' && !splashExited ? (
                <LoadingOverlay ready={world !== null} onExited={handleSplashExited} />
            ) : null}
            {status === 'error' ? (
                <ErrorOverlay title="启动失败" message={error ?? '未知错误'} />
            ) : null}
        </>
    );
}
