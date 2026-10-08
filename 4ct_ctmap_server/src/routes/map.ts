import { Router, type Request, type Response, type NextFunction } from 'express';
import { DataError } from '../errors';
import { readDataJson, writeDataJson } from '../loaders/jsonStore';
import { requireAdminKey } from '../middleware/auth';
import {
    assertBuildingsWritable,
    assertDictionariesWritable,
    assertParcelsWritable,
    assertSchoolWritable,
    loadMapDataset
} from '../loaders/mapDataset';
import { ok } from '../middleware/response';

/**
 * express 4 不会自动捕获 async 处理函数抛出的异常，
 * 这里统一把 rejection 转交给错误中间件（错误壳与状态码由它决定）。
 */
function asyncHandler(
    handler: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => {
        handler(req, res).catch(next);
    };
}

export const mapRouter = Router();

/* 编辑登录检测：仅鉴权、不改任何数据。前端进入编辑页前调用它校验密钥，避免
 * 随便填个 token 就能进去；未配置密钥时返回 enabled:false（此时写接口不鉴权）。 */
mapRouter.get(
    '/auth-check',
    requireAdminKey,
    asyncHandler(async (_req, res) => {
        ok(res, { enabled: true, hasKey: true });
    })
);

mapRouter.get(
    '/school',
    asyncHandler(async (_req, res) => {
        const dataset = await loadMapDataset();
        ok(res, dataset.school);
    })
);

mapRouter.get(
    '/dictionaries',
    asyncHandler(async (_req, res) => {
        const dataset = await loadMapDataset();
        ok(res, dataset.dictionaries);
    })
);

mapRouter.get(
    '/buildings',
    asyncHandler(async (_req, res) => {
        const dataset = await loadMapDataset();
        ok(res, dataset.buildings);
    })
);

mapRouter.get(
    '/parcels',
    asyncHandler(async (_req, res) => {
        const dataset = await loadMapDataset();
        ok(res, dataset.parcels);
    })
);

mapRouter.get(
    '/manifest',
    asyncHandler(async (_req, res) => {
        const dataset = await loadMapDataset();
        ok(res, dataset.manifest);
    })
);

/* ----------------------------------------------------------------
   编辑器：读原始 JSON + 整份覆盖写回
   —— 为什么编辑器要读「原始」而不是复用读接口：读接口返回的是**已合成**的
      Building（typeKey/层数/形制都已按类型字典补齐），拿它回写会把「未覆盖」
      的语义写成「显式覆盖」，逐栋参数从此锁死。原始 JSON 才是可编辑的真源。
      school.json 虽然没有「合成」这一步，也一并走 raw 读 —— 编辑器的取数口径只有一条。
---------------------------------------------------------------- */

/** 允许通过 /raw/:file 读取的文件白名单：避免路径穿越，也避免暴露别的数据 */
const RAW_FILES: Record<string, string> = {
    school: 'school.json',
    buildings: 'buildings.json',
    parcels: 'parcels.json',
    /* 类型字典也走 raw 读：编辑器要按「未指定 = 跟随色板」的语义回写主色调 */
    dictionaries: 'dictionaries/building-types.json'
};

function requireRawFile(name: string): string {
    const file = RAW_FILES[name];
    if (!file) {
        throw new DataError(
            `/api/map/raw/${name} 不受支持：可选 ${Object.keys(RAW_FILES).join(' / ')}`
        );
    }
    return file;
}

mapRouter.get(
    '/raw/:file',
    asyncHandler(async (req, res) => {
        ok(res, await readDataJson(requireRawFile(req.params.file)));
    })
);

mapRouter.put(
    '/buildings',
    requireAdminKey,
    asyncHandler(async (req, res) => {
        const dataset = await loadMapDataset();
        /* 校验失败会抛 DataError，此时不会写盘 —— 磁盘上永远是「能装出数据集」的那一份 */
        const count = assertBuildingsWritable(req.body, dataset);
        await writeDataJson(RAW_FILES.buildings, req.body);
        ok(res, { saved: count }, `已写入 buildings.json（${count} 条），原文件备份为 .bak`);
    })
);

mapRouter.put(
    '/parcels',
    requireAdminKey,
    asyncHandler(async (req, res) => {
        const dataset = await loadMapDataset();
        const count = assertParcelsWritable(req.body, dataset);
        await writeDataJson(RAW_FILES.parcels, req.body);
        ok(res, { saved: count }, `已写入 parcels.json（${count} 条），原文件备份为 .bak`);
    })
);

/* 岛面轮廓：school.json 是单份文档，返回的点数即「写盘确认过的岛面轮廓点数」 */
mapRouter.put(
    '/school',
    requireAdminKey,
    asyncHandler(async (req, res) => {
        const dataset = await loadMapDataset();
        const points = assertSchoolWritable(req.body, dataset);
        await writeDataJson(RAW_FILES.school, req.body);
        ok(res, { saved: points }, `已写入 school.json（岛面轮廓 ${points} 点），原文件备份为 .bak`);
    })
);

/* 建筑类型字典（含各类型的墙面/屋顶主色）：返回值是写盘确认过的类型数 */
mapRouter.put(
    '/dictionaries',
    requireAdminKey,
    asyncHandler(async (req, res) => {
        const dataset = await loadMapDataset();
        const types = await assertDictionariesWritable(req.body, dataset);
        await writeDataJson(RAW_FILES.dictionaries, req.body);
        ok(
            res,
            { saved: types },
            `已写入 building-types.json（${types} 个类型），原文件备份为 .bak`
        );
    })
);

/* ----------------------------------------------------------------
   地点词典 places.json（地理位置匹配）
   —— 编辑器「地理位置匹配」面板的读写接口。places.json 不参与数据集合成，
      直接整份覆盖写回（写前备份 .bak）。
---------------------------------------------------------------- */

const PLACES_FILE = 'places.json';

/** 写前校验：任一规则不合法直接抛 DataError，保证写盘的一定是可用的词典 */
function assertPlacesWritable(raw: unknown): number {
    if (!raw || typeof raw !== 'object') {
        throw new DataError('places.json 必须是对象（{ version, places: [...] }）');
    }
    const places = (raw as { places?: unknown }).places;
    if (!Array.isArray(places)) {
        throw new DataError('places.json 缺少 places 数组');
    }
    for (const place of places) {
        const p = place as {
            name?: unknown;
            mustInclude?: unknown;
            position?: unknown;
        };
        if (typeof p.name !== 'string' || !p.name.trim()) {
            throw new DataError('place 缺少 name（地点标准名必填）');
        }
        if (!Array.isArray(p.mustInclude) || p.mustInclude.length === 0) {
            throw new DataError(`place「${String(p.name)}」缺少 mustInclude（至少一个命中词）`);
        }
        if (p.position !== undefined) {
            if (
                !Array.isArray(p.position) ||
                p.position.length !== 2 ||
                p.position.some((n) => typeof n !== 'number' || !Number.isFinite(n))
            ) {
                throw new DataError(`place「${String(p.name)}」的 position 必须是 [纬度, 经度] 两元素数对`);
            }
        }
    }
    return places.length;
}

mapRouter.get(
    '/places',
    asyncHandler(async (_req, res) => {
        ok(res, await readDataJson(PLACES_FILE));
    })
);

mapRouter.put(
    '/places',
    requireAdminKey,
    asyncHandler(async (req, res) => {
        const count = assertPlacesWritable(req.body);
        await writeDataJson(PLACES_FILE, req.body);
        ok(res, { saved: count }, `已写入 places.json（${count} 个地点），原文件备份为 .bak`);
    })
);
