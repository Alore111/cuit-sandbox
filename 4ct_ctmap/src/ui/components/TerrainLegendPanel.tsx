import { resolveGlobalColor, type GlobalColorKey } from '../../render/theme/palette';
import { useMapStore } from '../../store/mapStore';
import { useUiStore } from '../../store/uiStore';
import { toCssHex, formatCount } from '../../utils/format';
import styles from '../styles/hud.module.css';

/**
 * 地皮图例：类型与占比都来自数据。
 * 色块颜色从当前主题的 3D 色板取，保证「图例上的颜色」与「沙盘上的颜色」是同一个值。
 */
export function TerrainLegendPanel() {
    const dataset = useMapStore((state) => state.dataset);
    const world = useMapStore((state) => state.world);
    const theme = useUiStore((state) => state.theme);

    if (!dataset) return null;

    const { school, dictionaries } = dataset;
    const types = Object.entries(dictionaries.terrain.types).sort(
        ([, a], [, b]) => a.order - b.order
    );
    const counts = world?.stats.terrainCellsByType ?? {};
    const total = world?.stats.islandCells ?? 0;
    const defaultLabel =
        dictionaries.terrain.types[school.defaultTerrainTypeKey]?.label ??
        school.defaultTerrainTypeKey;

    return (
        <aside className={`${styles.panel} ${styles.legend}`}>
            <div className={`${styles.panelHead} ${styles.legendHead}`}>
                <span className={styles.panelTitle}>地皮分类</span>
            </div>
            <ul className={styles.legendList}>
                {types.map(([key, def]) => {
                    const count = counts[key] ?? 0;
                    const percent = total > 0 ? `${Math.round((count / total) * 100)}%` : '0%';
                    return (
                        <li key={key} className={styles.legendItem}>
                            <span
                                className={styles.legendSwatch}
                                style={{
                                    background: toCssHex(
                                        resolveGlobalColor(
                                            theme,
                                            def.paletteKeys[0] as GlobalColorKey
                                        )
                                    )
                                }}
                            />
                            <span>{def.label}</span>
                            <span className={styles.legendCount}>{percent}</span>
                        </li>
                    );
                })}
            </ul>
            {/* <p className={styles.legendNote}>
                岛面共 {formatCount(total)} 个体素格：地皮按面积从大到小逐层覆盖，
                未被覆盖处铺「{defaultLabel}」。{school.attribution}
            </p> */}
        </aside>
    );
}
