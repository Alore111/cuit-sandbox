/* ================================================================
   校园实况 Mock 数据生成器
   —— 可行性测试阶段使用：基于学校配置和建筑数据生成合理的实况数据。
      后期对接 backend_core 时，此文件可被真实 API 层直接替换。

   数据源优先级：
     1. 若 public/data/ct_ek_activities.sql.txt 存在（真实SQL dump），
        用 ekSqlAdapter 解析出真实活动 → 再据此派生事件与热度。
     2. 否则使用模板生成的纯假数据。
================================================================ */

import type {
    CampusEvent,
    CampusLiveSnapshot,
    HeatSummary,
    LocationHeat,
    SecondClassActivity,
    Building,
    MapDataset,
    EventSeverity,
    EventCategory,
    EventStatus,
} from '../contract';
import {
    EVENT_CATEGORY_DEFAULTS,
    EVENT_SEVERITY_DEFAULTS,
    ACTIVITY_MODULE_DEFAULTS,
    ACTIVITY_LEVEL_DEFAULTS,
    getHeatLevel,
    parseActivityStatusCode,
    getActivityStatusText,
} from '../contract';
import { sqlActivitiesToContract } from './ekSqlAdapter';

function rand(min: number, max: number): number {
    return Math.random() * (max - min) + min;
}

function pickOne<T>(arr: readonly T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}

function pickMany<T>(arr: readonly T[], min = 1, max = 3): T[] {
    const n = Math.floor(rand(min, Math.min(max, arr.length) + 1));
    const copy = [...arr];
    const out: T[] = [];
    for (let i = 0; i < n && copy.length; i++) {
        const idx = Math.floor(Math.random() * copy.length);
        out.push(copy.splice(idx, 1)[0]);
    }
    return out;
}

function hashSeed(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h;
}

function seededRand(seed: number, salt = 0): number {
    const x = Math.sin(seed * 9999 + salt * 137) * 43758.5453;
    return x - Math.floor(x);
}

function getBuildingCenter(b: Building): [number, number] {
    if (!b.outline || b.outline.length === 0) return [0, 0];
    let lat = 0;
    let lon = 0;
    for (const p of b.outline) { lat += p[0]; lon += p[1]; }
    return [lat / b.outline.length, lon / b.outline.length];
}

let _cachedActivities: SecondClassActivity[] | null = null;
let _sqlLoadTried = false;

async function tryLoadSqlActivities(buildings: Building[]): Promise<SecondClassActivity[] | null> {
    if (_sqlLoadTried) return _cachedActivities;
    _sqlLoadTried = true;
    try {
        const res = await fetch('/data/ct_ek_activities.sql.txt');
        if (!res.ok) return null;
        const text = await res.text();
        if (!text || text.length < 1024) return null;
        const arr = sqlActivitiesToContract(text, buildings, {
            windowDays: 500,
            maxCount: 220,
            preferArea: '航空港校区',
        });
        if (arr.length === 0) return null;
        _cachedActivities = arr;
        return arr;
    } catch {
        return null;
    }
}

const HOT_KEYWORDS: RegExp[] = [
    /体育馆|体育场|田径|篮球|足球|游泳馆|球馆/i,
    /图书馆|书院|自习|阅读|阅览室|资料馆/i,
    /食堂|餐厅|饭堂|美食|广场|商业街|超市|购物中心/i,
    /教学楼|实验楼|科研|讲堂|报告|学术交流|会议中心/i,
    /宿舍|公寓|住宿|生活区|学生之家/i,
];

function generateHeatList(
    buildings: Building[],
    activities: SecondClassActivity[]
): LocationHeat[] {
    const result: LocationHeat[] = [];
    const now = Date.now();
    const actByLoc = new Map<string, { count: number; people: number }>();
    for (const a of activities) {
        if (!a.locationId) continue;
        const prev = actByLoc.get(a.locationId) ?? { count: 0, people: 0 };
        prev.count += 1;
        prev.people += a.registeredCount ?? 30;
        actByLoc.set(a.locationId, prev);
    }

    let idx = 0;
    for (const b of buildings) {
        const seed = hashSeed(b.id);
        const coverageChance = seededRand(seed, 1);
        const forced = actByLoc.has(b.id);
        if (!forced && coverageChance < 0.6) continue;

        let base = 10 + seededRand(seed, 2) * 28;
        for (const re of HOT_KEYWORDS) {
            if (re.test(b.name || '') || re.test(b.typeLabel || '')) {
                base = 45 + seededRand(seed, 3) * 48;
                break;
            }
        }
        const extra = actByLoc.get(b.id);
        if (extra) base += Math.min(35, 10 * extra.count + Math.log10(1 + extra.people) * 4);

        const heatValue = Math.max(0, Math.min(100, Math.round(base + (Math.random() - 0.5) * 12)));
        const heatLevel = getHeatLevel(heatValue);
        const center = getBuildingCenter(b);
        const peopleBase = extra
            ? extra.people
            : heatValue < 40 ? heatValue * 2 : heatValue < 70 ? 80 + (heatValue - 40) * 5 : 230 + (heatValue - 70) * 8;
        const relatedEventIds = heatLevel === 'critical' || heatLevel === 'high' ? [`evt-${b.id}-0`] : [];

        result.push({
            id: `heat-${b.id}`,
            locationId: b.id,
            locationName: b.name || b.typeLabel || `地点 ${idx}`,
            position: [center[0], center[1]],
            heatValue,
            heatLevel,
            sourceType: extra
                ? pickOne(['composite', 'activity_count', 'check_in_count'] as const)
                : pickOne(['people_count', 'composite', 'check_in_count'] as const),
            peopleCount: Math.round(peopleBase + (Math.random() - 0.5) * peopleBase * 0.2),
            heightRatio: Math.max(0.15, Math.min(1, heatValue / 100)),
            relatedEventIds,
            updatedAt: now - Math.floor(Math.random() * 60 * 1000),
        });
        idx++;
    }

    const extras = Math.floor(rand(3, 6));
    for (let i = 0; i < extras; i++) {
        const lat = 30.5842 + (Math.random() - 0.5) * 0.005;
        const lon = 103.9855 + (Math.random() - 0.5) * 0.006;
        const heatValue = Math.floor(rand(50, 92));
        result.push({
            id: `heat-virtual-${i}`,
            locationId: `virtual-${i}`,
            locationName: pickOne([
                '中心广场', '东门入口', '喷泉广场', '钟楼草坪',
                '银杏大道', '樱花小径', '星空剧场',
            ]),
            position: [lat, lon],
            heatValue,
            heatLevel: getHeatLevel(heatValue),
            sourceType: 'composite',
            peopleCount: Math.round(80 + Math.random() * 260),
            heightRatio: Math.max(0.3, heatValue / 100),
            relatedEventIds: [],
            updatedAt: now - Math.floor(Math.random() * 120 * 1000),
        });
    }
    return result;
}

function summarizeHeat(heatList: LocationHeat[]): HeatSummary {
    let critical = 0;
    let high = 0;
    let medium = 0;
    let low = 0;
    let sum = 0;
    for (const h of heatList) {
        sum += h.heatValue;
        if (h.heatLevel === 'critical') critical++;
        else if (h.heatLevel === 'high') high++;
        else if (h.heatLevel === 'medium') medium++;
        else low++;
    }
    return {
        totalHotSpots: heatList.length,
        criticalCount: critical,
        highCount: high,
        mediumCount: medium,
        lowCount: low,
        campusAvgHeat: heatList.length ? Math.round((sum / heatList.length) * 10) / 10 : 0,
        updatedAt: Date.now(),
    };
}

const EVENT_TEMPLATES: Array<Pick<CampusEvent, 'title' | 'description' | 'category' | 'severity'>> = [
    { title: '「智能时代的新质生产力」主题讲座', description: '中国科学院院士主讲，探讨人工智能与实体经济深度融合。', category: 'lecture', severity: 'special' },
    { title: '2026 春季校运会开幕式', description: '全校师生齐聚田径场，开幕式方阵 + 文艺演出 + 火炬传递。', category: 'sports', severity: 'urgent' },
    { title: '图书馆阅读马拉松活动', description: '连续 12 小时沉浸式阅读挑战，赢取限定周边。', category: 'promotion', severity: 'info' },
    { title: '食堂二楼新餐品试吃会', description: '川湘粤鲁四大菜系新菜品免费试吃。', category: 'festival', severity: 'warning' },
    { title: '数据中心例行维护通知', description: '今日 02:00-05:00 校园网、VPN、选课系统将短暂中断。', category: 'maintenance', severity: 'warning' },
    { title: '校园歌手大赛总决赛', description: '16 强选手巅峰对决，百人大合唱 + 神秘嘉宾空降。', category: 'performance', severity: 'urgent' },
    { title: 'ACM 程序设计校赛现场', description: '5 小时算法鏖战，晋级选手直通省赛。', category: 'competition', severity: 'warning' },
    { title: '迎新社团招新市集', description: '百团大战火热进行中，现场体验无人机、汉服、机器人社团。', category: 'promotion', severity: 'info' },
    { title: '暴雨天气安全提醒', description: '预计未来 3 小时有强降雨，低洼地带同学注意转移。', category: 'emergency', severity: 'urgent' },
    { title: '艺术设计学院毕业展', description: '涵盖视觉传达、环艺、数字媒体三大方向的优秀毕业设计。', category: 'festival', severity: 'info' },
    { title: '创新创业路演日', description: '30+ 创业项目现场路演，对接天使投资与校企合作。', category: 'competition', severity: 'special' },
];

function activityModuleToEventCategory(mod: SecondClassActivity['moduleCode']): EventCategory {
    switch (mod) {
        case 'academic': return 'lecture';
        case 'innovation': return 'competition';
        case 'art': return 'performance';
        case 'sports': return 'sports';
        case 'practice': return 'meeting';
        case 'volunteer': return 'promotion';
        case 'thought': return 'meeting';
        case 'skill': return 'lecture';
        default: return 'other';
    }
}

function activityLevelToSeverity(lvl?: SecondClassActivity['activityLevel']): EventSeverity {
    switch (lvl) {
        case 'national': return 'special';
        case 'provincial': return 'urgent';
        case 'municipal': return 'warning';
        case 'school': return 'info';
        default: return 'info';
    }
}

function generateEvents(
    heatList: LocationHeat[],
    buildings: Building[],
    activities: SecondClassActivity[]
): CampusEvent[] {
    const result: CampusEvent[] = [];
    const now = Date.now();

    const candidates = [...activities]
        .filter((a) => a.locationId && a.position)
        .sort((x, y) => {
            const rank = (a: SecondClassActivity['activityLevel'] | undefined) =>
                a === 'national' ? 6 : a === 'provincial' ? 5 : a === 'municipal' ? 4 : a === 'school' ? 3 : a === 'college' ? 2 : 1;
            return rank(y.activityLevel) - rank(x.activityLevel);
        })
        .slice(0, 12);

    for (let i = 0; i < candidates.length; i++) {
        const a = candidates[i];
        const start = a.startTime ? new Date(a.startTime).getTime() : now + rand(0, 2 * 86400_000);
        const end = a.endTime ? new Date(a.endTime).getTime() : start + rand(1, 4) * 3600_000;
        const status: EventStatus = now < start ? 'upcoming' : now <= end ? 'ongoing' : 'ended';
        result.push({
            id: `evt-act-${a.id}`,
            title: a.activityName,
            description: (a.introduction?.slice(0, 78) ?? '') + (a.introduction && a.introduction.length > 78 ? '…' : '') ||
                `${a.activityLevelText ?? ''}${a.applyOrgName ? ' · ' + a.applyOrgName : ''}`,
            category: activityModuleToEventCategory(a.moduleCode),
            severity: activityLevelToSeverity(a.activityLevel),
            status,
            locationId: a.locationId,
            locationName: [a.address, a.addressAreaStr].filter(Boolean).join(' · ') ||
                buildings.find((b) => b.id === a.locationId)?.name || undefined,
            position: a.position,
            startTime: a.startTime ?? new Date(start).toISOString(),
            endTime: a.endTime ?? new Date(end).toISOString(),
            organizer: a.applyOrgName ?? a.sponsorNames ?? a.organizerNames,
            participantCount: a.registeredCount,
            tags: a.tags ?? [],
            relatedActivityId: a.id,
            createdAt: a.insertTime ?? now - 86400_000,
            updatedAt: a.updateTime ?? now,
        });
    }

    const targetMin = 8;
    if (result.length < targetMin) {
        const hot = [...heatList]
            .filter((h) => h.heatLevel === 'critical' || h.heatLevel === 'high' || Math.random() < 0.25)
            .sort((a, b) => b.heatValue - a.heatValue);
        let tplIdx = 0;
        for (const h of hot) {
            if (result.length >= targetMin + 4) break;
            const tpl = EVENT_TEMPLATES[tplIdx++ % EVENT_TEMPLATES.length];
            const start = new Date(now + rand(-45 * 60 * 1000, 2 * 60 * 60 * 1000));
            const end = new Date(start.getTime() + rand(30 * 60 * 1000, 3 * 60 * 60 * 1000));
            const status: EventStatus = now < start.getTime() ? 'upcoming' : now <= end.getTime() ? 'ongoing' : 'ended';
            result.push({
                id: `evt-${h.locationId}-${tplIdx}`,
                title: tpl.title,
                description: tpl.description,
                category: tpl.category,
                severity: tpl.severity,
                status,
                locationId: h.locationId,
                locationName: h.locationName,
                position: h.position,
                startTime: start.toISOString(),
                endTime: end.toISOString(),
                organizer: pickOne([
                    '校团委', '学生会', '创新创业学院', '图书馆',
                    '体育部', '后勤处', '艺术学院', '信息中心', '学工部',
                ]),
                participantCount: Math.floor(rand(30, 600)),
                tags: pickMany(['免费', '需预约', '现场签到', '学分认证', '抽奖', '提供餐食', '直播'] as const, 0, 3),
                createdAt: now - Math.floor(Math.random() * 5 * 24 * 60 * 60 * 1000),
                updatedAt: now - Math.floor(Math.random() * 60 * 60 * 1000),
            });
        }
    }
    return result;
}

const ACTIVITY_NAME_TEMPLATES: Array<[string, SecondClassActivity['moduleCode'], SecondClassActivity['activityLevel']]> = [
    ['青春向党·逐梦征程', 'thought', 'school'],
    ['社区敬老志愿服务日', 'volunteer', 'college'],
    ['高等数学期末冲刺训练营', 'academic', 'school'],
    ['互联网+创新创业沙龙', 'innovation', 'national'],
    ['校园民谣吉他弹唱会', 'art', 'club'],
    ['趣味运动会·定向越野', 'sports', 'school'],
    ['乡村振兴暑期实践招募', 'practice', 'provincial'],
    ['AI 大模型应用开发 Workshop', 'skill', 'municipal'],
    ['英语四六级真题精讲', 'academic', 'college'],
    ['非遗文化进校园·扎染体验', 'art', 'school'],
    ['献血车进校园·爱心公益', 'volunteer', 'school'],
    ['辩论赛·新生杯决赛', 'academic', 'school'],
    ['职场礼仪与简历制作', 'skill', 'college'],
    ['无人机航拍实操入门', 'skill', 'club'],
    ['数学建模竞赛经验分享', 'innovation', 'national'],
];

function generateFallbackActivities(
    events: CampusEvent[],
    buildings: Building[]
): SecondClassActivity[] {
    const result: SecondClassActivity[] = [];
    const now = Date.now();
    const bindEventIds = pickMany(events.map((e) => e.id), Math.max(2, Math.floor(events.length * 0.55)), events.length);

    for (let i = 0; i < bindEventIds.length + 2; i++) {
        const tpl = ACTIVITY_NAME_TEMPLATES[i % ACTIVITY_NAME_TEMPLATES.length];
        const module = tpl[1];
        const level = tpl[2];
        const evt = bindEventIds[i] ? events.find((e) => e.id === bindEventIds[i]) : null;
        const b = buildings[Math.floor(Math.random() * buildings.length)];
        const center = getBuildingCenter(b);
        const startTime = new Date(now + (evt ? 0 : rand(0, 4 * 24 * 60 * 60 * 1000)));
        const endTime = new Date(startTime.getTime() + rand(1 * 60 * 60 * 1000, 6 * 60 * 60 * 1000));
        const statusCode = String(Math.floor(Math.random() * 4)) as '0' | '1' | '2' | '3';
        const limitNumber = Math.floor(rand(30, 300));
        const status = parseActivityStatusCode(statusCode);

        result.push({
            id: `act-${i}-${Math.floor(Math.random() * 1e6)}`,
            ektId: `EKT${String(100000 + Math.floor(Math.random() * 899999))}`,
            activityName: tpl[0],
            activityTypeText: pickOne(['文体活动', '实践教学', '志愿服务', '创新创业', '技能培训']),
            moduleCode: module,
            moduleCodeText: ACTIVITY_MODULE_DEFAULTS.find((m) => m.key === module)?.label,
            activityLevel: level,
            activityLevelText: ACTIVITY_LEVEL_DEFAULTS.find((l) => l.key === level)?.label,
            addressAreaStr: evt?.locationName ?? b.name ?? '航空港校区',
            address: (() => {
                const base = pickOne(['201 报告厅', '多功能厅', '主会场', '三楼会议室']);
                if (evt?.locationName) return evt.locationName;
                return b.name ? `${b.name}${base}` : '航空港校区中心广场';
            })(),
            position: evt?.position ?? [center[0], center[1]],
            locationId: evt?.locationId ?? b.id,
            activityTimeText: `${startTime.getMonth() + 1}月${startTime.getDate()}日 ${String(startTime.getHours()).padStart(2, '0')}:${String(startTime.getMinutes()).padStart(2, '0')} - ${String(endTime.getHours()).padStart(2, '0')}:${String(endTime.getMinutes()).padStart(2, '0')}`,
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            signInTimeText: '活动开始前 30 分钟',
            signOutTimeText: '活动结束后 30 分钟内',
            needSignIn: Math.random() < 0.85,
            needSignOut: Math.random() < 0.5,
            signInMethod: pickOne(['geo', 'qr', 'photo', 'captcha', 'combo', 'none'] as const),
            score: pickOne(['0.2', '0.3', '0.5', '0.8', '1.0', '1.5']),
            limitNumber,
            registeredCount: status === 'unavailable' ? limitNumber : Math.floor(limitNumber * rand(0.15, 0.95)),
            needAudit: Math.random() < 0.35,
            needHomework: Math.random() < 0.2,
            gradeLimit: pickOne(['不限', '2023级及以上', '2024级新生', '2022-2024级', '不限']),
            sexLimit: pickOne(['不限', '不限', '不限', '男女各半']),
            collegeLimit: pickOne(['不限', '不限', '信息与通信工程学院', '计算机学院', '全校各学院']),
            applyOrgName: pickOne([
                '共青团成都信息工程大学委员会',
                '校学生会学术科技部',
                '青年志愿者协会',
                '创新创业学院',
                '体育部',
                '文化艺术中心',
                '学生社团联合会',
            ]),
            sponsorNames: pickOne(['校团委 学生处', '教务处 创新创业学院', '后勤处 校医院', '图书馆 信息化建设处']),
            organizerNames: pickOne(['学生会', '研究生会', '青年志愿者协会', '社团联合会']),
            yearTerm: '2025-2026-2',
            status,
            statusText: getActivityStatusText(status),
            introduction: `${tpl[0]}活动旨在丰富同学们的课余生活，提升综合素养。`,
            tags: pickMany(['第二课堂学分', '现场签到', '提供证书', '名额有限', '精彩礼品'] as const, 0, 4),
            coverRadiusMeters: Math.floor(rand(50, 200)),
            insertTime: now - Math.floor(Math.random() * 10 * 24 * 60 * 60 * 1000),
            updateTime: now - Math.floor(Math.random() * 3 * 60 * 60 * 1000),
        });
    }
    return result;
}

export async function generateMockCampusLiveSnapshot(dataset: MapDataset): Promise<CampusLiveSnapshot> {
    const { buildings } = dataset;
    let activities: SecondClassActivity[] = (await tryLoadSqlActivities(buildings)) ?? [];
    const usingRealData = activities.length > 0;
    // #region debug-point mock-sql-check
    console.error('[DBG][campus-live-ui-glitch] MOCK_SQL_CHECK', {
        usingRealData,
        activitiesCount: activities.length,
        firstThreeNames: activities.slice(0, 3).map((a) => a.activityName),
    });
    // #endregion
    const heatList = generateHeatList(buildings, activities);
    const heatSummary = summarizeHeat(heatList);
    const events = generateEvents(heatList, buildings, activities);
    if (!usingRealData) activities = generateFallbackActivities(events, buildings);

    return {
        version: usingRealData ? 'real-sql-v1.0' : 'mock-v1.0',
        snapshotAt: Date.now(),
        heatList,
        heatSummary,
        events,
        activities,
        eventCategoryDict: EVENT_CATEGORY_DEFAULTS,
        eventSeverityDict: EVENT_SEVERITY_DEFAULTS,
        activityModuleDict: ACTIVITY_MODULE_DEFAULTS,
        activityLevelDict: ACTIVITY_LEVEL_DEFAULTS,
    };
}
