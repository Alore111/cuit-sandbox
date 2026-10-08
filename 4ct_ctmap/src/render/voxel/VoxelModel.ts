import { HOT_LOOP_SPAN, type Slicer } from '../scheduler';
import type { VoxelColorKey } from '../theme/palette';

/** 一个体素：整数坐标 + 语义色键（不存 hex，颜色在渲染时按主题解析） */
export interface Voxel {
    x: number;
    y: number;
    z: number;
    key: VoxelColorKey;
}

export interface VoxelBounds {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
}

/* ----------------------------------------------------------------
   坐标编码域：三维坐标按位压成一个整数键。
   —— 键宽合计 31 位，正好不越过 V8 的 SMI 上限：一旦越过，Map 的键会退化成
      堆上 Number，每次写入多一次分配，改造的意义就没了。
   —— 域比实际网格大一圈（本校 620 × 413 格、岛体最深 200 层），留出格边出檐的余量；
      越域直接抛错，不做「截断 / 取模」之类的兜底 —— 键一旦碰撞，
      两个不同坐标会互相覆盖，比报错难查得多。
---------------------------------------------------------------- */
const X_MIN = -1024;
const X_MAX = 1023;
const Y_MIN = -256;
const Y_MAX = 255;
const Z_MIN = -1024;
const Z_MAX = 1023;

const Z_BITS = 11;
const Y_BITS = 9;
const Y_SHIFT = Z_BITS;
const X_SHIFT = Y_BITS + Z_BITS;
const Z_MASK = (1 << Z_BITS) - 1;
const Y_MASK = (1 << Y_BITS) - 1;

/** 三维坐标 → 整数键；越域抛错（见上：不能静默压进制） */
function keyOf(x: number, y: number, z: number): number {
    if (x < X_MIN || x > X_MAX || y < Y_MIN || y > Y_MAX || z < Z_MIN || z > Z_MAX) {
        throw new Error(
            `体素坐标 (${x}, ${y}, ${z}) 超出编码域：` +
                `x ∈ [${X_MIN}, ${X_MAX}]、y ∈ [${Y_MIN}, ${Y_MAX}]、z ∈ [${Z_MIN}, ${Z_MAX}]。` +
                '请放宽 VoxelModel 的编码域，并保证三维总宽不超过 31 位。'
        );
    }
    return ((x - X_MIN) << X_SHIFT) | ((y - Y_MIN) << Y_SHIFT) | (z - Z_MIN);
}

/** 整数键 → 三维坐标。按位解码、不产生临时对象 —— 遍历时逐格调用，这里是热路径 */
function xOf(key: number): number {
    return (key >> X_SHIFT) + X_MIN;
}

function yOf(key: number): number {
    return ((key >> Y_SHIFT) & Y_MASK) + Y_MIN;
}

function zOf(key: number): number {
    return (key & Z_MASK) + Z_MIN;
}

/**
 * 整数体素网格模型：用坐标「搭积木」，同坐标重复写入时后者覆盖前者。
 * (x, y, z) 表示该体素的最小角，占据 [x, x+1) × [y, y+1) × [z, z+1)，y 轴向上。
 *
 * 【键为什么是整数】早期实现把坐标拼成 `${x}|${y}|${z}` 字符串存进 Map：
 * 二十多万格就是二十多万次字符串拼接与哈希，遍历取坐标时还要逐格 split 回数字。
 * 这里改为位运算压成整数键，避免字符串分配并在解码时免去分配，
 * 遍历与写入都不再依赖键的字符串形态。
 */
export class VoxelModel {
    private readonly cells = new Map<number, VoxelColorKey>();

    set(x: number, y: number, z: number, key: VoxelColorKey): this {
        this.cells.set(keyOf(x, y, z), key);
        return this;
    }

    /** 实心长方体，端点包含在内（便于按「第几层到第几层」描述建筑） */
    box(
        x0: number,
        y0: number,
        z0: number,
        x1: number,
        y1: number,
        z1: number,
        key: VoxelColorKey
    ): this {
        for (let x = x0; x <= x1; x++) {
            for (let y = y0; y <= y1; y++) {
                for (let z = z0; z <= z1; z++) this.set(x, y, z, key);
            }
        }
        return this;
    }

    /** 竖直方柱（立柱、尖顶、天线） */
    column(x: number, z: number, y0: number, y1: number, key: VoxelColorKey): this {
        return this.box(x, y0, z, x, y1, z, key);
    }

    has(x: number, y: number, z: number): boolean {
        return this.cells.has(keyOf(x, y, z));
    }

    get size(): number {
        return this.cells.size;
    }

    /** 所有已占用坐标的包围盒；空模型返回 null */
    bounds(): VoxelBounds | null {
        if (this.cells.size === 0) return null;

        const min = { x: Infinity, y: Infinity, z: Infinity };
        const max = { x: -Infinity, y: -Infinity, z: -Infinity };

        for (const key of this.cells.keys()) {
            const x = xOf(key);
            const y = yOf(key);
            const z = zOf(key);
            if (x < min.x) min.x = x;
            if (x > max.x) max.x = x;
            if (y < min.y) min.y = y;
            if (y > max.y) max.y = y;
            if (z < min.z) min.z = z;
            if (z > max.z) max.z = z;
        }

        return { min, max };
    }

    /**
     * 物化成体素数组。
     * 【为什么要让出器】几十万格一次性物化是一次纯同步分配（本校岛体 33 万格实测 ~44 ms），
     * 落在构建链里就是一个几十毫秒的停顿 —— 加载页的动画正是被这种停顿扎住的。
     * 因此这里按时间预算把主线程让回去（见 render/scheduler）；调用方都在异步的构建链上。
     */
    async toArray(slicer: Slicer): Promise<Voxel[]> {
        const out: Voxel[] = new Array(this.cells.size);
        let i = 0;
        for (const [key, colorKey] of this.cells) {
            out[i++] = { x: xOf(key), y: yOf(key), z: zOf(key), key: colorKey };
            /* 单次迭代 = 一次对象分配：便宜但量极大，隔 span 次才读一次时钟 */
            if (slicer.shouldYield(HOT_LOOP_SPAN)) await slicer.yield();
        }
        return out;
    }
}
