/* ================================================================
   统一定位铭牌层（LocateMarkerLayer）
   —— 搜索地点点击后，在地图上标注该地点。
      区别于事件铭牌：不承载点击/详情，无背景，纯文字描边。
      锚点由 useMapScene -> locateProjection 每帧投影（跟随相机）。
   ================================================================ */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useLocateStore } from '../../store/locateStore';
import { locateProjection, type LocateAnchor } from '../locateProjection';
import styles from '../styles/locateMarker.module.css';

/** 统一入口：搜索结果点击地点时调用命中一次即可，
 *  信标（beaconManager.add，含相机导航）+ 铭牌（本层渲染）+ 地图投影。 */
export function LocateMarkerLayer() {
    const target = useLocateStore((state) => state.target);
    const [anchor, setAnchor] = useState<LocateAnchor | null>(null);
    const layerRef = useRef<HTMLDivElement>(null);

    /* 订阅投影：相机移动时锚点跟随 */
    useEffect(() => {
        setAnchor(null);
        return locateProjection.subscribe((anchors) => {
            const a = anchors.find((item) => item.id === 'locate-place') ?? null;
            setAnchor(a);
        });
    }, []);

    /* 仅类型为 place 且当前有目标时才渲染（event 走详情抽屉，不在本层展现） */
    const show = target?.kind === 'place' && anchor?.visible;
    if (!show || !target) return null;

    const accent = 'var(--amber)';

    return (
        <div
            ref={layerRef}
            className={styles.locateLayer}
            style={
                {
                    left: `${Math.round(anchor.x * 10) * 0.1}px`,
                    top: `${Math.round(anchor.y * 10) * 0.1}px`,
                    '--locate-accent': accent,
                } as CSSProperties
            }
            aria-hidden="true"
        >
            {/* 锚点指针：与事件铭牌同款小三角，但更克制（无背景纯描边） */}
            <span className={styles.locatePin} />
            <span className={styles.locateTitle}>{target.name ?? '该地点'}</span>
        </div>
    );
}