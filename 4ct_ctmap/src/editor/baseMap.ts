/* ================================================================
   卫星底图
   —— 底图是**离线拼接的单张影像**（scripts/fetch-basemap.ps1 的产物），
      不是运行时瓦片服务：编辑器因此不依赖外网，加载一次就能用。

      贴图办法：影像的四至是经纬度矩形，而编辑器的投影「经纬度 → 本地米」
      是线性的（见 projection.ts），因此只要把影像的西南角与东北角各自投到
      屏幕，就能用 drawImage 的仿射参数一次贴上去。

      【已知近似】瓦片是 Web Mercator，本投影是等距圆柱。在纬度 30.58°、
      约 1.2 km 的跨度上两者尺度差约 0.017%（≈0.2 m，远小于一个体素 2 m），
      对「判位对齐」这个用途足够，因此不做逐行重采样。
================================================================ */

import { useEffect, useState } from 'react';
import { BASEMAP_META } from './basemap.generated';
import type { BaseMapMeta } from './editorTypes';
import type { EditorProjection, MeterPoint } from './projection';
import { toScreen, type ViewTransform, type Viewport } from './viewTransform';

export const basemap: BaseMapMeta = BASEMAP_META;

/** 静态资源地址：public/ 下的文件挂在站点根，因此要带上 vite 的 base */
export function baseMapUrl(meta: BaseMapMeta): string {
    return `${import.meta.env.BASE_URL}${meta.url}`;
}

/** 底图在本地米坐标下的外接矩形 */
export function baseMapMetersRect(
    meta: BaseMapMeta,
    projection: EditorProjection
): { sw: MeterPoint; ne: MeterPoint } {
    const { west, south, east, north } = meta.bounds;
    return {
        sw: projection.toMeters([south, west]),
        ne: projection.toMeters([north, east])
    };
}

export interface BaseMapDrawOptions {
    ctx: CanvasRenderingContext2D;
    image: HTMLImageElement;
    meta: BaseMapMeta;
    projection: EditorProjection;
    view: ViewTransform;
    viewport: Viewport;
}

/** 把底图贴到画布上（调用方负责按图层开关决定是否调用） */
export function drawBaseMap(options: BaseMapDrawOptions): void {
    const { ctx, image, meta, projection, view, viewport } = options;
    const { sw, ne } = baseMapMetersRect(meta, projection);

    const screenSw = toScreen(view, viewport, sw);
    const screenNe = toScreen(view, viewport, ne);

    /* 屏幕 y 与纬度反向：西南角在屏幕下方、东北角在上方 */
    const dx = screenSw.x;
    const dy = screenNe.y;
    const dw = screenNe.x - screenSw.x;
    const dh = screenSw.y - screenNe.y;

    if (dw <= 0 || dh <= 0) return;

    ctx.drawImage(image, dx, dy, dw, dh);
}

/* ----------------------------------------------------------------
   影像加载：模块级缓存，一页只加载一次
---------------------------------------------------------------- */

let cachedUrl: string | null = null;
let cachedImage: HTMLImageElement | null = null;
let pending: Promise<HTMLImageElement> | null = null;

function loadImage(url: string): Promise<HTMLImageElement> {
    if (cachedUrl === url && cachedImage) return Promise.resolve(cachedImage);
    if (cachedUrl === url && pending) return pending;

    cachedUrl = url;
    cachedImage = null;
    pending = new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
            cachedImage = image;
            resolve(image);
        };
        image.onerror = () => reject(new Error(`底图加载失败：${url}（先跑 npm run basemap 生成）`));
        image.src = url;
    });
    return pending;
}

export interface BaseMapState {
    image: HTMLImageElement | null;
    error: string | null;
}

/** 加载底图。失败不兜底：把错误原样交给界面显示（图层树与状态栏会如实标注） */
export function useBaseMapImage(meta: BaseMapMeta = basemap): BaseMapState {
    const [state, setState] = useState<BaseMapState>({ image: cachedImage, error: null });

    useEffect(() => {
        if (cachedUrl === baseMapUrl(meta) && cachedImage) return;

        let alive = true;
        loadImage(baseMapUrl(meta))
            .then((image) => {
                if (alive) setState({ image, error: null });
            })
            .catch((error: unknown) => {
                if (!alive) return;
                setState({
                    image: null,
                    error: error instanceof Error ? error.message : String(error)
                });
            });

        return () => {
            alive = false;
        };
    }, [meta]);

    return state;
}
