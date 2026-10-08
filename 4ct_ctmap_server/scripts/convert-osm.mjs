/*
 * ================================================================
 * 一次性数据转换脚本（不是运行时依赖）
 * ================================================================
 * 把 DEMO 的 data/campus-osm.js 转成本项目的 JSON 契约：
 *   data/school.json     学校与网格配置（边界来自 OSM）
 *   data/buildings.json  建筑（只留轮廓与身份，类型/层数交给类型字典）
 *   data/parcels.json    地皮（OSM 场地矢量 → 地皮类型）
 *
 * 为什么要有它：OSM 产物里有近百条建筑与六十多条场地矢量，
 * 手抄一遍必然出错；转换一次之后，JSON 就是唯一真源，后续人工维护。
 *
 * 用法：在本包目录（4ct_ctmap_server）下执行 node scripts/convert-osm.mjs
 *
 * 为什么放在后端包里：它产出的是后端 data/ 下的那一份数据，后端是数据的唯一持有者；
 * 放在前端包里会让前端脚本去写另一个项目的目录，前后端分离就白做了。
 * ================================================================
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根：4ct_map/4ct_ctmap_server/scripts → 4ct */
const repoRoot = path.resolve(scriptDir, '../../..');
const DEMO_DATA = path.join(
    repoRoot,
    '4ct_frontend_pc/frontend-web/cuit-voxel-twin/data/campus-osm.js'
);
/** 补充抓取的 OSM 响应（道路与自然地表）：DEMO 当年只抓了建筑与场地矢量 */
const EXTRA_OSM = path.join(scriptDir, 'osm-extract/campus-extra.json');
/** 数据落在本包 data/ 下：后端是数据的唯一持有者 */
const OUT_DIR = path.resolve(scriptDir, '../data');

/* ----------------------------------------------------------------
   人工拟定的字段（DEMO 里散落在源码各处，这里落成数据）
---------------------------------------------------------------- */

const SCHOOL_META = {
    id: 'cuit-renmin',
    name: '成都信息工程大学',
    campusName: '航空港校区',
    shortName: '成信大',
    brandMark: '信',
    title: '成都信息工程大学 · 微校园沙盘',
    subtitle: 'CUIT VOXEL SANDTABLE',
    voxelMeters: 2,
    gridPaddingMeters: 6,
    defaultTerrainTypeKey: 'grass',
    attribution: '平面轮廓与名称来自 OpenStreetMap（ODbL 1.0 - © OpenStreetMap contributors）',
    heightNote:
        '本项目建筑高度无实测来源，按建筑类型经验层数表推定，仅供形制参考。'
};

/* ----------------------------------------------------------------
   OSM 场地要素 → 地皮类型
   —— 映射表与 DEMO 的 resolveFeatureClass() 完全一致，
      只是结果由「体素类别编号」换成了「地皮类型 key」。
---------------------------------------------------------------- */

const LEISURE_CLASS = {
    track: 'track',
    /* pitch 不带 sport 标签时按草地处理：校园里这类多边形多是田径场内场、足球场 */
    pitch: 'grass',
    swimming_pool: 'water',
    bleachers: 'pave',
    fitness_station: 'pave',
    garden: 'grass',
    park: 'grass',
    /* sports_hall 是建筑，地面归属交给建筑流程，这里不覆盖 */
    sports_hall: null
};

const LANDUSE_CLASS = {
    grass: 'grass',
    flowerbed: 'grass',
    farmland: 'bare',
    brownfield: 'bare',
    military: 'bare'
};

/** 球类场地（丙烯硬地）与草地场地（足球、跑道内场）的分野 */
const SPORT_COURT = new Set([
    'basketball', 'tennis', 'volleyball', 'badminton', 'table_tennis',
    'multi', 'handball', 'futsal', 'squash'
]);
const SPORT_GRASS = new Set(['soccer', 'running', 'athletics']);

/**
 * 顺序很关键：跑道本体是塑胶面，必须优先于「sport=running 属于田径场」的草地判定。
 * @returns {string|null} 地皮类型 key；null 表示该要素不转成地皮
 */
function resolveParcelType({ leisure, sport, landuse }) {
    if (leisure === 'track') return 'track';
    if (sport && SPORT_GRASS.has(sport)) return 'grass';
    if (sport && SPORT_COURT.has(sport)) return 'court';

    if (leisure && leisure in LEISURE_CLASS) return LEISURE_CLASS[leisure];
    if (landuse && landuse in LANDUSE_CLASS) return LANDUSE_CLASS[landuse];
    return null;
}

/* ----------------------------------------------------------------
   天桥示例
   —— OSM 里没有独立的天桥要素，这条是人工录入的示例轮廓（第一/第三教学楼之间的连廊位置），
      真实位置与尺寸请按实际情况替换或删除。
---------------------------------------------------------------- */

const SKYWALK_SAMPLE = {
    id: 'manual-skywalk-1',
    name: '人行天桥（示例）',
    source: 'manual',
    typeKey: 'skywalk',
    outline: [
        [30.58303, 103.98562],
        [30.58307, 103.98562],
        [30.58307, 103.98604],
        [30.58303, 103.98604]
    ]
};

/* ----------------------------------------------------------------
   道路与自然地表 → 地皮类型
   —— 这两类 DEMO 当年没抓（道路靠影像分类凑出来），
      但 OSM 对它们有精确矢量，因此改为直接抓取。
---------------------------------------------------------------- */

/**
 * 道路：OSM 的 highway 是**折线**（没有宽度），必须按典型宽度缓冲成多边形才能铺成地皮。
 * 校园里车行/混行路按水泥路铺，步行道按铺装广场铺，城市干道按沥青铺。
 */
const HIGHWAY_CLASS = {
    tertiary: { type: 'concreteRoad', widthMeters: 9 },
    unclassified: { type: 'concreteRoad', widthMeters: 7 },
    residential: { type: 'concreteRoad', widthMeters: 7 },
    living_street: { type: 'concreteRoad', widthMeters: 6 },
    service: { type: 'concreteRoad', widthMeters: 6 },
    pedestrian: { type: 'pave', widthMeters: 8 },
    steps: { type: 'pave', widthMeters: 2.4 },
    footway: { type: 'pave', widthMeters: 2.4 },
    path: { type: 'pave', widthMeters: 2 },
    cycleway: { type: 'pave', widthMeters: 3 },
    secondary: { type: 'asphalt', widthMeters: 12 },
    primary: { type: 'asphalt', widthMeters: 14 },
    trunk: { type: 'asphalt', widthMeters: 16 }
};

/** 自然地表：只接面积要素（林地与水体），线状要素另行处理 */
const NATURAL_CLASS = {
    wood: 'grove',
    tree_row: 'grove',
    scrub: 'grove',
    water: 'water',
    wetland: 'water',
    grassland: 'grass',
    sand: 'bare',
    bare_rock: 'bare',
    scree: 'bare'
};

const FOREST_LANDUSE_CLASS = {
    forest: 'grove',
    orchard: 'grove',
    meadow: 'grass'
};

const METERS_PER_DEG_LAT = 111320;

function metersPerDegLon(lat) {
    return METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

/**
 * 折线 → 多边形：按半宽在两侧各偏移一条，再首尾相接。
 * 每个顶点的法线取相邻两段的平均（简单斜接）；道路折线不会自交，因此不做自交检测。
 * @param {[number, number][]} points [[lat, lon], ...]
 * @param {number} widthMeters 道路总宽（米）
 */
function bufferLine(points, widthMeters) {
    if (points.length < 2) return null;

    const [lat0, lon0] = points[0];
    const kx = metersPerDegLon(lat0);
    const toLocal = ([lat, lon]) => [(lon - lon0) * kx, (lat - lat0) * METERS_PER_DEG_LAT];
    const toLatLon = ([x, y]) => [lat0 + y / METERS_PER_DEG_LAT, lon0 + x / kx];

    const local = points.map(toLocal);
    const half = widthMeters / 2;

    const normals = local.map((point, index) => {
        let nx = 0;
        let ny = 0;

        if (index > 0) {
            const dx = point[0] - local[index - 1][0];
            const dy = point[1] - local[index - 1][1];
            const length = Math.hypot(dx, dy) || 1;
            nx += -dy / length;
            ny += dx / length;
        }
        if (index < local.length - 1) {
            const dx = local[index + 1][0] - point[0];
            const dy = local[index + 1][1] - point[1];
            const length = Math.hypot(dx, dy) || 1;
            nx += -dy / length;
            ny += dx / length;
        }

        const length = Math.hypot(nx, ny) || 1;
        return [nx / length, ny / length];
    });

    const left = local.map(([x, y], index) =>
        toLatLon([x + normals[index][0] * half, y + normals[index][1] * half])
    );
    const right = local.map(([x, y], index) =>
        toLatLon([x - normals[index][0] * half, y - normals[index][1] * half])
    );

    return [...left, ...right.reverse()];
}

/* ----------------------------------------------------------------
   编制范围：只保留重心落在校园边界内的要素
   —— 抓取范围为了不漏掉贴墙的楼向外扩了 120m，校外那些民房、超市、艺术馆
      都落在沙盘板之外。数据要描述的是「这个学校」，因此在转换这一步就剔掉，
      而不是留给渲染层每帧去丢弃并报一堆告警。
---------------------------------------------------------------- */

/** 射线法：经纬度点是否在多边形内（校园尺度下直接在经纬度空间判断足够） */
function isInsidePolygon(lat, lon, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [latI, lonI] = polygon[i];
        const [latJ, lonJ] = polygon[j];
        if ((latI > lat) !== (latJ > lat) && lon < ((lonJ - lonI) * (lat - latI)) / (latJ - latI) + lonI) {
            inside = !inside;
        }
    }
    return inside;
}

/** 顶点均值近似重心 */
function centroidOf(points) {
    const lat = points.reduce((sum, point) => sum + point[0], 0) / points.length;
    const lon = points.reduce((sum, point) => sum + point[1], 0) / points.length;
    return [lat, lon];
}

/* ----------------------------------------------------------------
   悬空小岛（二期）
   —— 岛面轮廓 = 校园边界向**外**做确定性扰动：最窄处也仍在边界之外，
      于是校园外圈自然留出一条草地缘，可以摆树丛、亭塔。
      轮廓一次生成后落地到 school.json，渲染层只读不算：
      每次打开形状必须完全一致，不允许运行时随机。
---------------------------------------------------------------- */

const ISLAND = {
    /** 扰动基准幅度（米）；实际偏移在 noiseMeters × (1 - Σamp) 与 noiseMeters 之间摆动 */
    noiseMeters: 55,
    /** 两层不同频率的正弦：低频给「不规则大轮廓」，高频给细碎起伏 */
    waves: [
        { freq: 2.5, amp: 0.34, phase: 0.7 },
        { freq: 6, amp: 0.14, phase: 2.1 }
    ],
    /** 边界重采样间距（米）：扰动要有均匀的空间频率，就必须先等距重采样 */
    resampleMeters: 14,
    /** 倒锥岩层（自上而下），总厚度即倒锥深度。
        岛面跨度 1.2 km，倒锥要与之相称才看得出「倒锥」—— 400 m 约为短边的 1/2。
        表土只给 30 m：再厚就会把下面的岩层整段遮住，读起来像一块土方而不是悬空的岛。 */
    rockLayers: [
        { thicknessMeters: 30, paletteKey: 'soil' },
        { thicknessMeters: 120, paletteKey: 'rock' },
        { thicknessMeters: 250, paletteKey: 'rockDeep' }
    ],
    /** 岛缘小建筑：沿轮廓均布几座，自岛缘向内缩这么多米（仍在岛面内） */
    rimPropCount: 8,
    rimPropInsetMeters: 18,
    /** 岛下碎岩：落在**岛面轮廓之内、倒锥之外**的空隙里 */
    debrisCount: 14,
    /** 垂深取倒锥深度的这个比例区间（要够深，倒锥才收得够窄、让出位置） */
    debrisDepthRatio: [0.4, 0.9],
    debrisSizeMeters: [10, 26],
    /** 碎岩与倒锥表面之间留的余量（米）：要盖得住最大岩块的一半边长 */
    debrisClearanceMeters: 40
};

/** 倒锥剖面指数：必须与前端 src/render/constants.ts 的 ISLAND_CONE_EXPONENT 一致 */
const ISLAND_CONE_EXPONENT = 2;

/** mulberry32：碎岩尺寸这类小抖动用它，保证每次生成结果一致 */
function seededRandom(seed) {
    let t = seed >>> 0;
    return function next() {
        t += 0x6d2b79f5;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

/** 多边形有向面积：判断顶点是逆时针还是顺时针，决定外法线朝哪边 */
function signedArea(points) {
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
        const [x0, y0] = points[i];
        const [x1, y1] = points[(i + 1) % points.length];
        sum += x0 * y1 - x1 * y0;
    }
    return sum / 2;
}

/** 去掉闭合重复点，并转到以首点为原点的本地米坐标 */
function toLocalRing(boundary) {
    const ring = boundary.slice();
    const [fLat, fLon] = ring[0];
    const [lLat, lLon] = ring[ring.length - 1];
    if (fLat === lLat && fLon === lLon) ring.pop();

    const kx = metersPerDegLon(ring[0][0]);
    const toLocal = ([lat, lon]) => [(lon - ring[0][1]) * kx, (lat - ring[0][0]) * METERS_PER_DEG_LAT];
    const toLatLon = ([x, y]) => [ring[0][0] + y / METERS_PER_DEG_LAT, ring[0][1] + x / kx];
    return { ring, kx, toLocal, toLatLon, local: ring.map(toLocal) };
}

/** 沿轮廓等距重采样：保证扰动的空间频率与「米」一致，而不是与顶点密度绑在一起 */
function resampleRing(local, spacingMeters) {
    const out = [];
    for (let i = 0; i < local.length; i++) {
        const a = local[i];
        const b = local[(i + 1) % local.length];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const steps = Math.max(1, Math.round(Math.hypot(dx, dy) / spacingMeters));
        for (let s = 0; s < steps; s++) {
            out.push([a[0] + (dx * s) / steps, a[1] + (dy * s) / steps]);
        }
    }
    return out;
}

/** 顶点均值近似重心（经纬度空间，仅用于碎岩布点） */
function centroidOfLocal(points) {
    const x = points.reduce((sum, p) => sum + p[0], 0) / points.length;
    const y = points.reduce((sum, p) => sum + p[1], 0) / points.length;
    return [x, y];
}

/** 从重心沿 dir 射出去，求与多边形边界最近的正向交点距离（碎岩要落在岛面之外） */
function rayRadiusFromCentroid(centroid, dir, polygon) {
    let best = Infinity;
    for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i];
        const b = polygon[(i + 1) % polygon.length];
        const ex = b[0] - a[0];
        const ey = b[1] - a[1];
        const denom = dir[0] * ey - dir[1] * ex;
        if (Math.abs(denom) < 1e-9) continue;
        const wx = a[0] - centroid[0];
        const wy = a[1] - centroid[1];
        const t = (wx * ey - wy * ex) / denom;
        const u = (wx * dir[1] - wy * dir[0]) / denom;
        if (t > 0 && u >= 0 && u <= 1 && t < best) best = t;
    }
    return Number.isFinite(best) ? best : 0;
}

/**
 * 由校园边界生成整段 island 数据。
 * @param {[number, number][]} boundary 校园边界 [lat, lon]
 */
function buildIsland(boundary) {
    const { toLocal, toLatLon, local } = toLocalRing(boundary);
    const resampled = resampleRing(local, ISLAND.resampleMeters);

    /* 外法线：多边形逆时针时 (dy, -dx) 指向外侧 */
    const flip = signedArea(resampled) >= 0 ? 1 : -1;
    const flat = ISLAND.waves.reduce((sum, wave) => sum + wave.amp, 0);
    const total = resampled.length;

    /** 轮廓上第 index 个点的外法线（相邻两段法线的平均，简单斜接） */
    const outwardNormalAt = (index) => {
        const point = resampled[index];
        const prev = resampled[(index - 1 + total) % total];
        const next = resampled[(index + 1) % total];
        let nx = 0;
        let ny = 0;
        const segments = [
            [point[0] - prev[0], point[1] - prev[1]],
            [next[0] - point[0], next[1] - point[1]]
        ];
        for (const [dx, dy] of segments) {
            const length = Math.hypot(dx, dy) || 1;
            nx += dy / length;
            ny += -dx / length;
        }
        const length = Math.hypot(nx, ny) || 1;
        return [(nx / length) * flip, (ny / length) * flip];
    };

    const islandLocal = resampled.map((point, index) => {
        const [nx, ny] = outwardNormalAt(index);
        const t = index / total;
        let wobble = 1 - flat;
        for (const wave of ISLAND.waves) {
            wobble += wave.amp * (0.5 + 0.5 * Math.sin(2 * Math.PI * wave.freq * t + wave.phase));
        }
        const offset = ISLAND.noiseMeters * wobble;
        return [point[0] + nx * offset, point[1] + ny * offset];
    });

    const outline = islandLocal.map(toLatLon);

    /* 岛缘小建筑：沿轮廓均布，自岛缘向内缩一段（仍在岛面内，但又落在校园之外） */
    const rimProps = [];
    for (let i = 0; i < ISLAND.rimPropCount; i++) {
        const index = Math.round((i * total) / ISLAND.rimPropCount) % total;
        const [nx, ny] = outwardNormalAt(index);
        const point = islandLocal[index];
        const inward = [point[0] - nx * ISLAND.rimPropInsetMeters, point[1] - ny * ISLAND.rimPropInsetMeters];
        const [lat, lon] = toLatLon(inward);
        rimProps.push({
            id: `rim-${i + 1}`,
            kind: i % 2 === 0 ? 'pavilion' : 'tower',
            lat,
            lon
        });
    }

    /* 岛下碎岩：水平落在岛面轮廓之内、倒锥之外的空隙里。
       倒锥在第 f 段深度的收进量 = 最大内切半径 × f^指数（见前端 ISLAND_CONE_EXPONENT），
       这里用「短边的一半」当最大内切半径的上界，收进量只会估得更大 —— 碎岩因此一定落在锥体之外；
       同时半径又不超过岛面半径，所以也一定落在网格范围内。 */
    const coneDepth = ISLAND.rockLayers.reduce((sum, layer) => sum + layer.thicknessMeters, 0);
    const centroid = centroidOfLocal(islandLocal);
    const boxSpanX = Math.max(...islandLocal.map((p) => p[0])) - Math.min(...islandLocal.map((p) => p[0]));
    const boxSpanY = Math.max(...islandLocal.map((p) => p[1])) - Math.min(...islandLocal.map((p) => p[1]));
    const inscribedUpperBound = Math.min(boxSpanX, boxSpanY) / 2;
    const random = seededRandom(0x4c7a9);
    const [depthMin, depthMax] = ISLAND.debrisDepthRatio;
    const [sizeMin, sizeMax] = ISLAND.debrisSizeMeters;
    const debris = [];
    for (let i = 0; i < ISLAND.debrisCount; i++) {
        const angle = (i / ISLAND.debrisCount) * Math.PI * 2 + random() * 0.7;
        const dir = [Math.cos(angle), Math.sin(angle)];
        const surfaceRadius = rayRadiusFromCentroid(centroid, dir, islandLocal);
        const depthRatio = depthMin + random() * (depthMax - depthMin);
        const coneRadius = inscribedUpperBound * Math.pow(depthRatio, ISLAND_CONE_EXPONENT);
        const radius = Math.max(
            surfaceRadius * 0.08,
            surfaceRadius - coneRadius - ISLAND.debrisClearanceMeters
        );
        const [lat, lon] = toLatLon([centroid[0] + dir[0] * radius, centroid[1] + dir[1] * radius]);
        debris.push({
            id: `debris-${i + 1}`,
            lat,
            lon,
            depthMeters: Number((coneDepth * depthRatio).toFixed(1)),
            sizeMeters: Number((sizeMin + random() * (sizeMax - sizeMin)).toFixed(1))
        });
    }

    const trimProp = (item) => ({ ...item, lat: Number(item.lat.toFixed(7)), lon: Number(item.lon.toFixed(7)) });

    return {
        outline: trimOutline(outline),
        noiseMeters: ISLAND.noiseMeters,
        rockLayers: ISLAND.rockLayers,
        rimProps: rimProps.map(trimProp),
        debris: debris.map(trimProp)
    };
}

/* ----------------------------------------------------------------
   转换
---------------------------------------------------------------- */

/** 经纬度保留 7 位：约 1cm 精度，远小于体素尺度，同时避免浮点噪声撑大文件 */
const trimPoint = ([lat, lon]) => [Number(lat.toFixed(7)), Number(lon.toFixed(7))];
const trimOutline = (points) => points.map(trimPoint);

async function main() {
    const osm = (await import(pathToFileURL(DEMO_DATA).href)).default;

    await mkdir(path.join(OUT_DIR, 'dictionaries'), { recursive: true });

    /* 学校配置：边界直接取自 OSM 校园要素；岛面轮廓由边界向外扰动生成后落地 */
    const campusBoundary = trimOutline(osm.campus.boundary);
    const school = {
        ...SCHOOL_META,
        boundary: campusBoundary,
        island: buildIsland(campusBoundary)
    };

    /* 建筑：只留轮廓与身份，typeKey/floors/floorHeight 全部交给类型字典 */
    const boundary = osm.campus.boundary;
    const insideCampus = (points) => {
        const [lat, lon] = centroidOf(points);
        return isInsidePolygon(lat, lon, boundary);
    };

    const keptBuildings = osm.buildings.filter((entry) => insideCampus(entry.points));

    const buildings = {
        version: 1,
        items: [
            ...keptBuildings.map((entry) => ({
                id: entry.id,
                name: entry.name || '',
                kind: entry.kind || '',
                source: 'osm',
                outline: trimOutline(entry.points)
            })),
            /* 示例天桥：显式给 typeKey，不依赖名称推断 */
            {
                id: SKYWALK_SAMPLE.id,
                name: SKYWALK_SAMPLE.name,
                source: SKYWALK_SAMPLE.source,
                typeKey: SKYWALK_SAMPLE.typeKey,
                outline: SKYWALK_SAMPLE.outline
            }
        ]
    };

    /* 地皮一：OSM 场地矢量（跑道、球场、草坪、泳池、看台…） */
    const featureItems = osm.features
        .filter((feature) => resolveParcelType(feature))
        .map((feature) => ({
            id: `p-${feature.id}`,
            name: feature.name || '',
            typeKey: resolveParcelType(feature),
            source: 'osm',
            outline: trimOutline(feature.points)
        }));

    /* 地皮二：补充抓取的道路与自然地表（DEMO 当年没抓，道路是影像凑出来的） */
    const extra = JSON.parse(await readFile(EXTRA_OSM, 'utf8'));

    const extraItems = (extra.elements ?? [])
        .map((element) => {
            const tags = element.tags ?? {};
            if (!element.geometry || element.geometry.length < 2) return null;

            const points = element.geometry.map((node) => [
                Number(node.lat.toFixed(7)),
                Number(node.lon.toFixed(7))
            ]);

            /* 道路：折线按类型宽度缓冲成多边形 */
            if (tags.highway) {
                const spec = HIGHWAY_CLASS[tags.highway];
                if (!spec) return null;

                const tagged = Number(tags.width);
                const widthMeters =
                    Number.isFinite(tagged) && tagged > 0 ? tagged : spec.widthMeters;
                const outline = bufferLine(points, widthMeters);
                if (!outline) return null;

                return {
                    id: `p-hw-${element.id}`,
                    name: tags.name || '',
                    typeKey: spec.type,
                    source: 'osm',
                    outline: trimOutline(outline)
                };
            }

            /* 自然地表：只接闭合的面积要素 —— 未闭合的折线当面积处理会得到退化多边形 */
            const areaType = NATURAL_CLASS[tags.natural] ?? FOREST_LANDUSE_CLASS[tags.landuse];
            if (!areaType) return null;

            const [firstLat, firstLon] = points[0];
            const [lastLat, lastLon] = points[points.length - 1];
            if (firstLat !== lastLat || firstLon !== lastLon) return null;

            return {
                id: `p-nat-${element.id}`,
                name: tags.name || '',
                typeKey: areaType,
                source: 'osm',
                outline: trimOutline(points.slice(0, -1))
            };
        })
        .filter(Boolean);

    const allParcels = [...featureItems, ...extraItems].filter((item) =>
        insideCampus(item.outline)
    );

    const parcels = { version: 1, items: allParcels };
    const roadCount = extraItems.filter((item) => item.id.startsWith('p-hw-')).length;

    const files = {
        'school.json': school,
        'buildings.json': buildings,
        'parcels.json': parcels
    };

    console.log(
        `[convert-osm] 数据来源：建筑 ${keptBuildings.length}/${osm.buildings.length} 条、` +
            `场地矢量 ${featureItems.length}/${osm.features.length} 条、` +
            `道路 ${roadCount} 条、自然地表 ${extraItems.length - roadCount} 条` +
            `（已按「重心在校园边界内」过滤）`
    );

    for (const [name, content] of Object.entries(files)) {
        const file = path.join(OUT_DIR, name);
        await writeFile(file, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
        const count = content.items ? `（${content.items.length} 条）` : '';
        console.log(`[convert-osm] 已写出 ${path.relative(repoRoot, file)}${count}`);
    }
}

main().catch((error) => {
    console.error('[convert-osm] 转换失败：', error);
    process.exitCode = 1;
});
