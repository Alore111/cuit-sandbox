import { memo, useEffect, useRef } from 'react';
import type { Building } from '../../contract';
import { useMapStore } from '../../store/mapStore';
import { useSelectionStore } from '../../store/selectionStore';
import styles from '../styles/hud.module.css';

/**
 * 名录里的单条。
 * 用 memo 包住：悬停/选中只影响变化的那两条，不会让上百条一起重渲染。
 */
const RosterItem = memo(function RosterItem({
    building,
    active,
    hovered,
    onSelect,
    onHover
}: {
    building: Building;
    active: boolean;
    hovered: boolean;
    onSelect: (id: string) => void;
    onHover: (id: string | null) => void;
}) {
    const buttonRef = useRef<HTMLButtonElement>(null);

    /* 选中项若在滚动区之外，自动滚进视野 */
    useEffect(() => {
        if (active) buttonRef.current?.scrollIntoView({ block: 'nearest' });
    }, [active]);

    const className = [
        styles.rosterItem,
        active || hovered ? styles.rosterItemActive : ''
    ]
        .filter(Boolean)
        .join(' ');

    return (
        <li>
            <button
                ref={buttonRef}
                type="button"
                className={className}
                onClick={() => onSelect(building.id)}
                onPointerEnter={() => onHover(building.id)}
                onPointerLeave={() => onHover(null)}
            >
                <span className={styles.rosterName}>
                    {building.name || `${building.typeLabel}（未命名）`}
                </span>
                {/* 匿名建筑标注出来：提醒这栋的高度是估的，连名字都没有 */}
                <span className={styles.rosterMeta}>
                    {building.name ? `${building.floors}F` : '匿名'}
                </span>
            </button>
        </li>
    );
});

/** 建筑名录：按占地降序（后端已排好），点击把镜头推到该建筑 */
export function RosterPanel() {
    const buildings = useMapStore((state) => state.dataset?.buildings);
    const selectedId = useSelectionStore((state) => state.selectedId);
    const hoveredId = useSelectionStore((state) => state.hoveredId);
    const select = useSelectionStore((state) => state.select);
    const setHovered = useSelectionStore((state) => state.setHovered);

    if (!buildings) return null;

    return (
        <aside className={`${styles.panel} ${styles.roster}`}>
            <div className={styles.panelHead}>
                <span className={styles.panelTitle}>建筑名录</span>
                <span className={styles.panelCount}>{buildings.length}</span>
            </div>
            <div className={styles.panelScroll}>
                <ul className={styles.rosterList}>
                    {buildings.map((building) => (
                        <RosterItem
                            key={building.id}
                            building={building}
                            active={building.id === selectedId}
                            hovered={building.id === hoveredId}
                            onSelect={select}
                            onHover={setHovered}
                        />
                    ))}
                </ul>
            </div>
        </aside>
    );
}
