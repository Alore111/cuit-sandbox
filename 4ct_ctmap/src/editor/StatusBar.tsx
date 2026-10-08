/* ================================================================
   状态栏
   —— ArcMap 的底部状态条：左边是「你现在选中了什么、多大」，
      右边是「捕捉开不开、撤销栈有多深、有没有没保存的改动」。
      这里只放**低频**变化的读数；光标坐标那种逐帧变化的东西在画布内，
      免得鼠标一动就整页重渲染。
================================================================ */

import { polygonAreaM2 } from '../contract';
import type { EditorDocument } from '../services/editorService';
import { polygonPerimeterMeters } from './editorModel';
import { TARGET_KIND_LABELS } from './editorTypes';
import type { EditorTarget, ToolMode } from './editorTypes';
import { TOOL_HINTS, TOOL_LABELS } from './editorTypes';
import styles from './editor.module.css';

export interface StatusBarProps {
    document: EditorDocument;
    selection: readonly EditorTarget[];
    tool: ToolMode;
    snapping: boolean;
    onToggleSnapping: () => void;
    dirty: boolean;
    saving: boolean;
    past: number;
    future: number;
}

export function StatusBar(props: StatusBarProps) {
    const { document, selection, tool, snapping, onToggleSnapping, dirty, saving, past, future } =
        props;

    let areaSum = 0;
    let perimeterSum = 0;
    const kinds = new Set<string>();

    for (const target of selection) {
        const outline =
            target.kind === 'island'
                ? document.school.island.outline
                : target.kind === 'building'
                  ? document.buildings.find((entry) => entry.id === target.id)?.outline
                  : document.parcels.find((entry) => entry.id === target.id)?.outline;

        if (!outline) continue;
        areaSum += polygonAreaM2(outline);
        perimeterSum += polygonPerimeterMeters(outline);
        kinds.add(TARGET_KIND_LABELS[target.kind]);
    }

    return (
        <footer className={styles.statusBar}>
            <span className={styles.statusItem}>
                <strong>{TOOL_LABELS[tool]}</strong>
                <span className={styles.statusHint}>{TOOL_HINTS[tool]}</span>
            </span>

            <span className={styles.statusItem}>
                {selection.length === 0
                    ? '未选中对象'
                    : `选中 ${selection.length} 项（${[...kinds].join(' / ')}）· 合计面积 ${areaSum.toFixed(
                          1
                      )} m² · 合计周长 ${perimeterSum.toFixed(1)} m`}
            </span>

            <span className={styles.statusRight}>
                <button
                    type="button"
                    className={snapping ? styles.statusToggleOn : styles.statusToggle}
                    onClick={onToggleSnapping}
                    title="捕捉：吸附到其他对象的顶点与线段（顶点优先）"
                >
                    捕捉 {snapping ? '开' : '关'}
                </button>
                <span className={styles.statusItem} title="撤销 / 重做（Ctrl+Z / Ctrl+Y）">
                    撤销栈 {past} · 重做栈 {future}
                </span>
                <span className={dirty ? styles.statusDirty : styles.statusItem}>
                    {saving ? '保存中…' : dirty ? '有未保存的改动' : '与后端一致'}
                </span>
            </span>
        </footer>
    );
}
