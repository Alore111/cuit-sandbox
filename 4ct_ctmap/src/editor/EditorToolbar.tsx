/* ================================================================
   编辑工具条
   —— 【口径】照着 ArcMap 的编辑工具条组织：先是「你要干什么」（工具模式），
      再是「视图怎么摆」，最后才是「文件怎么办」。
      工具模式是显式切换的，配套的修饰键（Shift 加选、空格/Alt 临时平移）作为增强，
      因此既能按 ArcMap 的习惯用，也能不改模式直接拖画布。
================================================================ */

import type { School } from '../contract';
import type { DirtyFlags } from '../services/editorService';
import type { ToolMode } from './editorTypes';
import { TOOL_LABELS, TOOL_ORDER } from './editorTypes';
import styles from './editor.module.css';

export interface EditorToolbarProps {
    school: School;
    tool: ToolMode;
    onToolChange: (tool: ToolMode) => void;
    dirty: DirtyFlags;
    saving: boolean;
    canUndo: boolean;
    canRedo: boolean;
    tableOpen: boolean;
    paletteOpen: boolean;
    configOpen: boolean;
    placeOpen: boolean;
    sketching: boolean;
    onNewBuilding: () => void;
    onNewParcel: () => void;
    onUndo: () => void;
    onRedo: () => void;
    onFitAll: () => void;
    onFitSelection: () => void;
    onZoomIn: () => void;
    onZoomOut: () => void;
    onToggleTable: () => void;
    onTogglePalette: () => void;
    onToggleConfig: () => void;
    onTogglePlace: () => void;
    onDiscard: () => void;
    onSave: () => void;
    /** 退出编辑登录：清除会话级管理员密钥 */
    onLogout: () => void;
}

/** 工具栏按钮：统一 current 态与禁用态的表现 */
function ToolbarButton(props: {
    label: string;
    title?: string;
    active?: boolean;
    disabled?: boolean;
    onClick: () => void;
}) {
    const { label, title, active, disabled, onClick } = props;
    const className = active ? `${styles.button} ${styles.buttonActive}` : styles.button;

    return (
        <button
            type="button"
            className={className}
            title={title}
            disabled={disabled}
            onClick={onClick}
        >
            {label}
        </button>
    );
}

export function EditorToolbar(props: EditorToolbarProps) {
    const {
        school,
        tool,
        onToolChange,
        dirty,
        saving,
        canUndo,
        canRedo,
        tableOpen,
        paletteOpen,
        configOpen,
        placeOpen,
        sketching,
        onNewBuilding,
        onNewParcel,
        onUndo,
        onRedo,
        onFitAll,
        onFitSelection,
        onZoomIn,
        onZoomOut,
        onToggleTable,
        onTogglePalette,
        onToggleConfig,
        onTogglePlace,
        onDiscard,
        onSave,
        onLogout
    } = props;

    const somethingDirty = dirty.buildings || dirty.parcels || dirty.island || dirty.buildingTypes;

    return (
        <header className={styles.toolbar}>
            <div className={styles.toolRow}>
                <div className={styles.toolTitle}>
                    <span className={styles.brandMark}>{school.brandMark}</span>
                    <span>
                        {school.name}
                        {school.campusName} · 数据编辑器
                    </span>
                </div>

                <div className={styles.toolGroup}>
                    <ToolbarButton
                        label="新建建筑"
                        title="切到「新建要素」工具，在画布上逐点点击画出轮廓"
                        onClick={onNewBuilding}
                    />
                    <ToolbarButton
                        label="新建地皮"
                        title="切到「新建要素」工具，在画布上逐点点击画出轮廓"
                        onClick={onNewParcel}
                    />
                    <ToolbarButton
                        label="放弃改动"
                        title="丢弃内存里的所有改动，重新从后端读取"
                        disabled={!somethingDirty || saving}
                        onClick={onDiscard}
                    />
                    <ToolbarButton
                        label={saving ? '保存中…' : '保存到后端'}
                        title="整份覆盖写回；后端先校验后写盘，写前备份 .bak"
                        disabled={!somethingDirty || saving}
                        onClick={onSave}
                    />
                    <a className={styles.link} href="/">
                        返回沙盘
                    </a>
                    <ToolbarButton
                        label="退出登录"
                        title="清除会话内的管理员密钥，下次写操作需重新录入"
                        onClick={onLogout}
                    />
                </div>
            </div>

            <div className={`${styles.toolRow} ${styles.toolRowSub}`}>
                <div className={styles.toolGroup}>
                    <span className={styles.groupLabel}>工具</span>
                    {TOOL_ORDER.map((mode) => (
                        <ToolbarButton
                            key={mode}
                            label={TOOL_LABELS[mode]}
                            active={tool === mode}
                            /* 画到一半不许换工具，否则草图的落点语义就断了 */
                            disabled={sketching && mode !== 'create' && mode !== 'pan'}
                            onClick={() => onToolChange(mode)}
                        />
                    ))}
                </div>

                <div className={styles.toolGroup}>
                    <span className={styles.groupLabel}>视图</span>
                    <ToolbarButton label="缩放至全图" onClick={onFitAll} />
                    <ToolbarButton label="缩放至选中" onClick={onFitSelection} />
                    <ToolbarButton label="＋" title="放大" onClick={onZoomIn} />
                    <ToolbarButton label="－" title="缩小" onClick={onZoomOut} />
                </div>

                <div className={styles.toolGroup}>
                    <span className={styles.groupLabel}>编辑</span>
                    <ToolbarButton
                        label="撤销"
                        title="Ctrl + Z"
                        disabled={!canUndo}
                        onClick={onUndo}
                    />
                    <ToolbarButton
                        label="重做"
                        title="Ctrl + Y / Ctrl + Shift + Z"
                        disabled={!canRedo}
                        onClick={onRedo}
                    />
                </div>

                <div className={styles.toolGroup}>
                    <ToolbarButton
                        label="属性表"
                        active={tableOpen}
                        onClick={onToggleTable}
                    />
                    <ToolbarButton
                        label="类型配色"
                        title="按建筑类型调墙面与屋顶的主色调；改的是类型字典，同类型的楼一起变"
                        active={paletteOpen}
                        onClick={onTogglePalette}
                    />
                    <ToolbarButton
                        label="校园事件接口"
                        title="配置校园事件的数据来源：第三方接口 URL、请求头 Token 鉴权、字段映射与测试"
                        active={configOpen}
                        onClick={onToggleConfig}
                    />
                    <ToolbarButton
                        label="地理位置匹配"
                        title="编辑地点词典：决定无经纬度的事件如何由真实地理文字 geoText 匹配到坐标与地点"
                        active={placeOpen}
                        onClick={onTogglePlace}
                    />
                </div>
            </div>
        </header>
    );
}
