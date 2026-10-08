/* ================================================================
   属性面板：改当前编辑对象的身份与形制
   —— 【口径】「跟随类型字典」是一等状态：留空即写回 null，与数据文件里
      「未覆盖」的语义一致。下拉的第一项永远是它，因此一次保存不会把所有
      建筑悄悄变成逐栋覆盖。

      这里只改**一个**对象（当前编辑对象）。多选批量改走属性表 ——
      两者分工与 ArcMap 的「属性窗口 / 属性表」一致。
      顶点级的操作（插点 / 删点 / 微调）都在画布上：右键菜单、Delete、方向键。
================================================================ */

import { MASSING_KEYS, polygonAreaM2 } from '../contract';
import type {
    BuildingTypeDef,
    Dictionaries,
    MassingKey,
    RawBuildingEntry,
    RawParcelEntry
} from '../contract';
import { MASSING_LABELS } from '../render/world/massing';
import type { EditorDocument } from '../services/editorService';
import { polygonPerimeterMeters, removeTargets, withOutline } from './editorModel';
import { TARGET_KIND_LABELS } from './editorTypes';
import type { EditorTarget } from './editorTypes';
import type { EditEvent } from './EditorCanvas';
import styles from './editor.module.css';

/** 下拉里表示「跟随类型字典」的哨兵值：null 不能直接放进 <option value> */
const FOLLOW = '__follow__';

export interface PropertyPanelProps {
    document: EditorDocument;
    dictionaries: Dictionaries;
    selection: readonly EditorTarget[];
    activeTarget: EditorTarget | null;
    onEdit: (event: EditEvent) => void;
    onZoomTo: (target: EditorTarget) => void;
}

/** 空串 → null（表示跟随字典），非有限数字也当没填 */
function toOptionalNumber(raw: string): number | null {
    if (raw.trim() === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
}

function formatArea(areaM2: number): string {
    return `${areaM2.toFixed(1)} m²`;
}

export function PropertyPanel(props: PropertyPanelProps) {
    const { document, dictionaries, selection, activeTarget, onEdit, onZoomTo } = props;

    if (!activeTarget) {
        return (
            <aside className={styles.propPanel}>
                <div className={styles.panelHead}>
                    <span className={styles.panelTitle}>属性</span>
                </div>
                <p className={styles.empty}>
                    在画布上点一个对象（或在属性表里选一行），这里显示它的属性。
                    {selection.length > 0 ? `（已选中 ${selection.length} 项）` : ''}
                </p>
            </aside>
        );
    }

    const building: RawBuildingEntry | null =
        activeTarget.kind === 'building'
            ? (document.buildings.find((entry) => entry.id === activeTarget.id) ?? null)
            : null;
    const parcel: RawParcelEntry | null =
        activeTarget.kind === 'parcel'
            ? (document.parcels.find((entry) => entry.id === activeTarget.id) ?? null)
            : null;
    const island = activeTarget.kind === 'island' ? document.school.island : null;

    const outline = building?.outline ?? parcel?.outline ?? island?.outline ?? [];
    const areaM2 = polygonAreaM2(outline);
    const perimeter = polygonPerimeterMeters(outline);

    const buildingType: BuildingTypeDef | null =
        building && building.typeKey ? (dictionaries.buildings.types[building.typeKey] ?? null) : null;

    const patchBuilding = (patch: Partial<RawBuildingEntry>): void => {
        if (!building) return;
        const next = {
            ...document,
            buildings: document.buildings.map((entry) =>
                entry.id === building.id ? { ...entry, ...patch } : entry
            )
        };
        onEdit({ next, before: document });
    };

    const patchParcel = (patch: Partial<RawParcelEntry>): void => {
        if (!parcel) return;
        const next = {
            ...document,
            parcels: document.parcels.map((entry) =>
                entry.id === parcel.id ? { ...entry, ...patch } : entry
            )
        };
        onEdit({ next, before: document });
    };

    return (
        <aside className={styles.propPanel}>
            <div className={styles.panelHead}>
                <span className={styles.panelTitle}>
                    {TARGET_KIND_LABELS[activeTarget.kind]}属性
                </span>
                <span className={styles.mono}>
                    {activeTarget.kind === 'island' ? 'island' : activeTarget.id}
                </span>
            </div>

            <div className={styles.propScroll}>
                {selection.length > 1 ? (
                    <p className={styles.note}>
                        已选中 {selection.length} 项，这里只显示最后选中的那一个。
                        批量改属性用「属性表」。
                    </p>
                ) : null}

                {island ? (
                    <p className={styles.note}>
                        岛面轮廓是整个沙盘的地基：它同时决定地表铺装范围与体素网格尺寸。
                        改完保存后，{document.school.name}的沙盘会按新轮廓重新栅格化
                        （建筑与地皮不动，但落在岛面之外的格子不再出图）。
                    </p>
                ) : null}

                {building ? (
                    <>
                        <label className={styles.field}>
                            <span className={styles.label}>名称</span>
                            <input
                                className={styles.input}
                                value={building.name ?? ''}
                                onChange={(event) => patchBuilding({ name: event.target.value })}
                            />
                        </label>

                        <label className={styles.field}>
                            <span className={styles.label}>类型</span>
                            <select
                                className={styles.input}
                                value={building.typeKey ?? FOLLOW}
                                onChange={(event) =>
                                    patchBuilding({
                                        typeKey:
                                            event.target.value === FOLLOW ? null : event.target.value
                                    })
                                }
                            >
                                <option value={FOLLOW}>跟随类型字典（按名称推断）</option>
                                {Object.entries(dictionaries.buildings.types).map(([key, def]) => (
                                    <option key={key} value={key}>
                                        {def.label}（{key}）
                                    </option>
                                ))}
                            </select>
                        </label>

                        <label className={styles.field}>
                            <span className={styles.label}>体量做法</span>
                            <select
                                className={styles.input}
                                value={building.massing ?? FOLLOW}
                                onChange={(event) => {
                                    const value = event.target.value;
                                    patchBuilding({
                                        massing: value === FOLLOW ? null : (value as MassingKey)
                                    });
                                }}
                            >
                                <option value={FOLLOW}>跟随类型字典</option>
                                {MASSING_KEYS.map((key: MassingKey) => (
                                    <option key={key} value={key}>
                                        {MASSING_LABELS[key]}（{key}）
                                    </option>
                                ))}
                            </select>
                        </label>

                        <label className={styles.field}>
                            <span className={styles.label}>层数</span>
                            <input
                                className={styles.input}
                                type="number"
                                min={1}
                                value={building.floors ?? ''}
                                onChange={(event) =>
                                    patchBuilding({ floors: toOptionalNumber(event.target.value) })
                                }
                            />
                        </label>

                        <label className={styles.field}>
                            <span className={styles.label}>层高（米）</span>
                            <input
                                className={styles.input}
                                type="number"
                                min={1}
                                step={0.5}
                                value={building.floorHeight ?? ''}
                                onChange={(event) =>
                                    patchBuilding({
                                        floorHeight: toOptionalNumber(event.target.value)
                                    })
                                }
                            />
                        </label>

                        <div className={styles.divider} />

                        <p className={styles.sectionTitle}>
                            体量参数
                            {buildingType
                                ? `（留空即用类型值：${buildingType.label}）`
                                : '（先指定类型才有参考值）'}
                        </p>
                        {buildingType?.massingParams
                            ? Object.entries(buildingType.massingParams).map(([key, fallback]) => (
                                  <label className={styles.field} key={key}>
                                      <span className={styles.label}>
                                          {key}
                                          <em className={styles.hint}>类型值 {fallback}</em>
                                      </span>
                                      <input
                                          className={styles.input}
                                          type="number"
                                          min={0.5}
                                          step={0.5}
                                          value={building.massingParams?.[key] ?? ''}
                                          onChange={(event) => {
                                              const next = { ...(building.massingParams ?? {}) };
                                              const value = toOptionalNumber(event.target.value);
                                              if (value === null) delete next[key];
                                              else next[key] = value;
                                              patchBuilding({
                                                  massingParams:
                                                      Object.keys(next).length === 0 ? null : next
                                              });
                                          }}
                                      />
                                  </label>
                              ))
                            : null}
                        {buildingType?.massingParams && building.massingParams ? (
                            <button
                                type="button"
                                className={styles.miniButton}
                                onClick={() => patchBuilding({ massingParams: null })}
                            >
                                清除逐栋参数（回退到类型值）
                            </button>
                        ) : null}
                    </>
                ) : null}

                {parcel ? (
                    <>
                        <label className={styles.field}>
                            <span className={styles.label}>名称</span>
                            <input
                                className={styles.input}
                                value={parcel.name ?? ''}
                                onChange={(event) => patchParcel({ name: event.target.value })}
                            />
                        </label>

                        <label className={styles.field}>
                            <span className={styles.label}>类型</span>
                            <select
                                className={styles.input}
                                value={parcel.typeKey}
                                onChange={(event) => patchParcel({ typeKey: event.target.value })}
                            >
                                {Object.entries(dictionaries.terrain.types)
                                    .sort(([, a], [, b]) => a.order - b.order)
                                    .map(([key, def]) => (
                                        <option key={key} value={key}>
                                            {def.label}（{key}）
                                        </option>
                                    ))}
                            </select>
                        </label>
                    </>
                ) : null}

                <div className={styles.divider} />

                <div className={styles.field}>
                    <span className={styles.label}>轮廓</span>
                    <p className={styles.readoutLine}>
                        {outline.length} 点 · 面积 {formatArea(areaM2)} · 周长 {perimeter.toFixed(1)} m
                    </p>
                </div>

                <div className={styles.vertexTools}>
                    <button
                        type="button"
                        className={styles.miniButton}
                        onClick={() => onZoomTo(activeTarget)}
                    >
                        缩放至该对象
                    </button>
                    {activeTarget.kind !== 'island' ? (
                        <>
                            <button
                                type="button"
                                className={styles.miniButton}
                                onClick={() => {
                                    onEdit({
                                        next: removeTargets(document, [activeTarget]),
                                        before: document
                                    });
                                }}
                            >
                                删除该对象
                            </button>
                            <button
                                type="button"
                                className={styles.miniButton}
                                onClick={() => {
                                    /* 反向轮廓 = 镜像：改不出合理形状时的一键还原手段 */
                                    const reversed = outline.slice().reverse();
                                    onEdit({
                                        next: withOutline(document, activeTarget, reversed),
                                        before: document
                                    });
                                }}
                            >
                                反转顶点方向
                            </button>
                        </>
                    ) : null}
                </div>

                <p className={styles.note}>
                    顶点操作在画布上：双击对象进入顶点编辑，拖顶点改点、拖线段插点、
                    右键菜单插 / 删点、Delete 删点、方向键微调（Shift 加速、Ctrl 减速）、
                    F2 完成。捕捉默认开启，吸附到其他对象的顶点与线段。
                </p>
            </div>
        </aside>
    );
}
