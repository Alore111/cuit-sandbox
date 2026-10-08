export interface LocateAnchor {
    id: string;
    x: number;
    y: number;
    visible: boolean;
}

/** 只传屏幕坐标；相机刷新直接更新 DOM，不让 React 每帧重渲染全部卡片。 */
type LocateProjectionListener = (anchors: readonly LocateAnchor[]) => void;
const listeners = new Set<LocateProjectionListener>();
let latest: readonly LocateAnchor[] = [];

export const locateProjection = {
    publish(anchors: readonly LocateAnchor[]) {
        latest = anchors;
        listeners.forEach((listener) => listener(anchors));
    },
    subscribe(listener: LocateProjectionListener) {
        listeners.add(listener);
        listener(latest);
        return () => { listeners.delete(listener); };
    },
};