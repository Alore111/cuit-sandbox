/* ================================================================
   属性表
   —— 【口径】与图层树分工：图层树管「图层」，这里管「逐个要素」。
      于是「按名称找对象」「批量改属性」「按列排序」都有地方放，
      图层树也不必随校园规模膨胀。
      ArcMap 的习惯照搬三处：点表头排序、点行选中（Shift 加选）、
      双击行 = 缩放至该要素；顶部一格是批量修改。

      实现上刻意不给列做泛型：建筑与地皮的字段不同，泛型会一路传染到
      渲染代码里；这里统一压成「列定义 + 单元格（显示文本 + 排序键）」，
      泛型只出现在构造数据的那一层。
================================================================ */

import { useMemo, useState } from 'react';
import { polygonAreaM2 } from '../contract';
import type { Dictionaries, MassingKey } from '../contract';
import { MASSING_KEYS } from '../contract';
import { MASSING_LABELS } from '../render/world/massing';
import type { EditorDocument } from '../services/editorService';
import { patchBuildings, patchParcels } from './editorModel';
import { TARGET_KIND_LABELS, sameTarget, targetKey } from './editorTypes';
import type { EditorTarget, FeatureTarget } from './editorTypes';
import type { EditEvent } from './EditorCanvas';
import styles from './editor.module.css';

/** 表格里显示「未覆盖」的占位文案：与数据文件里 null 的语义一致 */
const FOLLOW_LABEL = '跟随字典';

type TabKind = 'building' | 'parcel';

/** 单元格：显示文本与排序键分开，排序按真实数值而不是格式化后的字符串 */
interface Cell {
    text: string;
    sort: number | string | null;
}

interface ColumnDef {
    key: string;
    label: string;
    numeric?: boolean;
}

interface TableModel {
    columns: ColumnDef[];
    rows: { target: FeatureTarget; cells: Cell[] }[];
}

/** 把可选的数值字段渲染成「值 / 跟随字典」两种形态 */
function numberCell(value: number | null | undefined): Cell {
    if (value === null || value === undefined) return { text: FOLLOW_LABEL, sort: null };
    return { text: String(value), sort: value };
}

/** 排序：null（未覆盖）永远排在后面 */
function compareCell(a: Cell, b: Cell, desc: boolean): number {
    if (a.sort === null && b.sort === null) return 0;
    if (a.sort === null) return 1;
    if (b.sort === null) return -1;

    const result =
        typeof a.sort === 'number' && typeof b.sort === 'number'
            ? a.sort - b.sort
            : String(a.sort).localeCompare(String(b.sort), 'zh-Hans-CN');
    return desc ? -result : result;
}

export interface AttributeTableProps {
    open: boolean;
    document: EditorDocument;
    dictionaries: Dictionaries;
    selection: readonly EditorTarget[];
    activeTarget: EditorTarget | null;
    onClose: () => void;
    onSelect: (targets: EditorTarget[], additive: boolean) => void;
    onSetActive: (target: EditorTarget) => void;
    onZoomTo: (target: EditorTarget) => void;
    onEdit: (event: EditEvent) => void;
}

function toOptionalNumber(raw: string): number | null {
    if (raw.trim() === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
}

export function AttributeTable(props: AttributeTableProps) {
    const {
        open,
        document,
        dictionaries,
        selection,
        activeTarget,
        onClose,
        onSelect,
        onSetActive,
        onZoomTo,
        onEdit
    } = props;

    const [tab, setTab] = useState<TabKind>('building');
    const [keyword, setKeyword] = useState('');
    const [sort, setSort] = useState<{ key: string; desc: boolean }>({ key: 'areaM2', desc: true });
    const [batch, setBatch] = useState({ typeKey: '', massing: '', floors: '', floorHeight: '' });

    const needle = keyword.trim().toLowerCase();

    const model = useMemo<TableModel>(() => {
        if (tab === 'building') {
            const columns: ColumnDef[] = [
                { key: 'id', label: 'id' },
                { key: 'name', label: '名称' },
                { key: 'typeKey', label: '类型' },
                { key: 'massing', label: '体量做法' },
                { key: 'floors', label: '层数', numeric: true },
                { key: 'floorHeight', label: '层高', numeric: true },
                { key: 'areaM2', label: '面积 m²', numeric: true }
            ];

            const rows = document.buildings
                .filter((entry) =>
                    needle === ''
                        ? true
                        : `${entry.id} ${entry.name ?? ''} ${entry.typeKey ?? ''}`
                              .toLowerCase()
                              .includes(needle)
                )
                .map((entry) => {
                    const typeText = entry.typeKey
                        ? (dictionaries.buildings.types[entry.typeKey]?.label ?? entry.typeKey)
                        : FOLLOW_LABEL;
                    const massingText = entry.massing
                        ? MASSING_LABELS[entry.massing]
                        : FOLLOW_LABEL;
                    const areaM2 = polygonAreaM2(entry.outline);

                    return {
                        target: { kind: 'building' as const, id: entry.id },
                        cells: [
                            { text: entry.id, sort: entry.id },
                            { text: entry.name ?? '', sort: entry.name ?? '' },
                            { text: typeText, sort: entry.typeKey ?? null },
                            { text: massingText, sort: entry.massing ?? null },
                            numberCell(entry.floors),
                            numberCell(entry.floorHeight),
                            { text: areaM2.toFixed(1), sort: areaM2 }
                        ]
                    };
                });

            return { columns, rows };
        }

        const columns: ColumnDef[] = [
            { key: 'id', label: 'id' },
            { key: 'name', label: '名称' },
            { key: 'typeKey', label: '类型' },
            { key: 'areaM2', label: '面积 m²', numeric: true }
        ];

        const rows = document.parcels
            .filter((entry) => {
                if (needle === '') return true;
                const label = dictionaries.terrain.types[entry.typeKey]?.label ?? entry.typeKey;
                return `${entry.id} ${entry.name ?? ''} ${label}`.toLowerCase().includes(needle);
            })
            .map((entry) => {
                const typeText =
                    dictionaries.terrain.types[entry.typeKey]?.label ?? entry.typeKey;
                const areaM2 = polygonAreaM2(entry.outline);

                return {
                    target: { kind: 'parcel' as const, id: entry.id },
                    cells: [
                        { text: entry.id, sort: entry.id },
                        { text: entry.name ?? '', sort: entry.name ?? '' },
                        { text: typeText, sort: typeText },
                        { text: areaM2.toFixed(1), sort: areaM2 }
                    ]
                };
            });

        return { columns, rows };
    }, [tab, document, needle, dictionaries]);

    const sortedRows = useMemo(() => {
        const index = model.columns.findIndex((column) => column.key === sort.key);
        if (index < 0) return model.rows;
        return model.rows
            .slice()
            .sort((a, b) => compareCell(a.cells[index], b.cells[index], sort.desc));
    }, [model, sort]);

    const selectedKeys = useMemo(
        () => new Set(selection.map((item) => targetKey(item))),
        [selection]
    );
    /* 类型谓词让后面的批量修改能确定拿到 id */
    const selectedInTab = selection.filter(
        (item): item is FeatureTarget => item.kind === tab
    );

    if (!open) return null;

    const toggleSort = (key: string): void => {
        setSort((current) => (current.key === key ? { key, desc: !current.desc } : { key, desc: false }));
    };

    const applyBatch = (
        patch: Partial<{
            name: string;
            typeKey: string | null;
            massing: MassingKey | null;
            floors: number | null;
            floorHeight: number | null;
        }>
    ): void => {
        const ids = selectedInTab.map((item) => item.id);
        if (ids.length === 0) return;

        const next =
            tab === 'building'
                ? patchBuildings(document, ids, patch)
                : /* 地皮只有 name / typeKey 可改，其余键在构造 patch 时就不会传进来 */
                  patchParcels(document, ids, {
                      ...(patch.name === undefined ? {} : { name: patch.name }),
                      ...(patch.typeKey === undefined || patch.typeKey === null
                          ? {}
                          : { typeKey: patch.typeKey })
                  });

        onEdit({ next, before: document });
    };

    return (
        <section className={styles.tablePanel}>
            <div className={styles.panelHead}>
                <span className={styles.panelTitle}>属性表</span>
                <div className={styles.tableTabs}>
                    <button
                        type="button"
                        className={tab === 'building' ? styles.tabActive : styles.tab}
                        onClick={() => setTab('building')}
                    >
                        建筑 {document.buildings.length}
                    </button>
                    <button
                        type="button"
                        className={tab === 'parcel' ? styles.tabActive : styles.tab}
                        onClick={() => setTab('parcel')}
                    >
                        地皮 {document.parcels.length}
                    </button>
                </div>
                <input
                    className={styles.filter}
                    value={keyword}
                    placeholder="按名称 / id / 类型过滤"
                    onChange={(event) => setKeyword(event.target.value)}
                />
                <span className={styles.mono}>
                    {sortedRows.length} 行 · 选中 {selectedInTab.length}
                </span>
                <button type="button" className={styles.miniButton} onClick={onClose}>
                    收起
                </button>
            </div>

            {selectedInTab.length > 0 ? (
                <div className={styles.batchBar}>
                    <span className={styles.groupLabel}>
                        批量修改选中的 {selectedInTab.length} 项
                    </span>

                    <select
                        className={styles.batchInput}
                        value={batch.typeKey}
                        onChange={(event) => setBatch({ ...batch, typeKey: event.target.value })}
                    >
                        <option value="">类型…</option>
                        {tab === 'building' ? (
                            <option value="__follow__">{FOLLOW_LABEL}（清空覆盖）</option>
                        ) : null}
                        {tab === 'building'
                            ? Object.entries(dictionaries.buildings.types).map(([key, def]) => (
                                  <option key={key} value={key}>
                                      {def.label}（{key}）
                                  </option>
                              ))
                            : Object.entries(dictionaries.terrain.types)
                                  .sort(([, a], [, b]) => a.order - b.order)
                                  .map(([key, def]) => (
                                      <option key={key} value={key}>
                                          {def.label}（{key}）
                                      </option>
                                  ))}
                    </select>
                    <button
                        type="button"
                        className={styles.miniButton}
                        disabled={batch.typeKey === ''}
                        onClick={() =>
                            applyBatch({
                                typeKey: batch.typeKey === '__follow__' ? null : batch.typeKey
                            })
                        }
                    >
                        应用类型
                    </button>

                    {tab === 'building' ? (
                        <>
                            <select
                                className={styles.batchInput}
                                value={batch.massing}
                                onChange={(event) =>
                                    setBatch({ ...batch, massing: event.target.value })
                                }
                            >
                                <option value="">体量做法…</option>
                                <option value="__follow__">{FOLLOW_LABEL}（清空覆盖）</option>
                                {MASSING_KEYS.map((key: MassingKey) => (
                                    <option key={key} value={key}>
                                        {MASSING_LABELS[key]}（{key}）
                                    </option>
                                ))}
                            </select>
                            <button
                                type="button"
                                className={styles.miniButton}
                                disabled={batch.massing === ''}
                                onClick={() =>
                                    applyBatch({
                                        massing:
                                            batch.massing === '__follow__'
                                                ? null
                                                : (batch.massing as MassingKey)
                                    })
                                }
                            >
                                应用体量
                            </button>

                            <input
                                className={styles.batchInput}
                                type="number"
                                min={1}
                                placeholder="层数"
                                value={batch.floors}
                                onChange={(event) =>
                                    setBatch({ ...batch, floors: event.target.value })
                                }
                            />
                            <button
                                type="button"
                                className={styles.miniButton}
                                disabled={batch.floors === ''}
                                onClick={() => applyBatch({ floors: toOptionalNumber(batch.floors) })}
                            >
                                应用层数
                            </button>

                            <input
                                className={styles.batchInput}
                                type="number"
                                min={1}
                                step={0.5}
                                placeholder="层高 m"
                                value={batch.floorHeight}
                                onChange={(event) =>
                                    setBatch({ ...batch, floorHeight: event.target.value })
                                }
                            />
                            <button
                                type="button"
                                className={styles.miniButton}
                                disabled={batch.floorHeight === ''}
                                onClick={() =>
                                    applyBatch({ floorHeight: toOptionalNumber(batch.floorHeight) })
                                }
                            >
                                应用层高
                            </button>
                        </>
                    ) : null}
                </div>
            ) : null}

            <div className={styles.tableScroll}>
                <table className={styles.table}>
                    <thead>
                        <tr>
                            {model.columns.map((column) => (
                                <th
                                    key={column.key}
                                    className={column.numeric ? styles.thNumeric : styles.th}
                                    onClick={() => toggleSort(column.key)}
                                    title="点击排序"
                                >
                                    {column.label}
                                    {sort.key === column.key ? (sort.desc ? ' ▾' : ' ▴') : ''}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {sortedRows.map((row) => {
                            const key = targetKey(row.target);
                            const active = sameTarget(activeTarget, row.target);
                            const className = active
                                ? styles.rowActive
                                : selectedKeys.has(key)
                                  ? styles.rowSelected
                                  : '';

                            return (
                                <tr
                                    key={key}
                                    className={className}
                                    onClick={(event) => {
                                        onSetActive(row.target);
                                        onSelect([row.target], event.shiftKey);
                                    }}
                                    onDoubleClick={() => onZoomTo(row.target)}
                                >
                                    {row.cells.map((cell, index) => (
                                        <td
                                            key={model.columns[index].key}
                                            className={
                                                model.columns[index].numeric
                                                    ? styles.tdNumeric
                                                    : styles.td
                                            }
                                        >
                                            {cell.text}
                                        </td>
                                    ))}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            <p className={styles.tableHint}>
                点表头排序 · 点行选中（Shift 加选）· 双击行缩放至该要素 ·
                选中后在顶部批量改属性 · 显示 {TARGET_KIND_LABELS[tab]} {sortedRows.length} 行
            </p>
        </section>
    );
}
