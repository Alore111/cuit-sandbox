/* ================================================================
   编辑器内部类型
   —— 只描述「编辑器自己的工作方式」（工具、选择、图层、草图），
      不碰数据契约：可编辑数据的形状一律来自 ../contract。
================================================================ */

import type { LonLat } from '../contract';
import type { MeterPoint } from './projection';

/* ----------------------------------------------------------------
   编辑目标
   —— 编辑器能改三类对象：建筑、地皮，以及**单例**的岛面轮廓。
---------------------------------------------------------------- */

export type EditorTarget =
    | { kind: 'building'; id: string }
    | { kind: 'parcel'; id: string }
    | { kind: 'island' };

export type EditorTargetKind = EditorTarget['kind'];

/**
 * 有 id 的要素目标。
 * 岛面是单例、也不参与批量编辑，因此属性表与批量修改只处理这一类 ——
 * 类型上把 island 排除掉，省得每处都写一次 kind 判断。
 */
export type FeatureTarget = { kind: 'building' | 'parcel'; id: string };

export const TARGET_KIND_LABELS: Record<EditorTargetKind, string> = {
    building: '建筑',
    parcel: '地皮',
    island: '岛面轮廓'
};

/** 目标的稳定标识：换项/比相等都走它，避免到处写 kind 分支 */
export function targetKey(target: EditorTarget | null): string {
    if (!target) return 'none';
    return target.kind === 'island' ? 'island' : `${target.kind}:${target.id}`;
}

export function sameTarget(a: EditorTarget | null, b: EditorTarget | null): boolean {
    return targetKey(a) === targetKey(b);
}

/**
 * 一个可编辑轮廓的统一视图。
 * 命中测试、捕捉、绘制都只认它，因此「建筑 / 地皮 / 岛面」三条支路
 * 在上层被压成同一件事。
 */
export interface TargetShape {
    target: EditorTarget;
    /** 列表与状态栏上显示的名字 */
    label: string;
    outline: LonLat[];
}

/**
 * 已经投到本地米的轮廓。
 * 画布每帧都要用它，且绘制 / 命中 / 捕捉三者共用同一份 ——
 * 各算一遍既浪费，也可能因精度处理不同而出现「看到的位置点不中」。
 */
export interface ShapeMeters {
    target: EditorTarget;
    label: string;
    meters: MeterPoint[];
}

/* ----------------------------------------------------------------
   工具
   —— 与 ArcMap 编辑工具条同一套分工：浏览视图与编辑手势分开，
      「改不动数据」与「能改数据」永远是两个明确的模式。
---------------------------------------------------------------- */

export type ToolMode = 'pan' | 'select' | 'vertex' | 'create';

export const TOOL_ORDER: readonly ToolMode[] = ['pan', 'select', 'vertex', 'create'];

export const TOOL_LABELS: Record<ToolMode, string> = {
    pan: '浏览',
    select: '选择',
    vertex: '编辑顶点',
    create: '新建要素'
};

/** 各工具在状态栏里的操作提示 */
export const TOOL_HINTS: Record<ToolMode, string> = {
    pan: '拖拽平移视图 · 滚轮缩放 · 中键/空格 临时平移',
    select: '点击选中 · Shift 点击加选 · 框选（左→右 完全包含，右→左 相交）· 拖轮廓内部整体平移 · Esc 清空',
    vertex: '拖顶点改点 · 拖线段插入并拖动新点 · 点击选点 · Delete 删点 · 方向键微调 · F2 完成 · 双击空白或 Esc 退出',
    create: '逐点点击落顶点 · 双击 / F2 / Enter 完成 · Backspace 退一点 · Esc 取消'
};

/* ----------------------------------------------------------------
   图层可见性：只影响画布显示，不动数据
---------------------------------------------------------------- */

export interface LayerVisibility {
    basemap: boolean;
    grid: boolean;
    island: boolean;
    parcels: boolean;
    buildings: boolean;
}

export const DEFAULT_LAYER_VISIBILITY: LayerVisibility = {
    basemap: true,
    grid: true,
    island: true,
    parcels: true,
    buildings: true
};

export const LAYER_LABELS: Record<keyof LayerVisibility, string> = {
    basemap: '卫星底图',
    grid: '参考网格',
    island: '岛面轮廓',
    parcels: '地皮',
    buildings: '建筑'
};

/* ----------------------------------------------------------------
   新建要素的草图（ArcMap 的 Create New Feature + sketch）
---------------------------------------------------------------- */

export interface SketchState {
    /** 正在画的是建筑还是地皮 */
    kind: 'building' | 'parcel';
    /** 预先分配好的 id：草图完成前不写进数据集，因此不会留下半成品 */
    id: string;
    outline: LonLat[];
}

/* ----------------------------------------------------------------
   卫星底图元数据（由 scripts/fetch-basemap.ps1 生成）
---------------------------------------------------------------- */

export interface BaseMapBounds {
    west: number;
    south: number;
    east: number;
    north: number;
}

export interface BaseMapMeta {
    source: string;
    note: string;
    fetchedAt: string;
    /** 相对站点根目录的图片路径，例如 basemap/aerial.jpg */
    url: string;
    zoom: number;
    width: number;
    height: number;
    metersPerPixel: number;
    bounds: BaseMapBounds;
}

/* ----------------------------------------------------------------
   指针命中
---------------------------------------------------------------- */

/** 命中的是哪条轮廓的哪个部位 */
export interface VertexHit {
    target: EditorTarget;
    /** 顶点序号 */
    index: number;
}

export interface SegmentHit {
    target: EditorTarget;
    /** 线段起点（= 起点顶点序号） */
    index: number;
    /** 线段上离光标最近的点（本地米） */
    point: { x: number; y: number };
}
