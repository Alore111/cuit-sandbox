/* ================================================================
   编辑器页面
   —— 独立页面（/editor），与沙盘共用同一个前端包，但不共用 3D 场景：
      这里只有 2D 编辑画布、图层树、属性面板、属性表与状态栏。

   【为什么单独一个页面而不是沙盘上的一个模式】
   编辑需要「精确的俯视坐标」与「整份数据覆盖写回」，两者都与 3D 沙盘的
   读多写少、只重着色不重建的取向相反。分开之后，沙盘侧完全不用为编辑让步。

   保存口径（二期不变）：整份覆盖 + 后端先校验后写盘 + 写前备份 .bak。
   本期新增的两件东西：
   1) 撤销栈（Ctrl+Z / Ctrl+Y）：快照存**内存文档**，不碰磁盘；
   2) 岛面轮廓（school.json）也进入可编辑范围，因此保存时会分别写三份文件。
   另：建筑类型字典（各类型的墙面/屋顶主色）也是可编辑对象，保存时最多写四份文件。

   「脏标记」不用谁去手动打点：所有编辑都经由 withOutline / patchXxx 生成
   **新对象**，因此 document 与 baseline 的逐文件引用比较就是准确答案 ——
   撤销回原样时脏标记会自动消失。
================================================================ */

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { LonLat } from '../contract';
import type { Dictionaries } from '../contract';
import {
    CLEAN_FLAGS,
    loadEditorSource,
    saveEditorDocument,
    type DirtyFlags,
    type EditorDocument,
    type EditorSource
} from '../services/editorService';
import { useUiStore } from '../store/uiStore';
import { useBaseMapImage, basemap } from './baseMap';
import { EditorCanvas, type EditorCanvasHandle, type EditEvent } from './EditorCanvas';
import { EditorToolbar } from './EditorToolbar';
import { LayerTree } from './LayerTree';
import { AttributeTable } from './AttributeTable';
import { PropertyPanel } from './PropertyPanel';
import { StatusBar } from './StatusBar';
import { TypePalettePanel } from './TypePalettePanel';
import { EventApiConfigEditor } from '../ui/components/EventApiConfigEditor';
import { PlaceMatchEditor } from './PlaceMatchEditor';
import { clearAdminKey, getAdminKey, setAdminKey } from '../auth/adminKey';
import { mapApi } from '../api/mapApi';
import { useEditorHistory } from './history';
import { createProjection, projectionOrigin, type EditorProjection } from './projection';
import {
    createBuildingEntry,
    createParcelEntry,
    mergeTargets,
    nextId,
    outlineOf,
    takenIds
} from './editorModel';
import {
    DEFAULT_LAYER_VISIBILITY,
    targetKey,
    type EditorTarget,
    type LayerVisibility,
    type SketchState,
    type ToolMode
} from './editorTypes';
import styles from './editor.module.css';

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** 编辑页登录门禁：录入管理员密钥并向后端校验后放行 */
function AdminKeyGate({
    verifying,
    error,
    onSubmit
}: {
    verifying: boolean;
    error: string | null;
    onSubmit: (key: string) => void;
}) {
    const [value, setValue] = useState('');
    return (
        <div className={styles.overlay}>
            <form
                className={styles.authCard}
                onSubmit={(event) => {
                    event.preventDefault();
                    onSubmit(value);
                }}
            >
                <h2 className={styles.authTitle}>编辑登录</h2>
                <p className={styles.authDesc}>
                    编辑地图与校园事件配置需要管理员密钥。密钥由后端校验，仅会话内有效。
                </p>
                <input
                    className={styles.authInput}
                    type="password"
                    autoFocus
                    disabled={verifying}
                    placeholder="请输入管理员密钥"
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                />
                {error ? <div className={styles.authError}>{error}</div> : null}
                <div className={styles.authActions}>
                    <button type="submit" className={styles.button} disabled={!value.trim() || verifying}>
                        {verifying ? '校验中…' : '进入编辑'}
                    </button>
                    <a className={styles.link} href="/">
                        返回沙盘
                    </a>
                </div>
            </form>
        </div>
    );
}

export function EditorApp() {
    const theme = useUiStore((state) => state.theme);
    const basemapImage = useBaseMapImage(basemap);

    const [document, setDocument] = useState<EditorDocument | null>(null);
    /** 后端读回来的那一份：脏标记与「放弃改动」都以它为准 */
    const [baseline, setBaseline] = useState<EditorDocument | null>(null);
    const [dictionaries, setDictionaries] = useState<Dictionaries | null>(null);
    const [versions, setVersions] = useState<EditorSource['versions'] | null>(null);
    /** 投影原点：读取数据时快照一次，编辑岛面轮廓期间不跟着漂 */
    const [origin, setOrigin] = useState<LonLat | null>(null);

    const [tool, setTool] = useState<ToolMode>('select');
    const [snapping, setSnapping] = useState(true);
    const [visibility, setVisibility] = useState<LayerVisibility>(DEFAULT_LAYER_VISIBILITY);
    const [selection, setSelection] = useState<EditorTarget[]>([]);
    const [activeTarget, setActiveTarget] = useState<EditorTarget | null>(null);
    const [sketch, setSketch] = useState<SketchState | null>(null);
    const [tableOpen, setTableOpen] = useState(false);
    /** 右侧工具栏同一时刻只开一个：四个面板互斥，任一生效即出现右栏 */
    const [paletteOpen, setPaletteOpen] = useState(false);
    /** 校园事件接口配置抽屉（与属性表/类型配色互斥） */
    const [configOpen, setConfigOpen] = useState(false);
    /** 地理位置匹配（地点词典）抽屉（与属性表/类型配色/事件接口互斥） */
    const [placeOpen, setPlaceOpen] = useState(false);
    /** 右侧工具栏宽度（px）：可拖拽分割条调整，跨会话记忆 */
    const [dockWidth, setDockWidth] = useState(480);
    /** 「从地图选取坐标」：true = 画布切入十字准星拾取模式 */
    const [picking, setPicking] = useState(false);
    /** 画布回传的坐标信号：每次完成一次拾取就生成新对象，地点拾取按此回填 */
    const [pickSignal, setPickSignal] = useState<{ lonlat: LonLat } | null>(null);

    /* 编辑页鉴权：会话级管理员密钥（sessionStorage）。
     * authed 初始一律为 false，进入后若已有密钥则自动向后端校验一次，通过才放行。 */
    const [authed, setAuthed] = useState(false);

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    const history = useEditorHistory<EditorDocument>();
    const canvasRef = useRef<EditorCanvasHandle>(null);
    /** 实时同步的最新右栏宽度：拖拽分割条时要读它（避免闭包里的旧值） */
    const dockWidthRef = useRef(dockWidth);
    useEffect(() => {
        dockWidthRef.current = dockWidth;
    }, [dockWidth]);

    const projection: EditorProjection | null = useMemo(
        () => (origin ? createProjection(origin) : null),
        [origin]
    );

    /* ---------------- 读取 ---------------- */

    const load = useCallback(
        async (silent = false): Promise<void> => {
            if (!silent) setLoading(true);
            try {
                const next = await loadEditorSource();
                setDocument(next.document);
                setBaseline(next.document);
                setDictionaries(next.dictionaries);
                setVersions(next.versions);
                setOrigin(projectionOrigin(next.document.school.island.outline));
                setSelection([]);
                setActiveTarget(null);
                setSketch(null);
                history.clear();
                setError(null);
            } catch (loadError) {
                setError(messageOf(loadError));
            } finally {
                if (!silent) setLoading(false);
            }
        },
        [history.clear]
    );

    useEffect(() => {
        void load();
    }, [load]);

    /* ---------------- 改数据 ---------------- */

    /**
     * 所有编辑的唯一入口。
     * `before` 非空即记一次撤销栈；拖动中途传 null，抬手时再补记一次。
     */
    const applyEdit = useCallback(
        (event: EditEvent): void => {
            setDocument(event.next);
            if (event.before) history.record(event.before);

            /* 删掉对象后，指向它的选择与当前编辑对象要一起失效，否则面板会指向空气 */
            const exists = (target: EditorTarget): boolean => outlineOf(event.next, target) !== null;
            setSelection((current) => {
                const kept = current.filter(exists);
                return kept.length === current.length ? current : kept;
            });
            setActiveTarget((current) => (current && exists(current) ? current : null));
        },
        [history.record]
    );

    /** 撤销 / 重做后同样要清理悬空的选择 */
    const syncAfterHistory = useCallback((next: EditorDocument): void => {
        setDocument(next);
        const exists = (target: EditorTarget): boolean => outlineOf(next, target) !== null;
        setSelection((current) => {
            const kept = current.filter(exists);
            return kept.length === current.length ? current : kept;
        });
        setActiveTarget((current) => (current && exists(current) ? current : null));
    }, []);

    const undo = useCallback((): void => {
        if (!document) return;
        const restored = history.undo(document);
        if (restored) {
            syncAfterHistory(restored);
            setNotice('已撤销一步');
        }
    }, [document, history, syncAfterHistory]);

    const redo = useCallback((): void => {
        if (!document) return;
        const restored = history.redo(document);
        if (restored) {
            syncAfterHistory(restored);
            setNotice('已重做一步');
        }
    }, [document, history, syncAfterHistory]);

    /* ---------------- 新建要素（草图） ---------------- */

    const startSketch = useCallback(
        (kind: 'building' | 'parcel'): void => {
            if (!document) return;

            const id = nextId(
                kind === 'building' ? 'manual-building' : 'manual-parcel',
                takenIds(document, kind)
            );
            setSketch({ kind, id, outline: [] });
            setTool('create');
            setNotice(
                `新建${kind === 'building' ? '建筑' : '地皮'}：在画布上逐点点击落下顶点，` +
                    '双击 / F2 / Enter 完成，Backspace 退一点，Esc 取消'
            );
        },
        [document]
    );

    const finishSketch = useCallback(
        (finished: SketchState): void => {
            if (!document) return;

            const next: EditorDocument =
                finished.kind === 'building'
                    ? {
                          ...document,
                          buildings: [
                              ...document.buildings,
                              createBuildingEntry(finished.id, finished.outline)
                          ]
                      }
                    : {
                          ...document,
                          parcels: [
                              ...document.parcels,
                              createParcelEntry(
                                  finished.id,
                                  finished.outline,
                                  document.school.defaultTerrainTypeKey
                              )
                          ]
                      };

            applyEdit({ next, before: document });

            const target: EditorTarget = { kind: finished.kind, id: finished.id };
            setSelection([target]);
            setActiveTarget(target);
            setSketch(null);
            setTool('select');
            setNotice(
                `已新增${finished.kind === 'building' ? '建筑' : '地皮'} ${finished.id}` +
                    `（${finished.outline.length} 点，尚未保存）`
            );
        },
        [document, applyEdit]
    );

    /* ---------------- 保存 / 放弃 ---------------- */

    const dirty: DirtyFlags = useMemo(() => {
        if (!document || !baseline) return CLEAN_FLAGS;
        return {
            buildings: document.buildings !== baseline.buildings,
            parcels: document.parcels !== baseline.parcels,
            island: document.school !== baseline.school,
            buildingTypes: document.buildingTypes !== baseline.buildingTypes
        };
    }, [document, baseline]);

    const somethingDirty =
        dirty.buildings || dirty.parcels || dirty.island || dirty.buildingTypes;

    /** 右侧工具栏显示条件：四个工具面板互斥，任一打开即出现右栏 */
    const dockOpen = tableOpen || paletteOpen || configOpen || placeOpen;

    const save = useCallback(async (): Promise<void> => {
        if (!document || !versions || !somethingDirty) return;

        setSaving(true);
        setNotice(null);
        try {
            const result = await saveEditorDocument({ document, versions, dirty });
            /* 静默重读：保存后磁盘就是真源，把 baseline 对齐到它（不闪加载遮罩） */
            await load(true);
            setNotice(`已保存：${result.parts.join('，')}（原文件已备份为 .bak）`);
        } catch (saveError) {
            setError(messageOf(saveError));
        } finally {
            setSaving(false);
        }
    }, [document, versions, somethingDirty, dirty, load]);

    const discard = useCallback(async (): Promise<void> => {
        setNotice(null);
        await load();
        setNotice('已放弃未保存的改动，重新从后端读取');
    }, [load]);

    /* ---------------- 编辑页鉴权 ---------------- */

    const [verifying, setVerifying] = useState(false);

    /**
     * 向后端校验管理员密钥（/api/map/auth-check）。key 为空则用会话已存的密钥。
     * 通过返回 true 并放行；失败清理密钥、回到门禁，返回 false。
     */
    const attemptAuth = useCallback(async (key: string): Promise<boolean> => {
        const k = key.trim() || getAdminKey();
        if (!k) {
            setError('请输入管理员密钥');
            setAuthed(false);
            return false;
        }
        /* 先存入会话，使 request() 自动附带 X-Admin-Key，再向后端验证 */
        setAdminKey(k);
        setError(null);
        setVerifying(true);
        try {
            await mapApi.checkAdminAuth();
            setAuthed(true);
            setNotice('已通过管理员密钥校验');
            return true;
        } catch {
            // 密钥错误或后端不可用：不进门禁
            setError('管理员密钥校验失败：密钥错误或后端不可用');
            clearAdminKey();
            setAuthed(false);
            return false;
        } finally {
            setVerifying(false);
        }
    }, []);

    /* 进入 /editor 时：若会话已存有密钥，自动向后端校验一次，避免带旧/错密钥直接放行 */
    useEffect(() => {
        const saved = getAdminKey();
        if (saved) void attemptAuth(saved);
    }, [attemptAuth]);

    /* 关闭地点词典面板时同步退出「从地图选坐标」，避免拾取模式残留 */
    useEffect(() => {
        if (!placeOpen) setPicking(false);
    }, [placeOpen]);

    /** 登录门禁提交：录入密钥后向后端校验 */
    const submitAuth = useCallback(
        (key: string): void => {
            void attemptAuth(key);
        },
        [attemptAuth]
    );

    /** 退出登录：清除会话密钥回到门禁 */
    const logout = useCallback((): void => {
        clearAdminKey();
        setAuthed(false);
        setNotice('已退出编辑登录');
    }, []);

    /* ---------------- 选择与视图 ---------------- */

    const selectFromTable = useCallback((targets: EditorTarget[], additive: boolean): void => {
        setSelection((current) => (additive ? mergeTargets(current, targets) : targets));
    }, []);

    const zoomTo = useCallback((target: EditorTarget): void => {
        canvasRef.current?.fitTargets([target]);
    }, []);

    const zoomToLayer = useCallback(
        (kind: EditorTarget['kind']): void => {
            if (!document) return;

            const targets: EditorTarget[] =
                kind === 'island'
                    ? [{ kind: 'island' }]
                    : kind === 'building'
                      ? document.buildings.map((entry) => ({ kind: 'building' as const, id: entry.id }))
                      : document.parcels.map((entry) => ({ kind: 'parcel' as const, id: entry.id }));

            canvasRef.current?.fitTargets(targets);
        },
        [document]
    );

    /* ---------------- 右侧工具栏：宽度可拖 --------------- */

    /** 拖拽分割条改右栏宽度。手势开始记起始宽度与光标横坐标，拖动按差值换算。 */
    const onSplitterDown = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = dockWidthRef.current;

        const onMove = (move: PointerEvent): void => {
            /* 分割条在画布/属性面板右侧：向左拖（区分割条越远）右栏越宽 */
            const next = startWidth + (startX - move.clientX);
            const max = Math.max(320, window.innerWidth * 0.6);
            setDockWidth(Math.min(Math.max(300, next), max));
        };
        const onUp = (): void => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    }, []);

    /** 双击分割条：恢复默认宽度，避免一次拖过头回不来的尴尬 */
    const onSplitterDoubleClick = useCallback((): void => {
        setDockWidth(480);
    }, []);

    /* ---------------- 快捷键（与画布无关的那几个） ---------------- */

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if (!event.ctrlKey && !event.metaKey) return;

            /* 输入框里打字不抢快捷键：Ctrl+Z 该撤销的是输入，不是地图编辑 */
            const target = event.target as HTMLElement | null;
            if (
                target &&
                (target.tagName === 'INPUT' ||
                    target.tagName === 'SELECT' ||
                    target.tagName === 'TEXTAREA')
            ) {
                return;
            }

            const key = event.key.toLowerCase();
            if (key === 'z') {
                event.preventDefault();
                if (event.shiftKey) redo();
                else undo();
                return;
            }
            if (key === 'y') {
                event.preventDefault();
                redo();
                return;
            }
            if (key === 's') {
                event.preventDefault();
                void save();
            }
        };

        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [redo, save, undo]);

    /* ---------------- 渲染 ---------------- */

    if (!authed) {
        return <AdminKeyGate verifying={verifying} error={error} onSubmit={(k) => void submitAuth(k)} />;
    }

    if (loading) {
        return <div className={styles.overlay}>正在读取数据…</div>;
    }

    if (!document || !projection || !dictionaries || !versions) {
        return <div className={styles.overlay}>读取失败：{error ?? '数据不完整'}</div>;
    }

    return (
        <div className={styles.root}>
            <EditorToolbar
                school={document.school}
                tool={tool}
                onToolChange={setTool}
                dirty={dirty}
                saving={saving}
                canUndo={history.canUndo}
                canRedo={history.canRedo}
                tableOpen={tableOpen}
                paletteOpen={paletteOpen}
                configOpen={configOpen}
                placeOpen={placeOpen}
                sketching={sketch !== null}
                onNewBuilding={() => startSketch('building')}
                onNewParcel={() => startSketch('parcel')}
                onUndo={undo}
                onRedo={redo}
                onFitAll={() => canvasRef.current?.fitAll()}
                onFitSelection={() => canvasRef.current?.fitTargets()}
                onZoomIn={() => canvasRef.current?.zoomIn()}
                onZoomOut={() => canvasRef.current?.zoomOut()}
                onToggleTable={() => {
                    setTableOpen(!tableOpen);
                    if (!tableOpen) {
                        setPaletteOpen(false);
                        setConfigOpen(false);
                        setPlaceOpen(false);
                    }
                }}
                onTogglePalette={() => {
                    setPaletteOpen(!paletteOpen);
                    if (!paletteOpen) {
                        setTableOpen(false);
                        setConfigOpen(false);
                        setPlaceOpen(false);
                    }
                }}
                onToggleConfig={() => {
                    setConfigOpen(!configOpen);
                    if (!configOpen) {
                        setTableOpen(false);
                        setPaletteOpen(false);
                        setPlaceOpen(false);
                    }
                }}
                onTogglePlace={() => {
                    setPlaceOpen(!placeOpen);
                    if (!placeOpen) {
                        setTableOpen(false);
                        setPaletteOpen(false);
                        setConfigOpen(false);
                    }
                }}
                onDiscard={() => void discard()}
                onSave={() => void save()}
                onLogout={logout}
            />

            {error ? <div className={styles.errorBar}>{error}</div> : null}
            {notice ? <div className={styles.noticeBar}>{notice}</div> : null}

            <div className={styles.body}>
                <LayerTree
                    document={document}
                    visibility={visibility}
                    onVisibilityChange={setVisibility}
                    islandSelected={selection.some((item) => targetKey(item) === 'island')}
                    basemap={{
                        meta: basemap,
                        ready: basemapImage.image !== null,
                        error: basemapImage.error
                    }}
                    onSelectIsland={() => {
                        const target: EditorTarget = { kind: 'island' };
                        setSelection([target]);
                        setActiveTarget(target);
                        setTool('vertex');
                    }}
                    onZoomToLayer={zoomToLayer}
                />

                <EditorCanvas
                    ref={canvasRef}
                    document={document}
                    projection={projection}
                    theme={theme}
                    tool={tool}
                    snapping={snapping}
                    visibility={visibility}
                    basemap={{ image: basemapImage.image, meta: basemap }}
                    selection={selection}
                    activeTarget={activeTarget}
                    sketch={sketch}
                    picking={picking}
                    onPickCoordinate={(lonlat) => {
                        setPicking(false);
                        setPickSignal({ lonlat });
                    }}
                    onPickCancel={() => setPicking(false)}
                    onEdit={applyEdit}
                    onSelectionChange={setSelection}
                    onActiveTargetChange={setActiveTarget}
                    onSketchChange={setSketch}
                    onSketchFinish={finishSketch}
                    onToolChange={setTool}
                />

                <PropertyPanel
                    document={document}
                    dictionaries={dictionaries}
                    selection={selection}
                    activeTarget={activeTarget}
                    onEdit={applyEdit}
                    onZoomTo={zoomTo}
                />

                {/* 右侧工具栏：与属性面板并列，宽度可拖拽分割条调节 */}
                {dockOpen && (
                    <>
                        <div
                            className={styles.splitter}
                            role="separator"
                            aria-orientation="vertical"
                            title="拖动调整工具栏宽度 · 双击恢复默认"
                            onPointerDown={onSplitterDown}
                            onDoubleClick={onSplitterDoubleClick}
                        />
                        <div className={styles.rightDock} style={{ width: dockWidth }}>
                            {tableOpen ? (
                                <AttributeTable
                                    open
                                    document={document}
                                    dictionaries={dictionaries}
                                    selection={selection}
                                    activeTarget={activeTarget}
                                    onClose={() => setTableOpen(false)}
                                    onSelect={selectFromTable}
                                    onSetActive={setActiveTarget}
                                    onZoomTo={zoomTo}
                                    onEdit={applyEdit}
                                />
                            ) : null}

                            {paletteOpen ? (
                                <TypePalettePanel
                                    open
                                    document={document}
                                    theme={theme}
                                    onClose={() => setPaletteOpen(false)}
                                    onEdit={applyEdit}
                                />
                            ) : null}

                            {configOpen ? (
                                <section className={styles.configPanel} aria-label="校园事件接口配置">
                                    <header className={styles.configPanelHead}>
                                        <span className={styles.configPanelTitle}>
                                            校园事件 · 数据源配置
                                        </span>
                                        <button
                                            type="button"
                                            className={styles.configPanelClose}
                                            aria-label="关闭事件接口配置"
                                            onClick={() => setConfigOpen(false)}
                                        >
                                            关闭
                                        </button>
                                    </header>
                                    <div className={styles.configPanelBody}>
                                        <EventApiConfigEditor />
                                    </div>
                                </section>
                            ) : null}

                            {placeOpen ? (
                                <section className={styles.configPanel} aria-label="地理位置匹配配置">
                                    <header className={styles.configPanelHead}>
                                        <span className={styles.configPanelTitle}>
                                            地理位置匹配 · 地点词典
                                        </span>
                                        <button
                                            type="button"
                                            className={styles.configPanelClose}
                                            aria-label="关闭地理位置匹配配置"
                                            onClick={() => setPlaceOpen(false)}
                                        >
                                            关闭
                                        </button>
                                    </header>
                                    <div className={styles.configPanelBody}>
                                        <PlaceMatchEditor
                                            picking={picking}
                                            picked={pickSignal}
                                            onRequestPick={() => {
                                                /* 重新发起拾取：清掉上一次的回传信号，
                                                   避免旧信号再次触发回填 */
                                                setPickSignal(null);
                                                setPicking(true);
                                            }}
                                            onCancelPick={() => setPicking(false)}
                                        />
                                    </div>
                                </section>
                            ) : null}
                        </div>
                    </>
                )}
            </div>

            <StatusBar
                document={document}
                selection={selection}
                tool={tool}
                snapping={snapping}
                onToggleSnapping={() => setSnapping((value) => !value)}
                dirty={somethingDirty}
                saving={saving}
                past={history.past}
                future={history.future}
            />
        </div>
    );
}
