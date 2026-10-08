/**
 * 把后端「唯一真源」data/ 加工成前端静态降级副本，覆盖到 ../4ct_ctmap/public/data/。
 *
 * 用途：前端 mapService 在后端 API 不可达时，会降级读 public/data 下的静态 JSON。
 * 这里复用 loadMapDataset（同一套 validate/resolve 代码路径），确保副本与真实接口
 * 返回的加工后格式完全一致：
 *   - buildings / parcels  写「处理后」的 Building[] / Parcel[]（带 massing/floor 等渲染字段）
 *   - school / manifest    单份文档，直接落盘
 *   - dictionaries         原样拷贝 building-types / terrain-types
 * 运行：node_modules/.bin tsx scripts/export-dataset.mts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMapDataset } from '../src/loaders/mapDataset';

/** 前端静态副本目录（相对本文件：scripts -> 4ct_ctmap_server -> 4ct_map -> 4ct_ctmap/public/data） */
const TARGET_DIR = fileURLToPath(new URL('../../4ct_ctmap/public/data/', import.meta.url));

const dataset = await loadMapDataset();

const toWrite: Array<[string, unknown]> = [
    ['school.json', dataset.school],
    ['dictionaries/building-types.json', dataset.dictionaries.buildings],
    ['dictionaries/terrain-types.json', dataset.dictionaries.terrain],
    ['buildings.json', dataset.buildings],
    ['parcels.json', dataset.parcels],
    ['manifest.json', dataset.manifest]
];

for (const [relative, value] of toWrite) {
    const file = path.join(TARGET_DIR, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value, null, 2).concat('\n'), 'utf8');
    console.log(`已生成 ${file}`);
}

console.log(`\n完成：前端降级副本已同步到 ${TARGET_DIR}`);