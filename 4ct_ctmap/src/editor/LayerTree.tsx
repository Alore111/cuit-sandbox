/* ================================================================
   图层树（目录表）
   —— 【口径】这里只列**图层**，不列单个要素 —— 与 ArcMap 的 TOC 一致。
      「逐个要素找对象 / 改属性」是属性表的事；两者分工之后，
      图层树的行数永远是常数级，不会随校园规模膨胀。
      每行三件事：显隐开关（只影响画布显示）、缩放至该图层、以及岛面的选中。
================================================================ */

import type { EditorDocument } from '../services/editorService';
import type { BaseMapMeta, EditorTarget, LayerVisibility } from './editorTypes';
import { LAYER_LABELS } from './editorTypes';
import styles from './editor.module.css';

export interface LayerTreeProps {
    document: EditorDocument;
    visibility: LayerVisibility;
    onVisibilityChange: (next: LayerVisibility) => void;
    /** 已选中的岛面（单例）时高亮 */
    islandSelected: boolean;
    basemap: { meta: BaseMapMeta; ready: boolean; error: string | null };
    onSelectIsland: () => void;
    onZoomToLayer: (kind: EditorTarget['kind']) => void;
}

/** 图层行的开关与操作按钮 */
function LayerRow(props: {
    layer: keyof LayerVisibility;
    count?: number;
    visibility: LayerVisibility;
    onVisibilityChange: (next: LayerVisibility) => void;
    /** 有明确范围的图层才给「定位」按钮 */
    onZoom?: () => void;
    onSelect?: () => void;
    selected?: boolean;
    note?: string;
    noteTitle?: string;
}) {
    const {
        layer,
        count,
        visibility,
        onVisibilityChange,
        onZoom,
        onSelect,
        selected,
        note,
        noteTitle
    } = props;

    return (
        <li className={selected ? `${styles.layerRow} ${styles.layerRowActive}` : styles.layerRow}>
            <label className={styles.layerToggle} title="显示 / 隐藏该图层（只影响画布，不改数据）">
                <input
                    type="checkbox"
                    checked={visibility[layer]}
                    onChange={(event) =>
                        onVisibilityChange({ ...visibility, [layer]: event.target.checked })
                    }
                />
            </label>

            <button
                type="button"
                className={styles.layerName}
                onClick={onSelect}
                disabled={!onSelect}
            >
                {LAYER_LABELS[layer]}
                {count === undefined ? null : <span className={styles.layerCount}>{count}</span>}
            </button>

            {note ? (
                <span className={styles.layerNote} title={noteTitle}>
                    {note}
                </span>
            ) : null}

            {onZoom ? (
                <button type="button" className={styles.miniButton} onClick={onZoom} title="缩放至该图层">
                    定位
                </button>
            ) : null}
        </li>
    );
}

export function LayerTree(props: LayerTreeProps) {
    const {
        document,
        visibility,
        onVisibilityChange,
        islandSelected,
        basemap,
        onSelectIsland,
        onZoomToLayer
    } = props;

    const basemapNote = basemap.error ? '未就绪' : basemap.ready ? '已就绪' : '加载中…';

    return (
        <aside className={styles.listPanel}>
            <div className={styles.panelHead}>
                <span className={styles.panelTitle}>图层</span>
                <span className={styles.panelCount}>
                    {document.buildings.length} / {document.parcels.length}
                </span>
            </div>

            <div className={styles.listScroll}>
                <ul className={styles.layerList}>
                    <LayerRow
                        layer="buildings"
                        count={document.buildings.length}
                        visibility={visibility}
                        onVisibilityChange={onVisibilityChange}
                        onZoom={() => onZoomToLayer('building')}
                    />
                    <LayerRow
                        layer="parcels"
                        count={document.parcels.length}
                        visibility={visibility}
                        onVisibilityChange={onVisibilityChange}
                        onZoom={() => onZoomToLayer('parcel')}
                    />
                    <LayerRow
                        layer="island"
                        count={document.school.island.outline.length}
                        visibility={visibility}
                        onVisibilityChange={onVisibilityChange}
                        onZoom={() => onZoomToLayer('island')}
                        onSelect={onSelectIsland}
                        selected={islandSelected}
                    />
                    <LayerRow
                        layer="grid"
                        visibility={visibility}
                        onVisibilityChange={onVisibilityChange}
                    />
                    <LayerRow
                        layer="basemap"
                        visibility={visibility}
                        onVisibilityChange={onVisibilityChange}
                        note={basemapNote}
                        noteTitle={
                            basemap.error ??
                            `${basemap.meta.source} · z${basemap.meta.zoom} · ${basemap.meta.fetchedAt}`
                        }
                    />
                </ul>

                <p className={styles.note}>
                    {LAYER_LABELS.island} {document.school.island.outline.length} 点 ——
                    它同时决定地表铺装范围与体素网格尺寸，改完保存后整座岛会重新栅格化。
                    逐个要素的浏览与改属性在「属性表」里。
                </p>

                {basemap.error ? <p className={styles.errorText}>{basemap.error}</p> : null}

                <p className={styles.note}>
                    底图：{basemap.meta.source}
                    <br />
                    {basemap.meta.note}
                    <br />
                    采集于 {basemap.meta.fetchedAt} · {basemap.meta.width}×{basemap.meta.height} px ·{' '}
                    {basemap.meta.metersPerPixel} m/px
                </p>
            </div>
        </aside>
    );
}
