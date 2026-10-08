/* ================================================================
   事件接口配置编辑面板 EventApiConfigEditor
   —— 功能：
      1. 编辑基础信息 + 列表/详情接口端点
      2. 编辑请求头（增删 + 启用开关）
      3. 字段映射：按统一事件字段一行，填源字段名（dot 路径），留空 = 默认同名字段
      4. "测试请求"按钮：发送真实请求 → 展示 HTTP 状态、耗时、映射问题清单、
         前 5 条事件预览卡（含 jumpUrl 字段）
      5. 保存（优先后端 JSON，失败写 localStorage）、导入/导出 JSON、重置默认
   ================================================================ */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type {
    EventApiConfig,
    EventApiHeader,
    EventFieldMapping,
    UnifiedCampusEvent,
} from '../../contract';
import { EVENT_FIELD_DEFAULTS } from '../../contract/campusLive';
import {
    createDefaultEventConfig,
    exportEventConfigJson,
    importEventConfigJson,
    loadEventConfigDual,
    saveEventConfigDual,
} from '../../api/eventConfigApi';
import {
    testRequestList,
    type TestRequestResult,
} from '../../services/unifiedEventService';
import { invalidateConfigCache } from '../../services/campusLiveService';
import styles from '../styles/eventApiConfig.module.css';

/** 字段元信息：给编辑页面展示字段类型（用于 placeholder 提示） */
interface FieldMeta {
    key: keyof UnifiedCampusEvent;
    /** 展示用中文名 */
    label: string;
    /** 字段类型：用于 placeholder 提示用户应该填什么格式 */
    type: 'string' | 'number' | 'datetime_unix_or_iso' | 'lonlat' | 'string_array' | 'enum';
    /** 是否必填；缺省值已在映射层提供，这里仅用于加粗显示 */
    required?: boolean;
    /** 推荐枚举值（enum 类型 placeholder） */
    enumHint?: string;
}

const FIELD_METAS: FieldMeta[] = [
    { key: 'id', label: '事件唯一ID', type: 'string', required: true },
    { key: 'title', label: '标题', type: 'string', required: true },
    { key: 'description', label: '简述', type: 'string' },
    { key: 'category', label: '分类枚举', type: 'enum', enumHint: 'lecture|competition|sports|...|other' },
    { key: 'severity', label: '紧急度枚举', type: 'enum', enumHint: 'info|warning|urgent|special' },
    { key: 'status', label: '状态枚举', type: 'enum', enumHint: 'upcoming|ongoing|ended|cancelled' },
    { key: 'locationId', label: '地点/建筑ID', type: 'string' },
    { key: 'locationName', label: '地点名称', type: 'string' },
    { key: 'position', label: '经纬度 [lat, lng]', type: 'lonlat' },
    { key: 'startTime', label: '开始时间', type: 'datetime_unix_or_iso' },
    { key: 'endTime', label: '结束时间', type: 'datetime_unix_or_iso' },
    { key: 'organizer', label: '主办单位', type: 'string' },
    { key: 'participantCount', label: '参与人数', type: 'number' },
    { key: 'coverImageUrl', label: '封面图URL', type: 'string' },
    { key: 'tags', label: '标签数组', type: 'string_array' },
    { key: 'limitNumber', label: '可报名上限', type: 'number' },
    { key: 'registeredCount', label: '已报名人数', type: 'number' },
    { key: 'score', label: '学分', type: 'string' },
    { key: 'activityLevelText', label: '活动级别文本', type: 'string' },
    { key: 'jumpUrl', label: '★ 跳转原页面URL', type: 'string' },
    { key: 'createdAt', label: '发布时间戳', type: 'datetime_unix_or_iso' },
    { key: 'updatedAt', label: '更新时间戳', type: 'datetime_unix_or_iso' },
];

type SaveState =
    | { kind: 'idle' }
    | { kind: 'saving' }
    | { kind: 'ok'; msg: string }
    | { kind: 'warn'; msg: string }
    | { kind: 'err'; msg: string };

const emptyHeader = (): EventApiHeader => ({ key: '', value: '', enabled: true });

function cloneConfig(cfg: EventApiConfig): EventApiConfig {
    return JSON.parse(JSON.stringify(cfg));
}

export function EventApiConfigEditor() {
    const [config, setConfig] = useState<EventApiConfig>(() => createDefaultEventConfig());
    const [loadNote, setLoadNote] = useState<string>('尚未加载');
    const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
    const [testResult, setTestResult] = useState<TestRequestResult | null>(null);
    const [testing, setTesting] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    /* ---------- 初始化：从双通道加载 ---------- */
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const r = await loadEventConfigDual();
            if (cancelled) return;
            if (r.config) setConfig(r.config);
            const src =
                r.source === 'server' ? '已从服务端加载'
                : r.source === 'local' ? '已回退到本地副本'
                : '使用默认空配置';
            setLoadNote(r.error ? `${src}：${r.error}` : src);
        })();
        return () => { cancelled = true; };
    }, []);

    /* ---------- helpers ---------- */
    const update = useCallback(<K extends keyof EventApiConfig>(k: K, v: EventApiConfig[K]) => {
        setConfig((prev) => ({ ...prev, [k]: v }));
    }, []);

    const updateEndpoints = useCallback(<K extends keyof EventApiConfig['endpoints']>(
        k: K,
        v: EventApiConfig['endpoints'][K]
    ) => {
        setConfig((prev) => ({ ...prev, endpoints: { ...prev.endpoints, [k]: v } }));
    }, []);

    /** 更新事件搜索端点配置 */
    const updateSearchEndpoints = useCallback(<K extends keyof NonNullable<EventApiConfig['searchEndpoints']>>(
        k: K,
        v: NonNullable<EventApiConfig['searchEndpoints']>[K]
    ) => {
        setConfig((prev) => ({
            ...prev,
            searchEndpoints: {
                url: '',
                method: 'GET' as const,
                listDataPath: '',
                ...prev.searchEndpoints,
                [k]: v,
            },
        }));
    }, []);

    const updateHeader = useCallback((idx: number, patch: Partial<EventApiHeader>) => {
        setConfig((prev) => {
            const next = prev.headers.slice();
            next[idx] = { ...next[idx], ...patch };
            return { ...prev, headers: next };
        });
    }, []);

    const addHeader = useCallback(() => {
        setConfig((prev) => ({ ...prev, headers: [...prev.headers, emptyHeader()] }));
    }, []);

    const removeHeader = useCallback((idx: number) => {
        setConfig((prev) => ({
            ...prev,
            headers: prev.headers.filter((_, i) => i !== idx),
        }));
    }, []);

    const updateMapping = useCallback((k: keyof EventFieldMapping, src: string) => {
        setConfig((prev) => {
            const cur = { ...prev.fieldMapping };
            if (!src || src === EVENT_FIELD_DEFAULTS[k]) {
                // 与默认同值 → 不存（减少 JSON 噪声，编辑页面仍显示 placeholder 提示）
                delete cur[k];
            } else {
                cur[k] = src;
            }
            return { ...prev, fieldMapping: cur };
        });
    }, []);

    /* ---------- actions ---------- */
    const onTest = useCallback(async () => {
        setTesting(true);
        setTestResult(null);
        try {
            const cfgSnapshot = cloneConfig(config);
            const res = await testRequestList(cfgSnapshot);
            setTestResult(res);
        } finally {
            setTesting(false);
        }
    }, [config]);

    const onSave = useCallback(async () => {
        setSaveState({ kind: 'saving' });
        try {
            const cfgSnapshot = cloneConfig(config);
            const r = await saveEventConfigDual(cfgSnapshot);
            if (!r.saved) {
                setSaveState({ kind: 'err', msg: r.message });
                return;
            }
            if (r.config) setConfig(r.config);
            invalidateConfigCache(); // 下一次 loadSnapshot 时重新读配置
            setSaveState(r.serverSaved
                ? { kind: 'ok', msg: r.message }
                : { kind: 'warn', msg: r.message });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setSaveState({ kind: 'err', msg: `保存失败：${msg}` });
        }
    }, [config]);

    const onReset = useCallback(() => {
        if (!window.confirm('确定要重置为默认配置？当前未保存的修改会丢失。')) return;
        setConfig(createDefaultEventConfig());
        setSaveState({ kind: 'idle' });
    }, []);

    const onExport = useCallback(() => {
        exportEventConfigJson(config);
    }, [config]);

    const onImportClick = useCallback(() => {
        fileInputRef.current?.click();
    }, []);

    const onImportFile = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
        const f = e.target.files?.[0];
        e.target.value = ''; // 重置后下次选同一个文件还能触发 change
        if (!f) return;
        try {
            const next = await importEventConfigJson(f);
            setConfig(next);
            setSaveState({ kind: 'warn', msg: `已导入：${f.name}，请点击「保存配置」同步到服务端。` });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setSaveState({ kind: 'err', msg: `导入失败：${msg}` });
        }
    }, []);

    /* ---------- 派生：字段映射行的当前值 / placeholder ---------- */
    const mappingRows = useMemo(() => {
        return FIELD_METAS.map((meta) => {
            const mapped = (config.fieldMapping as Record<string, string | undefined>)[meta.key] ?? '';
            const def = EVENT_FIELD_DEFAULTS[meta.key];
            return { meta, mapped, def };
        });
    }, [config.fieldMapping]);

    /* ---------- 渲染 ---------- */
    return (
        <div className={styles.configRoot}>
            <header className={styles.configHead}>
                <h3 className={styles.configTitle}>事件数据源 · 接口配置</h3>
                <span className={styles.configBadge}>{loadNote}</span>
            </header>

            <div className={styles.configBody}>
                {/* 基础信息 + 列表/详情端点 */}
                <section className={styles.section}>
                    <h4 className={styles.sectionTitle}>接口端点</h4>
                    <div className={styles.fieldRow}>
                        <label className={styles.fieldLabel} htmlFor="cfg-name">配置名称</label>
                        <input
                            id="cfg-name"
                            className={styles.textInput}
                            type="text"
                            value={config.name ?? ''}
                            placeholder="如：校园 OA 活动接口 / 二课中心 V2"
                            onChange={(e) => update('name', e.target.value)}
                        />
                    </div>

                    <div className={styles.fieldInline}>
                        <label className={styles.fieldLabel}>列表接口 URL</label>
                        <input
                            className={[styles.textInput, styles.mono].join(' ')}
                            type="url"
                            value={config.endpoints.url}
                            placeholder="https://api.example.com/v1/campus/events"
                            onChange={(e) => updateEndpoints('url', e.target.value)}
                        />
                        <select
                            className={styles.select}
                            value={config.endpoints.method}
                            onChange={(e) => updateEndpoints('method', e.target.value as 'GET' | 'POST')}
                        >
                            <option value="GET">GET</option>
                            <option value="POST">POST</option>
                        </select>
                    </div>

                    <div className={styles.fieldInline}>
                        <label className={styles.fieldLabel}>
                            列表数组路径 <span className={styles.fieldHint}>(留空=默认 ApiEnvelope.data)</span>
                        </label>
                        <input
                            className={[styles.textInput, styles.mono].join(' ')}
                            type="text"
                            value={config.endpoints.listDataPath ?? ''}
                            placeholder="例：data.items / result.list / records"
                            onChange={(e) => updateEndpoints('listDataPath', e.target.value)}
                        />
                        <span className={styles.fieldHint}>dot 路径</span>
                    </div>

                    <label className={styles.checkbox}>
                        <input
                            type="checkbox"
                            checked={!!config.endpoints.enableDetailEndpoint}
                            onChange={(e) => updateEndpoints('enableDetailEndpoint', e.target.checked)}
                        />
                        启用独立详情接口（关闭时列表数据即完整详情，不再二次请求）
                    </label>

                    {config.endpoints.enableDetailEndpoint && (
                        <>
                            <div className={styles.fieldInline}>
                                <label className={styles.fieldLabel}>详情 URL 模板</label>
                                <input
                                    className={[styles.textInput, styles.mono].join(' ')}
                                    type="text"
                                    value={config.endpoints.detailUrlTemplate ?? ''}
                                    placeholder="https://api.example.com/v1/campus/events/{id}"
                                    onChange={(e) => updateEndpoints('detailUrlTemplate', e.target.value)}
                                />
                                <span className={styles.fieldHint}>{'{id}'}=事件id</span>
                            </div>
                            <div className={styles.fieldInline}>
                                <label className={styles.fieldLabel}>详情对象路径</label>
                                <input
                                    className={[styles.textInput, styles.mono].join(' ')}
                                    type="text"
                                    value={config.endpoints.detailDataPath ?? ''}
                                    placeholder="留空=默认 data；例：data.detail"
                                    onChange={(e) => updateEndpoints('detailDataPath', e.target.value)}
                                />
                                <span className={styles.fieldHint}>dot 路径</span>
                            </div>
                        </>
                    )}
                </section>

                {/* 事件搜索端点（独立于列表/详情端点） */}
                <section className={styles.section}>
                    <h4 className={styles.sectionTitle}>事件搜索端点</h4>
                    <p className={styles.fieldHint} style={{ marginBottom: 8 }}>
                        独立的事件搜索接口，用于统一搜索功能。留空时后端从事件列表缓存中过滤。
                        后端会自动附加 <code>?q=关键词</code>（GET）或在 body 中发送 <code>{'{"q":"关键词"}'}</code>（POST）。
                    </p>

                    <div className={styles.fieldInline}>
                        <label className={styles.fieldLabel}>搜索接口 URL</label>
                        <input
                            className={[styles.textInput, styles.mono].join(' ')}
                            type="url"
                            value={config.searchEndpoints?.url ?? ''}
                            placeholder="https://api.example.com/v1/campus/events/search"
                            onChange={(e) => updateSearchEndpoints('url', e.target.value)}
                        />
                        <select
                            className={styles.select}
                            value={config.searchEndpoints?.method ?? 'GET'}
                            onChange={(e) => updateSearchEndpoints('method', e.target.value as 'GET' | 'POST')}
                        >
                            <option value="GET">GET</option>
                            <option value="POST">POST</option>
                        </select>
                    </div>

                    <div className={styles.fieldInline}>
                        <label className={styles.fieldLabel}>
                            搜索结果数组路径 <span className={styles.fieldHint}>(留空=默认 ApiEnvelope.data)</span>
                        </label>
                        <input
                            className={[styles.textInput, styles.mono].join(' ')}
                            type="text"
                            value={config.searchEndpoints?.listDataPath ?? ''}
                            placeholder="例：data.items / result.list"
                            onChange={(e) => updateSearchEndpoints('listDataPath', e.target.value)}
                        />
                        <span className={styles.fieldHint}>dot 路径</span>
                    </div>
                </section>

                {/* 请求头 */}
                <section className={styles.section}>
                    <h4 className={styles.sectionTitle}>请求头 Headers (含 Token 鉴权)</h4>
                    <div className={styles.headersTable}>
                        {config.headers.map((h, i) => (
                            <div key={i} className={styles.headerRow}>
                                <input
                                    type="checkbox"
                                    title="启用本条请求头"
                                    checked={h.enabled}
                                    onChange={(e) => updateHeader(i, { enabled: e.target.checked })}
                                />
                                <input
                                    className={styles.textInput}
                                    type="text"
                                    placeholder="Header 名，如 Authorization"
                                    value={h.key}
                                    onChange={(e) => updateHeader(i, { key: e.target.value })}
                                />
                                <input
                                    className={[styles.textInput, styles.mono].join(' ')}
                                    type="text"
                                    placeholder='如 Bearer eyJhbGciOi... 或 Token xxx'
                                    value={h.value}
                                    onChange={(e) => updateHeader(i, { value: e.target.value })}
                                />
                                <button
                                    type="button"
                                    className={styles.iconBtn}
                                    title="删除本条"
                                    onClick={() => removeHeader(i)}
                                    aria-label="删除本条请求头"
                                >
                                    ×
                                </button>
                            </div>
                        ))}
                    </div>
                    <div className={styles.btnRow}>
                        <button type="button" className={styles.btn} onClick={addHeader}>
                            + 新增 Header
                        </button>
                        <span className={styles.fieldHint}>
                            关闭开关即保留条目但不实际发送；敏感 Token 仅保存在服务器 JSON / 本地浏览器。
                        </span>
                    </div>
                </section>

                {/* 字段映射 */}
                <section className={styles.section}>
                    <h4 className={styles.sectionTitle}>
                        字段映射 <span className={styles.fieldHint}>(留空即使用同名字段，无需逐条配置)</span>
                    </h4>
                    <div className={styles.mappingTable}>
                        <div className={styles.mappingHead}>
                            <span>统一事件字段 (目标)</span>
                            <span>期望类型</span>
                            <span>源字段路径 (输入第三方实际字段名)</span>
                        </div>
                        {mappingRows.map(({ meta, mapped, def }) => (
                            <div key={meta.key} className={styles.mappingRow}>
                                <div>
                                    <div className={styles.mappingKey}>
                                        {meta.required ? '★ ' : ''}
                                        {meta.label}
                                    </div>
                                    <div className={styles.mappingType}>→ {meta.key}</div>
                                </div>
                                <div className={styles.mappingType}>
                                    {meta.type}
                                    {meta.enumHint ? <div style={{ fontSize: 10 }}>{meta.enumHint}</div> : null}
                                </div>
                                <input
                                    className={[styles.textInput, styles.mono].join(' ')}
                                    type="text"
                                    value={mapped}
                                    placeholder={`默认同名字段: ${def}`}
                                    onChange={(e) => updateMapping(meta.key, e.target.value)}
                                />
                            </div>
                        ))}
                    </div>
                </section>

                {/* 测试请求 */}
                <section className={styles.section}>
                    <h4 className={styles.sectionTitle}>测试映射</h4>
                    <div className={styles.btnRow}>
                        <button
                            type="button"
                            className={[styles.btn, styles.btnSuccess].join(' ')}
                            onClick={onTest}
                            disabled={testing || !config.endpoints.url}
                        >
                            {testing ? '发送中…' : '▶ 发送测试请求'}
                        </button>
                        <span className={styles.fieldHint}>
                            会真实请求第三方接口并应用当前的 headers / listDataPath / 字段映射。
                        </span>
                    </div>

                    {testResult && (
                        <div className={styles.testResult}>
                            <div className={styles.testMeta}>
                                <span>
                                    结果：
                                    <strong className={testResult.ok ? styles.testOk : styles.testFail}>
                                        {testResult.ok ? '成功' : '失败'}
                                    </strong>
                                </span>
                                <span>HTTP <strong>{testResult.httpStatus || '—'}</strong></span>
                                <span>耗时 <strong>{testResult.durationMs} ms</strong></span>
                                <span>挖到列表 <strong>{testResult.rawList.length}</strong> 条</span>
                                <span>成功映射 <strong>{testResult.events.length}</strong> 条事件</span>
                            </div>
                            {testResult.message && (
                                <div className={[styles.saveMsg, styles.err].join(' ')}>{testResult.message}</div>
                            )}
                            {testResult.mappingProblems.length > 0 && (
                                <dl className={styles.problemList}>
                                    <dt className={styles.previewId}>⚠ 映射问题清单 ({testResult.mappingProblems.length})</dt>
                                    {testResult.mappingProblems.slice(0, 50).map((p, i) => (
                                        <dd key={i} className={styles.problemItem}>
                                            第 {p.eventIndex} 项 · <strong>{p.field}</strong>: {p.reason}
                                        </dd>
                                    ))}
                                    {testResult.mappingProblems.length > 50 && (
                                        <dd className={styles.problemItem}>
                                            ... 仅显示前 50 条，共 {testResult.mappingProblems.length} 条问题
                                        </dd>
                                    )}
                                </dl>
                            )}
                            {testResult.events.length > 0 && (
                                <div className={styles.previewList}>
                                    <div className={styles.previewId}>事件预览 (前 {Math.min(5, testResult.events.length)} 条)</div>
                                    {testResult.events.slice(0, 5).map((ev) => (
                                        <article key={ev.id} className={styles.previewCard}>
                                            <div className={styles.previewTitle}>
                                                <span>{ev.title}</span>
                                                <span className={styles.previewId}>#{ev.id.slice(0, 10)}</span>
                                            </div>
                                            <dl className={styles.previewGrid}>
                                                <dt>分类</dt><dd>{ev.category} · {ev.severity} · {ev.status}</dd>
                                                <dt>地点</dt><dd>{ev.locationName || '—'} {ev.locationId ? `(${ev.locationId})` : ''}</dd>
                                                <dt>时间</dt><dd>{ev.startTime ? new Date(ev.startTime).toLocaleString() : '—'}</dd>
                                                <dt>参与</dt><dd>{ev.participantCount ?? '—'} 人</dd>
                                                <dt>jumpUrl</dt>
                                                <dd style={{ color: ev.jumpUrl ? 'var(--primary)' : 'inherit' }}>
                                                    {ev.jumpUrl ? (
                                                        <a href={ev.jumpUrl} target="_blank" rel="noreferrer">
                                                            {ev.jumpUrl.length > 60 ? ev.jumpUrl.slice(0, 60) + '…' : ev.jumpUrl}
                                                        </a>
                                                    ) : '— (未提供，详情抽屉仅展示)'}
                                                </dd>
                                                <dt>标签</dt><dd>{ev.tags && ev.tags.length ? ev.tags.join(', ') : '—'}</dd>
                                            </dl>
                                            {ev.description && <p className={styles.previewDesc}>{ev.description}</p>}
                                        </article>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </section>
            </div>

            {/* 底部保存 + 导入导出 + 状态 */}
            <footer className={styles.footer}>
                <div className={styles.btnRow}>
                    <button
                        type="button"
                        className={[styles.btn, styles.btnPrimary].join(' ')}
                        onClick={onSave}
                        disabled={saveState.kind === 'saving'}
                    >
                        {saveState.kind === 'saving' ? '保存中…' : '💾 保存配置'}
                    </button>
                    <button type="button" className={styles.btn} onClick={onExport}>导出 JSON</button>
                    <button type="button" className={styles.btn} onClick={onImportClick}>导入 JSON</button>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="application/json,.json"
                        style={{ display: 'none' }}
                        onChange={onImportFile}
                    />
                    <button type="button" className={[styles.btn, styles.btnDanger].join(' ')} onClick={onReset}>
                        重置默认
                    </button>
                </div>
                <div
                    className={[
                        styles.saveMsg,
                        saveState.kind === 'ok' ? styles.ok
                            : saveState.kind === 'warn' ? styles.warn
                            : saveState.kind === 'err' ? styles.err : ''
                    ].join(' ')}
                >
                    {saveState.kind === 'idle' ? '未保存的修改仅在当前页面内存中。'
                        : saveState.kind === 'saving' ? '正在保存…'
                        : saveState.kind === 'ok' ? `✓ ${saveState.msg}`
                        : saveState.kind === 'warn' ? `⚠ ${saveState.msg}`
                        : `✗ ${saveState.msg}`}
                </div>
            </footer>
        </div>
    );
}
