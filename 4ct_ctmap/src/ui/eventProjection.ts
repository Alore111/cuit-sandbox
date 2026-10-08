export interface EventAnchor {
    id: string;
    x: number;
    y: number;
    visible: boolean;
}

/** 只传屏幕坐标；相机刷新直接更新 DOM，不让 React 每帧重渲染全部卡片。 */
type ProjectionListener = (anchors: readonly EventAnchor[]) => void;
const listeners = new Set<ProjectionListener>();
let latest: readonly EventAnchor[] = [];

export const eventProjection = {
    publish(anchors: readonly EventAnchor[]) {
        latest = anchors;
        listeners.forEach((listener) => listener(anchors));
    },
    subscribe(listener: ProjectionListener) {
        listeners.add(listener);
        listener(latest);
        return () => { listeners.delete(listener); };
    },
};
