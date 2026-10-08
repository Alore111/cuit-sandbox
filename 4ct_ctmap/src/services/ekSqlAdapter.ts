/* ================================================================
   真实二课活动数据适配器
   —— 把 temp_data/ct_ek_activities.sql 中导出的活动行（EkActivity 表结构，
      与 backend_core/models/ek_image.py → EkActivity 字段完全一致）
      转换成前端契约 SecondClassActivity[]。

   同时附带：
   1) 解析 SQL 文本行（INSERT VALUES 语法解析）成原始行对象；
   2) 将中文文本字段映射成枚举（moduleCode / activityLevel / signInMethod 等）；
   3) 将纯文本地址（ActivityAddress）反向锚定到 buildings.json 的建筑上，
      用于地图侧的定位（优先锚到航空港校区，龙泉校区也尽量兼容）。
================================================================ */

import type { Building, LonLat, SecondClassActivity } from '../contract';
import {
    ACTIVITY_LEVEL_DEFAULTS,
    ACTIVITY_MODULE_DEFAULTS,
    parseActivityStatusCode,
    getActivityStatusText,
} from '../contract';

/* ----------------------------------------------------------------
 * 一、SQL INSERT 行解析（临时简易解析，不依赖 mysql 客户端）
 *    只解析 Navicat dump 风格的单条 VALUES ( ... ) 行。
 * ---------------------------------------------------------------- */

/** 把 "INSERT INTO ... VALUES (1, 'a', NULL, 'b,c')" 形式的行拆成原生字段数组 */
export function parseSqlInsertValues(line: string): (string | number | null)[] | null {
    const m = line.match(/VALUES\s*\((.*)\)\s*;?\s*$/is);
    if (!m) return null;
    const body = m[1];
    const out: (string | number | null)[] = [];
    let i = 0;
    let cur = '';
    let inStr = false;
    let quote: "'" | '"' | null = null;
    let curIsString = false;
    while (i < body.length) {
        const ch = body[i];
        if (!inStr) {
            if (ch === "'" || ch === '"') {
                inStr = true;
                quote = ch;
                cur = '';
                curIsString = true;
            } else if (ch === ',') {
                if (curIsString) {
                    out.push(cur);
                } else {
                    cur = cur.trim();
                    if (cur === '' || cur.toUpperCase() === 'NULL') {
                        out.push(null);
                    } else {
                        const n = Number(cur);
                        out.push(Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(cur) ? n : cur);
                    }
                }
                cur = '';
                curIsString = false;
            } else if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') {
                cur += ch;
            }
        } else {
            if (ch === '\\' && i + 1 < body.length) {
                const n = body[i + 1];
                if (n === 'n') cur += '\n';
                else if (n === 'r') cur += '\r';
                else if (n === 't') cur += '\t';
                else if (n === '0') cur += '\0';
                else cur += n;
                i += 1;
            } else if (ch === quote) {
                if (body[i + 1] === quote) {
                    cur += quote;
                    i += 1;
                } else {
                    inStr = false;
                    quote = null;
                    // 注意：不要在这里直接 out.push(cur)，否则遇到 , 会再 push 一次 null
                    // cur 与 curIsString 标志位保留，交给下一个 , 或行尾统一 push
                }
            } else {
                cur += ch;
            }
        }
        i += 1;
    }
    // 行尾最后一个字段
    if (curIsString) {
        out.push(cur);
    } else {
        cur = cur.trim();
        if (cur !== '') {
            if (cur.toUpperCase() === 'NULL') out.push(null);
            else {
                const n = Number(cur);
                out.push(Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(cur) ? n : cur);
            }
        }
    }
    return out;
}

/** ct_ek_activities 表字段顺序（与 CREATE TABLE + 真实 INSERT 对齐） */
const EK_ACTIVITY_FIELDS: readonly (keyof RawEkRow)[] = [
    'id', 'ektId', 'ActivityName', 'ActivityTypeText', 'ActivityAddressAreaStr',
    'ActivityAddress', 'ActivityTime', 'ActScore', 'ActivityIntroduction',
    'YearTerm', 'ApplyOrgName', 'ActivityLevelText', 'ModuleCodeText',
    'SponsorNames', 'OrganizerNames', 'ActivityQDDate', 'IsNeedSignInText',
    'IsNeedSignOutText', 'ActivityQTDate', 'IsLimitStuNumText', 'LimitStuNumber',
    'IsSignExamText', 'IsHandInHomeWorkText', 'GradeLimit', 'SexStr', 'CollegeLimitStr',
    'SignWayText', 'CoverSock', 'longitude', 'latitude', 'InsertTime', 'UpdateTime',
    'sync_source', 'synced_at',
] as const;

interface RawEkRow {
    id: number;
    ektId?: string | null;
    ActivityName?: string | null;
    ActivityTypeText?: string | null;
    ActivityAddressAreaStr?: string | null;
    ActivityAddress?: string | null;
    ActivityTime?: string | null;
    ActScore?: string | null;
    ActivityIntroduction?: string | null;
    YearTerm?: string | null;
    ApplyOrgName?: string | null;
    ActivityLevelText?: string | null;
    ModuleCodeText?: string | null;
    SponsorNames?: string | null;
    OrganizerNames?: string | null;
    ActivityQDDate?: string | null;
    IsNeedSignInText?: string | null;
    IsNeedSignOutText?: string | null;
    ActivityQTDate?: string | null;
    IsLimitStuNumText?: string | null;
    LimitStuNumber?: string | null;
    IsSignExamText?: string | null;
    IsHandInHomeWorkText?: string | null;
    GradeLimit?: string | null;
    SexStr?: string | null;
    CollegeLimitStr?: string | null;
    SignWayText?: string | null;
    CoverSock?: string | null;
    longitude?: string | null;
    latitude?: string | null;
    InsertTime?: string | null;
    UpdateTime?: string | null;
    sync_source?: string | null;
    synced_at?: string | null;
}

/** 解析单行 INSERT → RawEkRow */
export function parseEkActivitySqlRow(line: string): RawEkRow | null {
    const cells = parseSqlInsertValues(line);
    if (!cells) return null;
    const row: RawEkRow = { id: 0 };
    for (let i = 0; i < EK_ACTIVITY_FIELDS.length; i++) {
        const key = EK_ACTIVITY_FIELDS[i];
        const val = cells[i] ?? null;
        (row as any)[key] = val;
    }
    return row;
}

/** 从完整 SQL 文本中批量解析出所有活动 */
export function parseAllEkActivitiesFromSql(sqlText: string): RawEkRow[] {
    const lines = sqlText.split(/\r?\n/);
    const out: RawEkRow[] = [];
    for (const l of lines) {
        if (!l.startsWith('INSERT INTO')) continue;
        const row = parseEkActivitySqlRow(l);
        if (row && row.id) out.push(row);
    }
    return out;
}

/* ----------------------------------------------------------------
 * 二、文本字段 → 枚举映射
 * ---------------------------------------------------------------- */

/** ModuleCodeText → ActivityModule */
const MODULE_RULES: Array<{ re: RegExp; mod: SecondClassActivity['moduleCode'] }> = [
    { re: /思想|党|团|政治|红色|爱国|青年大学习|信仰|信念/, mod: 'thought' },
    { re: /志愿|公益|服务|爱心|奉献|献血|社区|敬老|乡村振兴|支教|环保|卫生/, mod: 'volunteer' },
    { re: /学业|学习|学术|科研|讲座|报告|读书|阅读|英语|数学|考研|期末|四六级|竞赛.*学|知识|辩论|英语/, mod: 'academic' },
    { re: /创新|创业|互联网\+|挑战杯|路演|孵化|创客|商业|三创|双创|发明|专利/, mod: 'innovation' },
    { re: /文化|艺术|音乐|舞蹈|戏剧|书画|摄影|非遗|手工|设计|民谣|吉他|书法|电影|汉服|cos|文创/, mod: 'art' },
    { re: /体育|健身|球类|田径|运动会|武术|瑜伽|太极|户外|徒步|定向|跆拳|篮球|足球|排球|羽毛球|乒乓|游泳|跑步|运动/, mod: 'sports' },
    { re: /实践|社会|调研|暑期|三下乡|实习|见习|实地|走访|参观|红色.*走/, mod: 'practice' },
    { re: /技能|培训|workshop|office|PS|PPT|编程|AI|python|无人机|摄影.*技|剪辑|后期|设计.*技|求职|简历|面试|职场|礼仪/, mod: 'skill' },
];

function mapModule(text?: string | null): SecondClassActivity['moduleCode'] {
    if (!text) return 'other';
    for (const r of MODULE_RULES) if (r.re.test(text)) return r.mod;
    return 'other';
}

/** ActivityLevelText → ActivityLevel */
const LEVEL_RULES: Array<{ re: RegExp; lvl: SecondClassActivity['activityLevel'] }> = [
    { re: /国家|全国|国家级/, lvl: 'national' },
    { re: /省|省级|四川/, lvl: 'provincial' },
    { re: /市|市级|成都/, lvl: 'municipal' },
    { re: /校|校级|全校/, lvl: 'school' },
    { re: /院|学院|院级|各学院/, lvl: 'college' },
    { re: /社团|协会|club/i, lvl: 'club' },
];

function mapLevel(text?: string | null): SecondClassActivity['activityLevel'] | undefined {
    if (!text) return undefined;
    for (const r of LEVEL_RULES) if (r.re.test(text)) return r.lvl;
    return 'school';
}

/** SignWayText → SignInMethod */
function mapSignMethod(text?: string | null): SecondClassActivity['signInMethod'] {
    if (!text) return 'none';
    const t = text;
    let count = 0;
    let method: SecondClassActivity['signInMethod'] = 'none';
    if (/位置|地理|定位|范围|距离|米|GPS|GPS|坐标/.test(t)) { method = 'geo'; count++; }
    if (/扫码|二维码|QR|扫一扫/.test(t)) { method = 'qr'; count++; }
    if (/拍照|图片|照片|上传/.test(t)) { method = 'photo'; count++; }
    if (/验证码|动态|口令|数字/.test(t)) { method = 'captcha'; count++; }
    if (count > 1) return 'combo';
    if (/无需|不用|不要|不签/.test(t)) return 'none';
    return method;
}

/** "是/否" → boolean */
const yesRe = /是|需要|需|要|true|1/i;
function yn(v?: string | null): boolean {
    if (v == null) return false;
    return yesRe.test(String(v));
}

/* ----------------------------------------------------------------
 * 三、时间文本（"2024-05-21 17:40至2024-05-21 23:59"）解析
 * ---------------------------------------------------------------- */

function splitRange(text: string | null | undefined): [Date | null, Date | null] {
    if (!text) return [null, null];
    const parts = text.split(/至|~|-{2,}|—/).map((s) => s.trim());
    if (parts.length === 0) return [null, null];
    const tryParse = (s: string): Date | null => {
        // 把 "2024-05-21 23:59" 补成 "2024-05-21T23:59:00"（东八区理解成本地时间即可）
        const iso = s.replace(/\s+/, 'T') + (s.includes(':') ? ':00' : 'T00:00:00').slice(s.includes(':') ? 0 : 9);
        const d = new Date(iso);
        return Number.isFinite(d.getTime()) ? d : null;
    };
    if (parts.length === 1) {
        const d = tryParse(parts[0]);
        return [d, d ? new Date(d.getTime() + 2 * 60 * 60 * 1000) : null]; // 默认 2 小时
    }
    return [tryParse(parts[0]), tryParse(parts[1])];
}

/* ----------------------------------------------------------------
 * 四、建筑/地点锚定：把文本地址 (ActivityAddress + ActivityAddressAreaStr)
 *    匹配到已知的建筑列表上，给出坐标 + buildingId
 * ---------------------------------------------------------------- */

interface AnchorResult {
    buildingId?: string;
    buildingName?: string;
    position?: LonLat;
}

/** 简单关键词评分：匹配越多 → 分数越高，取最高匹配的建筑 */
export function anchorActivityToBuilding(
    row: RawEkRow,
    buildings: Building[]
): AnchorResult {
    const text = [row.ActivityAddress, row.ActivityAddressAreaStr, row.ActivityName]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

    if (!text) return {};

    let best: { b: Building; score: number } | null = null;
    for (const b of buildings) {
        const bName = (b.name || '').toLowerCase();
        const bType = (b.typeLabel || '').toLowerCase();
        if (!bName && !bType) continue;
        let score = 0;
        if (bName && text.includes(bName)) score += 10;
        if (bName.length >= 2 && text.includes(bName.slice(0, 2))) score += 3;
        if (bType && text.includes(bType)) score += 4;
        // 细化关键词
        const keywords = [
            ['体育馆', /体育馆|球场|篮球|足球|羽毛|乒乓|跆拳|田径|游泳|运动|健身/],
            ['图书馆', /图书馆|图书|自习|阅读|阅览/],
            ['食堂', /食堂|餐厅|饭堂|美食/],
            ['教学楼', /教学楼|教室|讲堂|报告|H\d{4}|S\d{4}|F\d{4}|实验/],
            ['学院', /学院|系|研究所|实验室/],
            ['宿舍', /宿舍|公寓|寝|住宿/],
            ['广场', /广场|喷泉|钟楼|入口|校门/],
        ] as const;
        for (const [kw, re] of keywords) {
            if (re.test(bName) && re.test(text)) score += 6;
            if (kw === '教学楼' && /H\d{3,4}|S\d{3,4}|F\d{3,4}/.test(text) && re.test(bName)) score += 5;
        }
        if (!best || score > best.score) best = { b, score };
    }

    if (!best || best.score < 3) {
        // 退而求其次：只在 ActivityAddressAreaStr 是 "航空港校区" 的情况下给个默认中心
        return {};
    }

    const outline = best.b.outline;
    let lat = 0;
    let lon = 0;
    for (const p of outline) {
        lat += p[0];
        lon += p[1];
    }
    lat /= outline.length;
    lon /= outline.length;
    return {
        buildingId: best.b.id,
        buildingName: best.b.name || best.b.typeLabel,
        position: [lat, lon],
    };
}

/* ----------------------------------------------------------------
 * 五、最终：RawEkRow[] + buildings → SecondClassActivity[]
 *    并按时间过滤（只保留"相对现在"±180天内的数据，否则2900条会爆）
 * ---------------------------------------------------------------- */

/** 把原始行 → 前端契约；若给了 buildings 会做地点锚定 */
function rawRowToActivity(
    row: RawEkRow,
    buildings?: Building[]
): SecondClassActivity {
    const moduleCode = mapModule([row.ModuleCodeText, row.ActivityName, row.ActivityTypeText].join(' '));
    const moduleOpt = ACTIVITY_MODULE_DEFAULTS.find((m) => m.key === moduleCode);

    const activityLevel = mapLevel(row.ActivityLevelText);
    const levelOpt = activityLevel
        ? ACTIVITY_LEVEL_DEFAULTS.find((l) => l.key === activityLevel)
        : undefined;

    const [startTime, endTime] = splitRange(row.ActivityTime);
    const limitNumber = row.LimitStuNumber ? Number(row.LimitStuNumber) : undefined;
    const registeredCount = limitNumber ? Math.floor(limitNumber * (0.2 + Math.random() * 0.7)) : undefined;

    // 状态：按时间推导（不需要真实二课报名状态）
    const now = Date.now();
    const s = startTime?.getTime();
    const e = endTime?.getTime();
    let statusCode: '0' | '1' | '2' | '3' = '0';
    if (s && e) {
        if (now > e) statusCode = '3';        // 已结束 → 不可报名
        else if (now < s - 7 * 86400_000) statusCode = '0'; // 还有很久 → 可报名
        else if (now > s - 2 * 86400_000 && now < s) statusCode = Math.random() < 0.35 ? '1' : '0';
        else statusCode = Math.random() < 0.5 ? '1' : '0';
    }
    if (limitNumber && registeredCount && registeredCount >= limitNumber) statusCode = '3';

    const status = parseActivityStatusCode(statusCode);

    let anchor: AnchorResult = {};
    if (buildings && buildings.length) anchor = anchorActivityToBuilding(row, buildings);

    // 有经纬度字段则优先用
    let pos = anchor.position;
    if (row.latitude && row.longitude) {
        const latN = Number(row.latitude);
        const lonN = Number(row.longitude);
        if (Number.isFinite(latN) && Number.isFinite(lonN) && latN > 0 && lonN > 0) {
            pos = [latN, lonN];
        }
    }

    const insertT = row.InsertTime ? new Date(row.InsertTime).getTime() : undefined;
    const updateT = row.UpdateTime ? new Date(row.UpdateTime).getTime() : undefined;

    return {
        id: `act-${row.id}`,
        ektId: row.ektId ?? undefined,
        activityName: row.ActivityName ?? '（未命名活动）',
        activityTypeText: row.ActivityTypeText ?? undefined,
        moduleCode,
        moduleCodeText: row.ModuleCodeText ?? moduleOpt?.label,
        activityLevel,
        activityLevelText: row.ActivityLevelText ?? levelOpt?.label,
        addressAreaStr: row.ActivityAddressAreaStr ?? undefined,
        address: row.ActivityAddress ?? undefined,
        position: pos,
        locationId: anchor.buildingId,
        activityTimeText: row.ActivityTime ?? undefined,
        startTime: startTime?.toISOString(),
        endTime: endTime?.toISOString(),
        signInTimeText: row.ActivityQDDate ?? undefined,
        signOutTimeText: row.ActivityQTDate ?? undefined,
        needSignIn: yn(row.IsNeedSignInText),
        needSignOut: yn(row.IsNeedSignOutText),
        signInMethod: mapSignMethod(row.SignWayText),
        score: row.ActScore ?? undefined,
        limitNumber: Number.isFinite(limitNumber as number) ? limitNumber : undefined,
        registeredCount,
        needAudit: yn(row.IsSignExamText),
        needHomework: yn(row.IsHandInHomeWorkText),
        gradeLimit: row.GradeLimit ?? undefined,
        sexLimit: row.SexStr ?? undefined,
        collegeLimit: row.CollegeLimitStr ?? undefined,
        applyOrgName: row.ApplyOrgName ?? undefined,
        sponsorNames: row.SponsorNames ?? undefined,
        organizerNames: row.OrganizerNames ?? undefined,
        yearTerm: row.YearTerm ?? undefined,
        status,
        statusText: getActivityStatusText(status),
        introduction: row.ActivityIntroduction ?? undefined,
        posterUrl: undefined,
        tags: buildTags(row, moduleCode),
        coverRadiusMeters: row.CoverSock ? Number(row.CoverSock) : undefined,
        insertTime: Number.isFinite(insertT as number) ? insertT : undefined,
        updateTime: Number.isFinite(updateT as number) ? updateT : undefined,
    };
}

function buildTags(
    row: RawEkRow,
    _mod: SecondClassActivity['moduleCode']
): string[] {
    const t: string[] = [];
    if (row.ActScore) t.push(`${row.ActScore}学分`);
    if (yn(row.IsNeedSignInText)) t.push('签到');
    if (yn(row.IsNeedSignOutText)) t.push('签退');
    if (yn(row.IsLimitStuNumText)) t.push('名额有限');
    if (yn(row.IsSignExamText)) t.push('需审核');
    if (yn(row.IsHandInHomeWorkText)) t.push('交作业');
    return t;
}

/** 把整份 SQL 文本解析成 SecondClassActivity[]（锚定到 buildings + 按时间裁剪） */
export function sqlActivitiesToContract(
    sqlText: string,
    buildings: Building[],
    opts?: { windowDays?: number; maxCount?: number; preferArea?: string }
): SecondClassActivity[] {
    const rows = parseAllEkActivitiesFromSql(sqlText);
    const windowDays = opts?.windowDays ?? 365;
    const maxCount = opts?.maxCount ?? 400;
    const preferArea = opts?.preferArea ?? '航空港校区';
    const now = Date.now();
    const MIN_DT = now - windowDays * 86400_000;
    const MAX_DT = now + windowDays * 86400_000;

    const activities = rows
        .map((r) => rawRowToActivity(r, buildings))
        // 优先匹配指定校区
        .sort((a, b) => {
            const as = (a.addressAreaStr ?? '').includes(preferArea) ? 1 : 0;
            const bs = (b.addressAreaStr ?? '').includes(preferArea) ? 1 : 0;
            if (as !== bs) return bs - as;
            // 其次按锚定到建筑的优先
            const al = a.locationId ? 1 : 0;
            const bl = b.locationId ? 1 : 0;
            if (al !== bl) return bl - al;
            // 最后按结束时间越近越优先
            const at = a.endTime ? new Date(a.endTime).getTime() : 0;
            const bt = b.endTime ? new Date(b.endTime).getTime() : 0;
            return Math.abs(bt - now) - Math.abs(at - now);
        })
        .filter((a) => {
            const t = a.endTime ? new Date(a.endTime).getTime() : a.updateTime ?? 0;
            if (t < MIN_DT || t > MAX_DT) {
                const inArea = (a.addressAreaStr ?? '').includes(preferArea);
                const hasLoc = a.locationId ? 1 : 0;
                return Boolean(inArea && hasLoc) ? Math.random() < 0.25 : false;
            }
            return true;
        })
        .slice(0, maxCount);

    return activities;
}
