import { copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DataError } from '../errors';

/** data/ 目录：JSON 数据的唯一真源 */
const DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url));

interface CacheEntry {
    mtimeMs: number;
    value: unknown;
}

/**
 * 按文件 mtime 失效的内存缓存。
 * 本期数据是只读的，靠 mtime 判断「文件被改过没有」即可，
 * 不需要引入数据库或 watcher；改完 JSON 刷新页面就能看到新数据。
 */
const cache = new Map<string, CacheEntry>();

export function dataFilePath(relativePath: string): string {
    return path.join(DATA_DIR, relativePath);
}

export async function readDataJson<T>(relativePath: string): Promise<T> {
    const file = dataFilePath(relativePath);

    const stats = await stat(file).catch(() => null);
    if (!stats?.isFile()) {
        throw new DataError(`数据文件不存在：data/${relativePath}`);
    }

    const cached = cache.get(file);
    if (cached && cached.mtimeMs === stats.mtimeMs) {
        return cached.value as T;
    }

    const text = await readFile(file, 'utf8').catch((error: unknown) => {
        throw new DataError(
            `数据文件读取失败：data/${relativePath}（${error instanceof Error ? error.message : String(error)}）`
        );
    });

    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (error) {
        throw new DataError(
            `data/${relativePath} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`
        );
    }

    cache.set(file, { mtimeMs: stats.mtimeMs, value });
    return value as T;
}

/**
 * 整份覆盖写入（编辑器的保存路径）。
 * —— 【口径】写盘前先复制一份 `.bak`：编辑器是「整份覆盖」，没有增量补丁，
 *    因此唯一的回退手段就是这份备份。写盘后清掉缓存条目，
 *    让下一次读一定重新解析（虽然 mtime 变了也会失效，这里不依赖它）。
 */
export async function writeDataJson(relativePath: string, value: unknown): Promise<void> {
    const file = dataFilePath(relativePath);
    const stats = await stat(file).catch(() => null);

    if (stats?.isFile()) {
        await copyFile(file, `${file}.bak`).catch((error: unknown) => {
            throw new DataError(
                `备份失败：data/${relativePath}.bak（${error instanceof Error ? error.message : String(error)}）`
            );
        });
    }

    try {
        await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    } catch (error) {
        throw new DataError(
            `数据文件写入失败：data/${relativePath}（${error instanceof Error ? error.message : String(error)}）`
        );
    }

    cache.delete(file);
}
