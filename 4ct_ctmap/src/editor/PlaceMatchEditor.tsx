/* ================================================================
   地理位置匹配编辑面板 PlaceMatchEditor
   —— 编辑 places.json 地点词典：决定没有经纬度的事件如何通过真实地理文字
      (geoText) 转换为坐标与 locationId。

   匹配规则说明（写在面板里给用户看）：
     - mustInclude / mustExclude / keywords 三项都支持普通词与正则项；
     - 正则项以 "/" 开头**和**结尾，中间体作为 JS RegExp 编译，
       如 "/H[0-9][A-Za-z]{2}/" 可匹配 H1XX 这类教室编号；
     - 地点可关联建筑（buildingIds）或地皮（parcelIds）：本地点不写
       position 时，坐标取关联建筑/地皮的中心点。

   输入口径：
     - 多值字段（mustInclude / mustExclude / keywords / buildingIds /
       parcelIds）统一用标签输入 TagInput：回车把输入框内容变成一个标签，
       逗号只是普通字符（正则项内部可能含逗号，不能当分隔符），
       标签上的 × 删除，输入框为空时退格删最后一个。
     - 数值字段（weight / position）用草稿输入 DraftInput：输入期间保留
       原文，回车或失焦才解析提交；解析失败保留原文并标红，不静默清空。

   保存走 Node 服务端 /api/map/places (PUT, X-Admin-Key 鉴权)。
   ================================================================ */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LonLat } from '../contract';
import { mapApi, type PlaceRule, type PlacesFile } from '../api/mapApi';
import shared from '../ui/styles/eventApiConfig.module.css';
import styles from './placeMatch.module.css';

/** 与父级（EditorApp）的「从地图选坐标」桥接契约 */
export interface PlaceMatchEditorProps {
    /** 画布当前是否处于拾取坐标模式（用于展示提示/按钮态） */
    picking: boolean;
    /** 画布回传的经纬度信号：每次完成一次拾取就生成一个新对象（含坐标），
        正在待回填的那条地点据此写入 position。恒非 null 也靠引用变化触发。 */
    picked: { lonlat: LonLat } | null;
    /** 用户点了「从地图中选取」：要求父级把画布切入拾取模式 */
    onRequestPick: () => void;
    /** 取消拾取：要求父级把画布退出拾取模式 */
    onCancelPick: () => void;
}

type SaveState =
    | { kind: 'idle' }
    | { kind: 'saving' }
    | { kind: 'ok'; msg: string }
    | { kind: 'warn'; msg: string }
    | { kind: 'err'; msg: string };

/** 编辑器内部行：PlaceRule + 前端专用的稳定标识 uid（保存前剔除，不入库） */
type PlaceRow = PlaceRule & { uid: string };

/** uid 自增序号：只用于 React key / 卡片定位，保证增删与排序后行身份不串 */
let rowSeq = 0;
const nextUid = (): string => `place-${++rowSeq}`;

/** 空地点条目：用于「新增地点」时的初始模板 */
function emptyPlace(): PlaceRow {
    return { uid: nextUid(), name: '', mustInclude: [] };
}

/** 服务端读回的地点列表 → 编辑器行（补 uid） */
function toRows(places: readonly PlaceRule[] | undefined): PlaceRow[] {
    return (places ?? []).map((p) => ({ ...p, uid: nextUid() }));
}

/** 编辑器行 → 服务端地点（剔除 uid，其余字段原样保留） */
function toPlaceRule({ uid, ...rule }: PlaceRow): PlaceRule {
    void uid; // uid 仅前端使用，剔除后再入库
    return rule;
}

/** 正则项判定：与 server/src/utils/places.ts 的 tryCompileRegex 同口径 */
function isRegexTerm(term: string): boolean {
    return term.length >= 2 && term.startsWith('/') && term.endsWith('/');
}

/** 数组数字字段（经纬度，逗号分隔）→ 输入框文本 */
function toPosText(pos?: readonly [number, number]): string {
    return pos ? pos.join(', ') : '';
}

/** 输入框文本 → 经纬度数对；不是两个有限数字时返回 undefined */
function fromPosText(raw: string): [number, number] | undefined {
    const parts = raw
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map(Number);
    if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return undefined;
    return [parts[0], parts[1]];
}

/* ----------------------------------------------------------------
   标签输入：多值字段（必现词 / 禁现词 / 关键词 / 关联建筑 / 关联地皮）
   —— 回车把输入框内容变成一个标签；失焦（点到别处）也会提交当前文本，
      避免"打完忘记回车"导致内容丢失；逗号不参与切分。
   ---------------------------------------------------------------- */

interface TagInputProps {
    /** 当前标签列表（受控） */
    values: string[];
    /** 提交新的标签列表 */
    onChange: (next: string[]) => void;
    placeholder?: string;
}

function TagInput({ values, onChange, placeholder }: TagInputProps) {
    /** 尚未提交的输入框文本 */
    const [draft, setDraft] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    /** 把输入框文本落成一个标签；空白与重复标签直接忽略 */
    const commitDraft = useCallback((): void => {
        const term = draft.trim();
        setDraft('');
        if (!term || values.includes(term)) return;
        onChange([...values, term]);
    }, [draft, onChange, values]);

    const removeAt = useCallback(
        (index: number): void => {
            onChange(values.filter((_, i) => i !== index));
        },
        [onChange, values]
    );

    return (
        <div className={styles.tagBox} onClick={() => inputRef.current?.focus()}>
            {values.map((term, index) => (
                <span
                    key={term}
                    className={[styles.tag, isRegexTerm(term) ? styles.tagRegex : ''].join(' ')}
                    title={isRegexTerm(term) ? '正则项：整串编译为 JS 正则参与匹配' : '普通词：子串包含匹配'}
                >
                    <span className={styles.tagText}>{term}</span>
                    <button
                        type="button"
                        className={styles.tagRemove}
                        tabIndex={-1}
                        aria-label={`删除 ${term}`}
                        onClick={(e) => {
                            /* 阻止冒泡：避免顺带聚焦输入框后把光标带回来 */
                            e.stopPropagation();
                            removeAt(index);
                        }}
                    >
                        ×
                    </button>
                </span>
            ))}
            <input
                ref={inputRef}
                className={styles.tagInput}
                type="text"
                value={draft}
                placeholder={values.length === 0 ? placeholder : ''}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                    /* 中文输入法选词时的回车（isComposing）不能当提交 */
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        commitDraft();
                    } else if (e.key === 'Backspace' && !draft && values.length > 0) {
                        /* 输入框已空再退格：删掉最后一个标签 */
                        e.preventDefault();
                        removeAt(values.length - 1);
                    }
                }}
                onBlur={commitDraft}
            />
        </div>
    );
}

/* ----------------------------------------------------------------
   草稿输入：数值字段（weight / position）
   —— 输入期间保留用户原文（"0." 这种中间态不会被解析回写），
      回车或失焦才提交；提交被拒绝时保留原文并标红。
   ---------------------------------------------------------------- */

interface DraftInputProps {
    /** 规范化文本：外部改动（加载 / 地图拾取 / 提交成功）时用它覆盖输入框 */
    value: string;
    /** 提交解析：返回错误文案表示拒绝本次输入，返回 null 表示已接受 */
    onCommit: (text: string) => string | null;
    placeholder?: string;
    className?: string;
}

function DraftInput({ value, onCommit, placeholder, className }: DraftInputProps) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [text, setText] = useState(value);
    const [error, setError] = useState<string | null>(null);
    /** 最近一次已确定的规范值：只有它变了才说明是外部改动，才覆盖用户输入 */
    const settled = useRef(value);

    useEffect(() => {
        if (value === settled.current) return;
        settled.current = value;
        setText(value);
        setError(null);
    }, [value]);

    const commit = useCallback((): void => {
        const message = onCommit(text);
        /* 提交成功时父级会把 value 改成规范文本，上面的 effect 负责同步显示 */
        setError(message);
    }, [onCommit, text]);

    return (
        <input
            ref={inputRef}
            className={[className ?? '', error ? styles.inputInvalid : ''].join(' ')}
            type="text"
            value={text}
            placeholder={placeholder}
            title={error ?? undefined}
            onChange={(e) => {
                setText(e.target.value);
                setError(null);
            }}
            onBlur={commit}
            onKeyDown={(e) => {
                /* 回车即提交：靠失焦触发同一套提交逻辑，顺带给出「已离开输入」的反馈 */
                if (e.key === 'Enter') inputRef.current?.blur();
            }}
        />
    );
}

export function PlaceMatchEditor({ picking, picked, onRequestPick, onCancelPick }: PlaceMatchEditorProps) {
    const [places, setPlaces] = useState<PlaceRow[]>([]);
    const [version, setVersion] = useState(1);
    const [loadNote, setLoadNote] = useState('尚未加载');
    const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
    /** 正在「从地图选坐标」的是哪一条地点；null = 未在拾取 */
    const [pickingUid, setPickingUid] = useState<string | null>(null);
    /** 刚新增、待滚动定位并聚焦的行 uid */
    const [focusUid, setFocusUid] = useState<string | null>(null);
    /** 行 uid → 卡片 DOM：新增后据此滚动定位 */
    const cardRefs = useRef(new Map<string, HTMLElement>());

    /* ---------- 初始化：从服务端读取 places.json ---------- */
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const file = await mapApi.fetchPlaces();
                if (cancelled) return;
                setPlaces(toRows(file.places));
                setVersion(file.version ?? 1);
                setLoadNote(`已加载 ${file.places?.length ?? 0} 个地点`);
            } catch (e) {
                if (cancelled) return;
                const msg = e instanceof Error ? e.message : String(e);
                setLoadNote(`读取失败：${msg}`);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    /* ---------- 地点条目 CRUD（一律按 uid 定位，避免排序/删除后串行） ---------- */
    const updatePlace = useCallback((uid: string, patch: Partial<PlaceRow>): void => {
        setPlaces((prev) => prev.map((row) => (row.uid === uid ? { ...row, ...patch } : row)));
    }, []);

    const addPlace = useCallback((): void => {
        const row = emptyPlace();
        setPlaces((prev) => [...prev, row]);
        setFocusUid(row.uid);
    }, []);

    const removePlace = useCallback((uid: string): void => {
        setPlaces((prev) => prev.filter((row) => row.uid !== uid));
    }, []);

    /** 交换两个条目的顺序（影响同分匹配时的优先级） */
    const movePlace = useCallback((uid: string, dir: -1 | 1): void => {
        setPlaces((prev) => {
            const idx = prev.findIndex((row) => row.uid === uid);
            const target = idx + dir;
            if (idx < 0 || target < 0 || target >= prev.length) return prev;
            const next = prev.slice();
            const [moved] = next.splice(idx, 1);
            next.splice(target, 0, moved);
            return next;
        });
    }, []);

    const setCardRef = useCallback((uid: string, el: HTMLElement | null): void => {
        if (el) cardRefs.current.set(uid, el);
        else cardRefs.current.delete(uid);
    }, []);

    /** 新增条目后：聚焦新卡片的第一个输入框并滚动到可视区，免去来回滑动 */
    useEffect(() => {
        if (!focusUid) return;
        const el = cardRefs.current.get(focusUid);
        if (!el) return;
        el.querySelector('input')?.focus({ preventScroll: true });
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        setFocusUid(null);
    }, [focusUid, places]);

    /* ---------- 数值字段提交（返回错误文案 = 拒绝，保留用户原文） ---------- */

    /** 权重：留空 = 不写该字段，由服务端按默认 1 处理 */
    const commitWeight = useCallback(
        (uid: string, text: string): string | null => {
            const raw = text.trim();
            if (!raw) {
                updatePlace(uid, { weight: undefined });
                return null;
            }
            const value = Number(raw);
            if (!Number.isFinite(value)) return '权重必须是数字，留空表示默认 1';
            updatePlace(uid, { weight: value });
            return null;
        },
        [updatePlace]
    );

    /** 坐标：留空 = 不写 position，改用关联建筑/地皮中心；填写则校验经纬度范围 */
    const commitPosition = useCallback(
        (uid: string, text: string): string | null => {
            const raw = text.trim();
            if (!raw) {
                updatePlace(uid, { position: undefined });
                return null;
            }
            const parsed = fromPosText(raw);
            if (!parsed) return '坐标需为「纬度, 经度」两个数字，如 31.2345, 121.5678';
            if (parsed[0] < -90 || parsed[0] > 90) return '纬度需在 -90 ~ 90 之间';
            if (parsed[1] < -180 || parsed[1] > 180) return '经度需在 -180 ~ 180 之间';
            updatePlace(uid, { position: parsed });
            return null;
        },
        [updatePlace]
    );

    /* ---------- 从地图选坐标 ---------- */

    /** 点了某条地点的「从地图中选取」：记住是哪条，并请父级切入画布拾取模式 */
    const startPickFor = useCallback(
        (uid: string): void => {
            setPickingUid(uid);
            onRequestPick();
        },
        [onRequestPick]
    );

    /** 取消当前拾取：清掉待回填的那条，并请父级退出画布拾取模式 */
    const cancelPick = useCallback((): void => {
        setPickingUid(null);
        onCancelPick();
    }, [onCancelPick]);

    /** 画布回传坐标信号变化时：回填到待回填的那条的 position，随后结束拾取 */
    useEffect(() => {
        if (!picked || pickingUid === null) return;
        updatePlace(pickingUid, { position: picked.lonlat });
        setPickingUid(null);
        onCancelPick();
    }, [picked, pickingUid, onCancelPick, updatePlace]);

    /* ---------- 保存 ---------- */
    const onSave = useCallback(async () => {
        // 基本校验：每条地点至少要有 name 且 mustInclude 非空，否则服务端会拒收
        const malformed = places.findIndex((p) => !p.name.trim() || p.mustInclude.length === 0);
        if (malformed >= 0) {
            setSaveState({
                kind: 'err',
                msg: `第 ${malformed + 1} 条地点缺少名称或必现词 (mustInclude)，已阻止保存。`,
            });
            return;
        }
        setSaveState({ kind: 'saving' });
        try {
            const file: PlacesFile = { version, places: places.map(toPlaceRule) };
            const result = await mapApi.savePlaces(file);
            setLoadNote(`已写入 ${result.saved} 个地点`);
            setSaveState({ kind: 'ok', msg: `已保存 ${result.saved} 个地点；原文件已备份为 .bak` });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setSaveState({ kind: 'err', msg: `保存失败：${msg}` });
        }
    }, [places, version]);

    const total = useMemo(() => places.length, [places]);

    return (
        <div className={shared.configRoot}>
            <header className={shared.configHead}>
                <h3 className={shared.configTitle}>地理位置匹配 · 地点词典</h3>
                <span className={shared.configBadge}>{loadNote}</span>
            </header>

            <div className={shared.configBody}>
                <section className={shared.section}>
                    <h4 className={shared.sectionTitle}>匹配规则说明</h4>
                    <ul className={styles.helpList}>
                        <li>
                            必现词 (mustInclude) 命中任一即候选；禁现词 (mustExclude) 命中任一即排除；关键词
                            (keywords) 额外加分。
                        </li>
                        <li>
                            三项均支持<strong>正则项</strong>：以 <code>/</code> 开头<strong>和</strong>结尾的整串会编译为 JS 正则，
                            如 <code>/H[0-9][A-Za-z]{2}/</code> 匹配 H1XX 教室。普通词为包含匹配。
                        </li>
                        <li>
                            多值字段为<strong>标签输入</strong>：回车把输入框内容变成一个标签，逗号只是普通字符（正则项里可能含逗号）；
                            点标签上的 × 删除，输入框为空时退格删掉最后一个。
                        </li>
                        <li>
                            可关联建筑 (buildingIds) 或地皮 (parcelIds，如 <code>p-hw-543937595</code>)；
                            未填写坐标 (position) 时会自动取关联建筑/地皮的中心点作为事件坐标。
                        </li>
                        <li>
                            坐标统一为 WGS-84（纬度, 经度）；事件存在经纬度时以经纬度优先，否则按 geoText 匹配本词典。
                        </li>
                    </ul>
                </section>

                <section className={shared.section}>
                    <div className={styles.listHead}>
                        <h4 className={shared.sectionTitle}>地点条目（{total}）</h4>
                        <div className={shared.btnRow}>
                            <button type="button" className={shared.btn} onClick={addPlace}>
                                + 新增地点
                            </button>
                        </div>
                    </div>

                    {places.length === 0 && (
                        <div className={styles.emptyHint}>暂无地点，点击「新增地点」开始配置。</div>
                    )}

                    <div className={styles.placeList}>
                        {places.map((p, idx) => (
                            <article
                                key={p.uid}
                                className={styles.placeCard}
                                ref={(el) => setCardRef(p.uid, el)}
                            >
                                <header className={styles.placeHead}>
                                    <span className={styles.placeIndex}>#{idx + 1}</span>
                                    <div className={styles.placeHeadMain}>
                                        <span className={styles.placeName}>{p.name.trim() || '未命名地点'}</span>
                                        <span className={styles.placeMeta}>
                                            必现词 {p.mustInclude.length} · 坐标{' '}
                                            {p.position
                                                ? '已设置'
                                                : (p.buildingIds?.length ?? 0) + (p.parcelIds?.length ?? 0) > 0
                                                  ? '取关联中心'
                                                  : '未设置'}
                                            {typeof p.weight === 'number' ? ` · 权重 ${p.weight}` : ''}
                                        </span>
                                    </div>
                                    <div className={styles.placeHeadActions}>
                                        <button
                                            type="button"
                                            className={styles.headBtn}
                                            title="上移（优先级提高）"
                                            disabled={idx === 0}
                                            onClick={() => movePlace(p.uid, -1)}
                                        >
                                            ↑
                                        </button>
                                        <button
                                            type="button"
                                            className={styles.headBtn}
                                            title="下移（优先级降低）"
                                            disabled={idx === places.length - 1}
                                            onClick={() => movePlace(p.uid, 1)}
                                        >
                                            ↓
                                        </button>
                                        <button
                                            type="button"
                                            className={[styles.headBtn, styles.headBtnDanger].join(' ')}
                                            title="删除这条地点"
                                            onClick={() => removePlace(p.uid)}
                                        >
                                            删除
                                        </button>
                                    </div>
                                </header>

                                <div className={styles.placeBody}>
                                    <div className={styles.placeRow}>
                                        <input
                                            className={shared.textInput}
                                            type="text"
                                            placeholder="地点名称，如 银杏大道 / 第一教学楼"
                                            value={p.name}
                                            onChange={(e) => updatePlace(p.uid, { name: e.target.value })}
                                        />
                                        <input
                                            className={[shared.textInput, shared.mono].join(' ')}
                                            type="text"
                                            placeholder="locationId (留空=地点名称)"
                                            value={p.locationId ?? ''}
                                            onChange={(e) => updatePlace(p.uid, { locationId: e.target.value })}
                                        />
                                    </div>

                                    <div className={styles.placeField}>
                                        <label className={styles.placeLabel}>
                                            必现词 mustInclude（至少一个，任一命中即候选；回车添加）
                                        </label>
                                        <TagInput
                                            values={p.mustInclude}
                                            onChange={(next) => updatePlace(p.uid, { mustInclude: next })}
                                            placeholder="输入词后按回车，如 银杏大道"
                                        />
                                    </div>

                                    <div className={styles.placeField}>
                                        <label className={styles.placeLabel}>
                                            禁现词 mustExclude（任一命中即排除，可留空；回车添加）
                                        </label>
                                        <TagInput
                                            values={p.mustExclude ?? []}
                                            onChange={(next) => updatePlace(p.uid, { mustExclude: next })}
                                            placeholder="输入词后按回车"
                                        />
                                    </div>

                                    <div className={styles.placeField}>
                                        <label className={styles.placeLabel}>加分关键词 keywords（可留空；回车添加）</label>
                                        <TagInput
                                            values={p.keywords ?? []}
                                            onChange={(next) => updatePlace(p.uid, { keywords: next })}
                                            placeholder="输入词后按回车"
                                        />
                                    </div>

                                    <div className={styles.placeRow}>
                                        <div className={styles.placeField}>
                                            <label className={styles.placeLabel}>关联建筑 buildingIds（回车添加）</label>
                                            <TagInput
                                                values={p.buildingIds ?? []}
                                                onChange={(next) => updatePlace(p.uid, { buildingIds: next })}
                                                placeholder="输入建筑 ID 后按回车，如 1001"
                                            />
                                        </div>
                                        <div className={styles.placeField}>
                                            <label className={styles.placeLabel}>关联地皮 parcelIds（回车添加）</label>
                                            <TagInput
                                                values={p.parcelIds ?? []}
                                                onChange={(next) => updatePlace(p.uid, { parcelIds: next })}
                                                placeholder="输入地皮 ID 后按回车，如 p-hw-543937595"
                                            />
                                        </div>
                                    </div>

                                    <div className={styles.placeRow}>
                                        <div className={styles.placeField}>
                                            <label className={styles.placeLabel}>权重 weight（留空按默认 1）</label>
                                            <DraftInput
                                                className={[shared.textInput, shared.mono].join(' ')}
                                                value={String(p.weight ?? '')}
                                                onCommit={(text) => commitWeight(p.uid, text)}
                                                placeholder="默认 1"
                                            />
                                        </div>
                                        <div className={styles.placeField}>
                                            <label className={styles.placeLabel}>
                                                自身坐标 position（WGS-84 纬度, 经度）
                                            </label>
                                            <div className={styles.posField}>
                                                <DraftInput
                                                    className={[shared.textInput, shared.mono].join(' ')}
                                                    value={toPosText(p.position)}
                                                    onCommit={(text) => commitPosition(p.uid, text)}
                                                    placeholder="留空取建筑/地皮中心"
                                                />
                                                <button
                                                    type="button"
                                                    className={[shared.btn, pickingUid === p.uid ? shared.btnPrimary : ''].join(' ')}
                                                    title="点击后画布切入拾取模式：在地图上点一下，自动把该点坐标回填到这里"
                                                    disabled={picking && pickingUid !== p.uid}
                                                    onClick={() => (pickingUid === p.uid ? cancelPick() : startPickFor(p.uid))}
                                                >
                                                    {pickingUid === p.uid ? '取消选取' : '从地图中选取'}
                                                </button>
                                            </div>
                                        </div>
                                    </div>

                                    {pickingUid === p.uid ? (
                                        <div className={styles.pickHint}>
                                            ↖ 在地图上点击一处，即可把该点坐标回填到「自身坐标」，Esc 取消。
                                        </div>
                                    ) : null}
                                </div>
                            </article>
                        ))}
                    </div>

                    <div className={shared.btnRow}>
                        <button
                            type="button"
                            className={shared.btn}
                            title="追加到列表末尾，并自动滚动定位到新条目"
                            onClick={addPlace}
                        >
                            + 新增地点
                        </button>
                        <span className={shared.fieldHint}>新增的条目自动定位到首行输入框。</span>
                    </div>
                </section>
            </div>

            <footer className={shared.footer}>
                <div className={shared.btnRow}>
                    <button
                        type="button"
                        className={[shared.btn, shared.btnPrimary].join(' ')}
                        onClick={onSave}
                        disabled={saveState.kind === 'saving'}
                    >
                        {saveState.kind === 'saving' ? '保存中…' : '保存地点词典'}
                    </button>
                    <span className={shared.fieldHint}>
                        由服务端校验后整份覆盖写入 places.json，写前自动备份 .bak。
                    </span>
                </div>
                <div
                    className={[
                        shared.saveMsg,
                        saveState.kind === 'ok' ? shared.ok
                            : saveState.kind === 'warn' ? shared.warn
                            : saveState.kind === 'err' ? shared.err : ''
                    ].join(' ')}
                >
                    {saveState.kind === 'idle'
                        ? '未保存的修改仅在当前页面内存中。'
                        : saveState.kind === 'saving'
                          ? '正在保存…'
                          : saveState.kind === 'ok'
                            ? `✓ ${saveState.msg}`
                            : saveState.kind === 'warn'
                              ? `⚠ ${saveState.msg}`
                              : `✗ ${saveState.msg}`}
                </div>
            </footer>
        </div>
    );
}
