/* ================================================================
   类型配色面板
   —— 改的是**建筑类型字典**（每个类型一组「墙面主色 + 屋顶主色」），
      不是某个要素的属性：同一类型的所有楼一次全变，因此它独立成面板，
      与属性面板（改当前对象）、属性表（逐个要素）分工清楚。

   【口径】面板里填的是**日景**主色（#rrggbb）：墙暗部与夜景都由渲染层按固定系数
      派生（见 render/theme/palette.ts），所以一处颜色昼夜都成立，不必填两套。
      留空 = 跟随该类型的色板配色组；两种状态在面板上必须一眼可分：
      色块实线 = 已配色，虚线 = 跟随色板（色块显示的是回落的色板色，不是已配置的值）。

   取色过程不记撤销栈（与地图拖动同一口径）：开始取色时拍一张快照，
   取完（失焦）补记一次 —— 否则一次调色会在 60 深的栈里留下几十步噪音。
================================================================ */

import { useRef } from 'react';
import type { RawBuildingTypeDef } from '../contract';
import { THEMES } from '../render/theme/palette';
import type { ThemeName } from '../types/theme';
import type { EditorDocument } from '../services/editorService';
import { setTypeColors, type TypeColorPatch } from './editorModel';
import type { EditEvent } from './EditorCanvas';
import styles from './editor.module.css';

/** 0xrrggbb → #rrggbb：<input type="color"> 只认字符串形式 */
function toHexInput(color: number): string {
    return `#${color.toString(16).padStart(6, '0')}`;
}

export interface TypePalettePanelProps {
    open: boolean;
    document: EditorDocument;
    /** 面板显示的「色板回落色」跟当前主题走（主题是全局的，沙盘与编辑器共用） */
    theme: ThemeName;
    onClose: () => void;
    onEdit: (event: EditEvent) => void;
}

export function TypePalettePanel(props: TypePalettePanelProps) {
    const { open, document, theme, onClose, onEdit } = props;

    /** 一次取色（从开始拖色到松开）之前的文档快照，null 表示当前没有在取色 */
    const pickingBefore = useRef<EditorDocument | null>(null);

    if (!open) return null;

    const types = Object.entries(document.buildingTypes.types);
    const swatches = THEMES[theme].building;

    const patchType = (typeKey: string, patch: TypeColorPatch): void => {
        const next = setTypeColors(document, typeKey, patch);
        if (next === document) return;
        onEdit({ next, before: document });
    };

    /** 取色中：只改文档、不记栈 */
    const pickColor = (typeKey: string, patch: TypeColorPatch): void => {
        pickingBefore.current ??= document;
        const next = setTypeColors(document, typeKey, patch);
        if (next === document) return;
        onEdit({ next, before: null });
    };

    /** 取色结束（失焦）：补记一次，撤销一次退一整次调色 */
    const finishPicking = (): void => {
        const before = pickingBefore.current;
        if (!before) return;
        pickingBefore.current = null;
        onEdit({ next: document, before });
    };

    /**
     * 一行里的一个颜色字段。
     * 色块的值在「已配色」时是配置值，在「跟随色板」时是回落的色板值 ——
     * 靠虚线与右侧文字区分，因此不会把回落色误读成已经配过的色。
     */
    const colorField = (
        typeKey: string,
        def: RawBuildingTypeDef,
        field: 'wallColor' | 'roofColor',
        fallback: number
    ) => {
        const configured = def[field];
        return (
            <div className={styles.paletteColorField}>
                <input
                    type="color"
                    className={
                        configured
                            ? styles.swatchInput
                            : `${styles.swatchInput} ${styles.swatchInputFollow}`
                    }
                    value={configured ?? toHexInput(fallback)}
                    title={
                        configured
                            ? `${field === 'wallColor' ? '墙面' : '屋顶'}主色：${configured}`
                            : `${field === 'wallColor' ? '墙面' : '屋顶'}主色未配置，当前跟随色板 ${toHexInput(fallback)}`
                    }
                    onChange={(event) => pickColor(typeKey, { [field]: event.target.value })}
                    onBlur={finishPicking}
                />
                <span className={styles.colorValue}>
                    {configured ?? `色板 ${toHexInput(fallback)}`}
                </span>
            </div>
        );
    };

    return (
        <section className={styles.tablePanel}>
            <div className={styles.panelHead}>
                <span className={styles.panelTitle}>类型配色</span>
                <span className={styles.mono}>{types.length} 个类型</span>
                <span className={styles.mono}>填日景主色，夜景由渲染层压暗</span>
                <button type="button" className={styles.miniButton} onClick={onClose}>
                    收起
                </button>
            </div>

            <div className={styles.paletteList}>
                {types.map(([typeKey, def]) => {
                    /* 色板覆盖自检在构建世界时做过；这里缺组就显示不了回落色，直接说明而不是画个黑块 */
                    const swatch = swatches[def.paletteKey];
                    return (
                        <div key={typeKey} className={styles.paletteRow}>
                            <div className={styles.paletteName}>
                                <span>{def.label}</span>
                                <span className={styles.mono}>
                                    {typeKey} · {def.paletteKey}
                                </span>
                            </div>

                            {swatch ? (
                                <>
                                    <span className={styles.paletteFieldLabel}>墙</span>
                                    {colorField(typeKey, def, 'wallColor', swatch.wall)}
                                    <span className={styles.paletteFieldLabel}>顶</span>
                                    {colorField(typeKey, def, 'roofColor', swatch.roof)}
                                </>
                            ) : (
                                <span className={styles.paletteFieldLabel}>
                                    色板里没有配色组「{def.paletteKey}」，无法配色
                                </span>
                            )}

                            <button
                                type="button"
                                className={styles.miniButton}
                                disabled={!def.wallColor && !def.roofColor}
                                title="清掉这个类型的墙色与顶色，回到色板配色"
                                onClick={() =>
                                    patchType(typeKey, { wallColor: null, roofColor: null })
                                }
                            >
                                跟随色板
                            </button>
                        </div>
                    );
                })}
            </div>

            <p className={styles.tableHint}>
                改这里等于改 data/dictionaries/building-types.json：同类型的楼一次全变，
                与「按栋覆盖」无关。虚线色块 = 未配置、跟随色板；色值统一按 #rrggbb 写入。
            </p>
        </section>
    );
}
