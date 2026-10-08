import { useEffect, useMemo, useRef } from 'react';
import { useMapStore } from '../../store/mapStore';
import { useSelectionStore } from '../../store/selectionStore';
import { isFinePointer } from './HintBar';
import styles from '../styles/hud.module.css';

/**
 * 悬停跟随的标签。
 * 位置用 ref 直接改 transform（每秒最多 60 次），内容走 React ——
 * 如果把指针坐标也放进 state，整棵 HUD 会跟着指针每帧重渲染。
 */
export function HoverTooltip() {
    const hoveredId = useSelectionStore((state) => state.hoveredId);
    const buildings = useMapStore((state) => state.dataset?.buildings);
    const voxelMeters = useMapStore((state) => state.dataset?.school.voxelMeters);
    const elementRef = useRef<HTMLDivElement>(null);
    const fine = useMemo(isFinePointer, []);

    useEffect(() => {
        if (!fine) return;
        const onPointerMove = (event: PointerEvent): void => {
            const element = elementRef.current;
            if (!element) return;
            element.style.transform = `translate(${event.clientX + 14}px, ${event.clientY + 14}px)`;
        };
        window.addEventListener('pointermove', onPointerMove);
        return () => window.removeEventListener('pointermove', onPointerMove);
    }, [fine]);

    const building = hoveredId
        ? buildings?.find((item) => item.id === hoveredId) ?? null
        : null;

    if (!fine || !building || voxelMeters === undefined) return null;

    return (
        <div ref={elementRef} className={styles.tooltip}>
            <b>{building.name || `${building.typeLabel}（未命名）`}</b>
            <span className={styles.tooltipMeta}>
                {building.floors}F / {building.heightMeters.toFixed(0)}m
            </span>
        </div>
    );
}
