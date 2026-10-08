/* ================================================================
   体素 → 几何
   —— 【口径】只发「暴露面」：相邻两格体素之间的重合面从外面永远看不到，
      发出去只是白让 GPU 跑一遍顶点着色与光栅化（深度测试再早，也省不掉这两步）。
      所以这里逐格查六个邻居，只把真正暴露的那几面拼进一张合并几何。

   【与旧版的差别】旧版是「一体素一个完整立方体」的 InstancedMesh：
     每个体素按 24 顶点 × 12 三角形提交，隐藏面照发；实心楼宇的内部面占到七成以上。
     合并暴露面后，三角形与顶点着色次数一起大幅下降（实心体量越多、降得越多），
     代价是顶点数据从「共享立方体 + 实例矩阵/颜色」变成「逐面顶点」，
      几何内存会变大 —— 这里明确是拿内存换吞吐，因为卡的是 GPU 而不是内存。

   【颜色怎么走】几何不带颜色，只逐顶点存一个「色槽索引」（aSlot，Uint16）。
      颜色统一来自 theme/palette 的调色板纹理，由本模块注入材质的着色器去采样：
      于是昼夜过渡每帧只需重写那张一维纹理，不必重算 600 万个顶点色。
      材质自身的 color 一律留白 —— 所有调用方都按这个约定写 0xffffff。
================================================================ */

import * as THREE from 'three';
import { HOT_LOOP_SPAN, type Slicer } from '../scheduler';
import { PALETTE_TEXTURE, PALETTE_WIDTH, type SlotLookup, type VoxelColorKey } from '../theme/palette';
import type { Voxel } from './VoxelModel';

/** 注入过调色板取色的 program 缓存键：改过源码的材质必须与未注入的分开缓存 */
const PALETTE_PROGRAM_KEY = 'voxel-palette-v1';

export interface VoxelMeshOptions {
    castShadow?: boolean;
    receiveShadow?: boolean;
}

export interface VoxelMeshHandle {
    mesh: THREE.Mesh;
}

/** 一个面的四个角点（相对体素最小角，取值 0/1） */
type Corner = readonly [number, number, number];

interface FaceSpec {
    /** 该面朝向的邻居偏移：邻居存在说明这个面被挡住，不发 */
    readonly dx: number;
    readonly dy: number;
    readonly dz: number;
    readonly normal: readonly [number, number, number];
    /** 【口径】角点按「从外面看逆时针」排列，三角形按 0-1-2 / 0-2-3 拆，正面才朝外 */
    readonly corners: readonly [Corner, Corner, Corner, Corner];
}

/** 六个面：±X / ±Y / ±Z */
const FACES: readonly FaceSpec[] = [
    {
        dx: 1,
        dy: 0,
        dz: 0,
        normal: [1, 0, 0],
        corners: [
            [1, 0, 1],
            [1, 0, 0],
            [1, 1, 0],
            [1, 1, 1]
        ]
    },
    {
        dx: -1,
        dy: 0,
        dz: 0,
        normal: [-1, 0, 0],
        corners: [
            [0, 0, 0],
            [0, 0, 1],
            [0, 1, 1],
            [0, 1, 0]
        ]
    },
    {
        dx: 0,
        dy: 1,
        dz: 0,
        normal: [0, 1, 0],
        corners: [
            [0, 1, 1],
            [1, 1, 1],
            [1, 1, 0],
            [0, 1, 0]
        ]
    },
    {
        dx: 0,
        dy: -1,
        dz: 0,
        normal: [0, -1, 0],
        corners: [
            [0, 0, 0],
            [1, 0, 0],
            [1, 0, 1],
            [0, 0, 1]
        ]
    },
    {
        dx: 0,
        dy: 0,
        dz: 1,
        normal: [0, 0, 1],
        corners: [
            [0, 0, 1],
            [1, 0, 1],
            [1, 1, 1],
            [0, 1, 1]
        ]
    },
    {
        dx: 0,
        dy: 0,
        dz: -1,
        normal: [0, 0, -1],
        corners: [
            [1, 0, 0],
            [0, 0, 0],
            [0, 1, 0],
            [1, 1, 0]
        ]
    }
];

/** 一个面的四个顶点 / 两个三角形 */
const CORNERS_PER_FACE = 4;
const INDICES_PER_FACE = 6;
const FLOATS_PER_VERTEX = 3;

/** 只发暴露面后得到的三份缓冲 + 逐面色键（建模时按它解析出逐顶点的色槽索引） */
interface FaceBuffers {
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint32Array;
    keys: VoxelColorKey[];
}

function emptyBuffers(): FaceBuffers {
    return {
        positions: new Float32Array(0),
        normals: new Float32Array(0),
        indices: new Uint32Array(0),
        keys: []
    };
}

/**
 * 逐格查六个邻居，把暴露面拼成四份缓冲。
 * 这是整条构建链上最重的一步（数百万次邻居查询），因此每一遍逐格循环都按 slice 让出。
 */
async function buildFaceBuffers(voxels: Voxel[], slicer: Slicer): Promise<FaceBuffers> {
    if (voxels.length === 0) return emptyBuffers();

    /* 占位集合：把三维坐标压成「以包围盒最小角为原点」的一维整数键。
       邻居查询是逐格 × 六次的量级，这里若每次都拼 `${x}|${y}|${z}` 字符串，
       光字符串分配就会吃掉几百毫秒；压成整数后只是一次乘加。 */
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    for (const voxel of voxels) {
        if (voxel.x < minX) minX = voxel.x;
        if (voxel.x > maxX) maxX = voxel.x;
        if (voxel.y < minY) minY = voxel.y;
        if (voxel.y > maxY) maxY = voxel.y;
        if (voxel.z < minZ) minZ = voxel.z;
        if (voxel.z > maxZ) maxZ = voxel.z;
        if (slicer.shouldYield(HOT_LOOP_SPAN)) await slicer.yield();
    }

    const strideY = maxZ - minZ + 1;
    const strideX = (maxY - minY + 1) * strideY;

    /* 【口径】越界一律返回 -1，绝不能让它参与整数压缩 ——
       邻居只偏移 1 格，若把「包围盒上方的邻居」直接丢进算术式，它会进位到下一个 x 块的键上，
       正好等于 (x+1, 最底层, z) 那个真实体素：于是整列最顶层的水平面被误判成「被挡住」而剔除
       （平房屋面 / 树冠顶 / 水面就是这么整片消失的）。-1 不可能是有效键（有效键都 ≥ 0）。 */
    const keyOf = (x: number, y: number, z: number): number => {
        if (x < minX || x > maxX) return -1;
        if (y < minY || y > maxY) return -1;
        if (z < minZ || z > maxZ) return -1;
        return (x - minX) * strideX + (y - minY) * strideY + (z - minZ);
    };

    const occupied = new Set<number>();
    for (const voxel of voxels) {
        occupied.add(keyOf(voxel.x, voxel.y, voxel.z));
        if (slicer.shouldYield(HOT_LOOP_SPAN)) await slicer.yield();
    }

    /* 先数一遍面数，四份缓冲各按最终长度一次性分配（避免 push 出动态数组再拷贝） */
    let faceCount = 0;
    for (const voxel of voxels) {
        for (const face of FACES) {
            const blocked = occupied.has(
                keyOf(voxel.x + face.dx, voxel.y + face.dy, voxel.z + face.dz)
            );
            if (!blocked) faceCount += 1;
        }
        if (slicer.shouldYield(HOT_LOOP_SPAN)) await slicer.yield();
    }
    if (faceCount === 0) return emptyBuffers();

    const positions = new Float32Array(faceCount * CORNERS_PER_FACE * FLOATS_PER_VERTEX);
    const normals = new Float32Array(positions.length);
    const indices = new Uint32Array(faceCount * INDICES_PER_FACE);
    const keys: VoxelColorKey[] = new Array<VoxelColorKey>(faceCount);

    let faceIndex = 0;
    for (const voxel of voxels) {
        for (const face of FACES) {
            const blocked = occupied.has(
                keyOf(voxel.x + face.dx, voxel.y + face.dy, voxel.z + face.dz)
            );
            if (blocked) continue;

            const firstVertex = faceIndex * CORNERS_PER_FACE;
            for (let c = 0; c < CORNERS_PER_FACE; c += 1) {
                const corner = face.corners[c];
                const at = (firstVertex + c) * FLOATS_PER_VERTEX;
                positions[at] = voxel.x + corner[0];
                positions[at + 1] = voxel.y + corner[1];
                positions[at + 2] = voxel.z + corner[2];
                normals[at] = face.normal[0];
                normals[at + 1] = face.normal[1];
                normals[at + 2] = face.normal[2];
            }

            const at = faceIndex * INDICES_PER_FACE;
            indices[at] = firstVertex;
            indices[at + 1] = firstVertex + 1;
            indices[at + 2] = firstVertex + 2;
            indices[at + 3] = firstVertex;
            indices[at + 4] = firstVertex + 2;
            indices[at + 5] = firstVertex + 3;

            keys[faceIndex] = voxel.key;
            faceIndex += 1;
        }
        if (slicer.shouldYield(HOT_LOOP_SPAN)) await slicer.yield();
    }

    return { positions, normals, indices, keys };
}

/**
 * 逐顶点的色槽索引。
 * 颜色本来是逐面的，而属性只能逐顶点给 —— 一个面的四个角共用同一个槽位；
 * 索引用 Uint16，总占用只有原先「三分量浮点顶点色」的 1/6。
 */
async function buildSlotAttribute(
    keys: VoxelColorKey[],
    slotOf: SlotLookup,
    slicer: Slicer
): Promise<THREE.Uint16BufferAttribute> {
    const slots = new Uint16Array(keys.length * CORNERS_PER_FACE);

    for (let face = 0; face < keys.length; face += 1) {
        const slot = slotOf(keys[face]);
        const first = face * CORNERS_PER_FACE;
        for (let c = 0; c < CORNERS_PER_FACE; c += 1) slots[first + c] = slot;
        if (slicer.shouldYield(HOT_LOOP_SPAN)) await slicer.yield();
    }

    return new THREE.Uint16BufferAttribute(slots, 1);
}

/** 在着色器里替换一次锚点；锚点缺失即抛错，不做静默降级（否则整场会失去颜色） */
function replaceAnchor(source: string, anchor: string, next: string): string {
    if (!source.includes(anchor)) {
        throw new Error(`体素材质的着色器缺少注入锚点「${anchor}」，调色板取色无法生效`);
    }
    return source.replace(anchor, next);
}

/**
 * 把「按色槽查调色板」注入材质着色器。
 * 几何不存颜色，因此这里必须自己声明 varying，并把取到的颜色乘进漫反射：
 *   <common>（顶点）   声明采样器与 aSlot 属性
 *   <color_vertex>     按 aSlot 从调色板纹理取色（替换掉 three 原本的顶点色逻辑）
 *   <common>（片元）   声明同名 varying
 *   <color_fragment>   把取到的颜色乘进 diffuseColor
 * 材质的 vertexColors 保持关闭 —— 颜色完全由这条通道接管。
 */
function injectPaletteShader(material: THREE.Material): void {
    material.onBeforeCompile = (shader) => {
        shader.uniforms.uPalette = { value: PALETTE_TEXTURE };

        shader.vertexShader = replaceAnchor(
            shader.vertexShader,
            '#include <common>',
            [
                '#include <common>',
                'uniform sampler2D uPalette;',
                'attribute float aSlot;',
                'varying vec3 vPaletteColor;'
            ].join('\n')
        );
        shader.vertexShader = replaceAnchor(
            shader.vertexShader,
            '#include <color_vertex>',
            `vPaletteColor = texture2D(uPalette, vec2((aSlot + 0.5) / ${PALETTE_WIDTH}.0, 0.5)).rgb;`
        );

        shader.fragmentShader = replaceAnchor(
            shader.fragmentShader,
            '#include <common>',
            ['#include <common>', 'varying vec3 vPaletteColor;'].join('\n')
        );
        shader.fragmentShader = replaceAnchor(
            shader.fragmentShader,
            '#include <color_fragment>',
            'diffuseColor.rgb *= vPaletteColor;'
        );
    };
    /* 改过着色器源码，必须给独立的缓存键，否则会与未注入的同类型材质共用 program */
    material.customProgramCacheKey = () => PALETTE_PROGRAM_KEY;
}

/**
 * 把体素列表合并成一张「只有暴露面」的几何。
 * 同一份几何只占 1 次 draw call —— 这是沙盘能满帧的前提。
 *
 * 分帧切片：逐格查邻居与逐面填槽位都按 slicer 让出主线程（调用方必须传构建期的那个让出器）。
 */
export async function createVoxelMesh(
    voxels: Voxel[],
    material: THREE.Material,
    slotOf: SlotLookup,
    slicer: Slicer,
    options: VoxelMeshOptions = {}
): Promise<VoxelMeshHandle> {
    const { castShadow = true, receiveShadow = true } = options;

    const buffers = await buildFaceBuffers(voxels, slicer);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(buffers.positions, FLOATS_PER_VERTEX)
    );
    geometry.setAttribute('normal', new THREE.BufferAttribute(buffers.normals, FLOATS_PER_VERTEX));
    /* 颜色不在几何里：这里只存色槽索引，颜色由调色板纹理在着色器里取 */
    geometry.setAttribute('aSlot', await buildSlotAttribute(buffers.keys, slotOf, slicer));
    geometry.setIndex(new THREE.BufferAttribute(buffers.indices, 1));

    injectPaletteShader(material);

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    /* 【与旧版不同】不再关剔除：合并后的包围球就是真实范围（旧版是共享的立方体包围球，
       对实例分布毫无意义，只能整块关掉剔除），因此现在能做真正的视锥剔除。 */

    return { mesh };
}
