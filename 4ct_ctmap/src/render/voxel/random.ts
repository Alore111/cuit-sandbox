/* ================================================================
   确定性伪随机
   —— 树木分布、窗灯亮灭必须每次刷新完全一致，否则会出现
      「每次进入校园长得不一样」的漂移。因此一律不用 Math.random。
================================================================ */

/** mulberry32：以整数（如建筑 id）为种子 */
export function seededRandom(seed: number): () => number {
    let t = seed >>> 0;
    return function next(): number {
        t += 0x6d2b79f5;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

/** 二维坐标 → [0,1) 的确定性哈希，用于按位置散布地物与挑近似色 */
export function hash2(x: number, z: number): number {
    let h = Math.imul(x, 374761393) + Math.imul(z, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
