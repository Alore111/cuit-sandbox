/* ================================================================
   分帧切片：把构建长任务切成若干小段，段间把主线程让回浏览器
   —— 场景构建（栅格化 → 体素 → 几何）是纯同步计算，一口气跑完要 3 秒以上，
      期间浏览器一帧都画不出来：加载页的入场动画、揭幕转场、进度光带全都冻住。
      这里把「让出主线程」单独收成一个模块，构建管线在热循环里按时间预算调用。

   【为什么按时间判、不按迭代次数】同一段循环里每格成本差一个量级（一次 Map 查询
      与一次数组写不是一个价），按次数切要么切得太碎（让出的开销超过干活），
      要么切不动（一段里恰好全是重活）。按「距上次让出过了多少毫秒」判才稳定。

   【为什么用 MessageChannel】浏览器只在两次**宏任务**之间插入渲染：
      Promise 只是微任务，让不出去；requestAnimationFrame 得等下一帧，反而更晚。
      （scheduler.yield() 也能让出，但那是 Chrome 129 起才有的新接口，这里不用它换兼容性。）
================================================================ */

/** 单段最长执行时间（毫秒）：超过就让出一次 */
const SLICE_BUDGET_MS = 12;

/**
 * 逐格、逐面这类热循环传的 span（见 Slicer.shouldYield）：
 * 这类循环的单次迭代只有几次整数运算，每次都读时钟（performance.now 一次几十纳秒）
 * 会在几百万次迭代上累出上百毫秒；隔 256 次问一次，超出的量最多一次迭代的量级。
 */
export const HOT_LOOP_SPAN = 256;

export interface SlicerStats {
    /** 让出次数 */
    yields: number;
    /** 最长单段耗时（毫秒）：两次让出之间的最大间隔，构建会不会卡顿看的就是它 */
    maxSliceMs: number;
}

export interface Slicer {
    /**
     * 预算是否已用完：true 表示调用方应当 `await slicer.yield()`。
     *
     * @param span 隔多少次迭代才真正读一次时钟。逐格 / 逐面这类**单次迭代很便宜**的热循环
     *             传 HOT_LOOP_SPAN，让读时钟的开销被摊薄；默认 1 表示每次迭代都读，
     *             适合「每行 / 每栋 / 每株」这种**单次迭代本身就可能超过预算**的粗粒度循环。
     */
    shouldYield(span?: number): boolean;
    /** 真正让出主线程：await 它，浏览器会在这一让里绘制一帧 */
    yield(): Promise<void>;
    /** 从创建到现在的切片统计，供构建自检打印 */
    stats(): SlicerStats;
}

/**
 * Node 侧（`npm run check` 的构建自检脚本）没有渲染帧可让，
 * 而且常驻的 MessagePort 会 ref 事件循环、拖住进程退出 —— 那边改用 setImmediate。
 */
const IN_BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';

/** 造一个 `resolve` 挂在宏任务上的让出函数 */
function createYieldToHost(): () => Promise<void> {
    if (!IN_BROWSER) {
        return () =>
            new Promise<void>((resolve) => {
                setImmediate(resolve);
            });
    }

    /* 一个端口长期复用：每次让出只投递一条消息，消息回调里唤醒队首的等待者 */
    const channel = new MessageChannel();
    const waiters: (() => void)[] = [];
    channel.port1.onmessage = () => waiters.shift()?.();

    return () =>
        new Promise<void>((resolve) => {
            waiters.push(resolve);
            channel.port2.postMessage(null);
        });
}

const yieldToHost = createYieldToHost();

/**
 * 造一个让出器。每次构建各造一个、不共用：切片统计是按让出器单独计的，
 * 「这次构建的最长切片是多少」只有各构建各记才读得准。
 */
export function createSlicer(budgetMs: number = SLICE_BUDGET_MS): Slicer {
    /** 上一次拿回主线程的时刻：切片的长度就从它算起 */
    let lastResume = performance.now();
    /** 还差多少次调用才轮到读时钟 */
    let countdown = 1;
    let yields = 0;
    let maxSlice = 0;

    return {
        shouldYield(span = 1): boolean {
            if (--countdown > 0) return false;
            countdown = span;

            const now = performance.now();
            const slice = now - lastResume;
            if (slice <= budgetMs) return false;

            if (slice > maxSlice) maxSlice = slice;
            yields += 1;
            return true;
        },

        async yield(): Promise<void> {
            await yieldToHost();
            /* 让出期间浏览器在绘制，这段不算本构建的切片 —— 从拿回主线程的这一刻重新起算 */
            lastResume = performance.now();
        },

        stats: () => ({ yields, maxSliceMs: maxSlice })
    };
}
