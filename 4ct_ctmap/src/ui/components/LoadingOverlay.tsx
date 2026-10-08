import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import gsap from 'gsap';
import styles from '../styles/overlay.module.css';

/** 中文校名的 8 个字，逐字裁切类与 overlay.module.css 的实测字界一一对应 */
const NAME_CHAR_CLASSES = [
    styles.char1,
    styles.char2,
    styles.char3,
    styles.char4,
    styles.char5,
    styles.char6,
    styles.char7,
    styles.char8
];

interface LoadingOverlayProps {
    /** 沙盘世界是否构建完成。true 时等入场时间轴播完再揭幕；未就绪则一直停在载入态 */
    ready: boolean;
    /** 揭幕完成回调：由外层卸载本遮罩 */
    onExited: () => void;
}

/**
 * 品牌 splash：圆徽入场 → 校名逐字入场 → 载入文案与进度光带 → 揭幕退场。
 * 【口径】退场必须等入场播完 —— 沙盘构建可能快于动画，否则 splash 会一闪而过。
 */
export function LoadingOverlay({ ready, onExited }: LoadingOverlayProps) {
    const rootRef = useRef<HTMLDivElement>(null);
    const emblemRef = useRef<HTMLDivElement>(null);
    const haloRef = useRef<HTMLSpanElement>(null);
    const nameEnRef = useRef<HTMLDivElement>(null);
    const captionRef = useRef<HTMLDivElement>(null);
    const progressRef = useRef<HTMLDivElement>(null);
    const charRefs = useRef<(HTMLSpanElement | null)[]>([]);

    /** 入场时间轴是否已播完 */
    const entranceDoneRef = useRef(false);
    /** ready 的最新值：入场播完那一刻才读它决定是否揭幕 */
    const readyRef = useRef(ready);
    /** 防止揭幕时间轴被重复触发 */
    const exitingRef = useRef(false);

    const tryExit = useCallback(() => {
        const root = rootRef.current;
        if (!root || exitingRef.current || !entranceDoneRef.current || !readyRef.current) return;
        exitingRef.current = true;

        /* 降低动效：不做揭幕动画，直接把画面交还给沙盘 */
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            onExited();
            return;
        }

        const chars = charRefs.current.filter((el): el is HTMLSpanElement => el !== null);
        gsap.timeline({ onComplete: onExited })
            .to([captionRef.current, progressRef.current, haloRef.current], { autoAlpha: 0, duration: 0.22 }, 0)
            /* 校名从右往左回收，与逐字入场反向 */
            .to(chars, { autoAlpha: 0, y: -16, duration: 0.3, stagger: { each: 0.028, from: 'end' } }, 0.1)
            .to(nameEnRef.current, { autoAlpha: 0, duration: 0.25 }, 0.2)
            .to(emblemRef.current, { autoAlpha: 0, scale: 1.14, duration: 0.5, ease: 'power2.in' }, 0.15)
            /* 整屏底色淡出，露出已经渲染好的沙盘 */
            .to(root, { autoAlpha: 0, duration: 0.5, ease: 'power2.inOut' }, 0.35);
    }, [onExited]);

    useLayoutEffect(() => {
        const root = rootRef.current;
        if (!root) return;

        const context = gsap.context(() => {
            const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

            if (reduceMotion) {
                /* 降低动效：直接呈现终态 */
                gsap.set(root, { autoAlpha: 1 });
                entranceDoneRef.current = true;
                tryExit();
                return;
            }

            const chars = charRefs.current.filter((el): el is HTMLSpanElement => el !== null);
            gsap.timeline({
                defaults: { ease: 'power3.out' },
                onComplete: () => {
                    entranceDoneRef.current = true;
                    tryExit();
                }
            })
                /* 首帧底色淡入，避免深底闪白 */
                .from(root, { autoAlpha: 0, duration: 0.4, ease: 'power1.out' })
                /* 圆徽：从右后方向正位旋入并聚焦 */
                .from(
                    emblemRef.current,
                    { autoAlpha: 0, scale: 0.68, rotate: -18, filter: 'blur(12px)', duration: 0.9 },
                    0.1
                )
                .from(haloRef.current, { autoAlpha: 0, scale: 0.55, duration: 0.7 }, 0.7)
                /* 校名逐字自下而上入场 */
                .from(chars, { autoAlpha: 0, y: 26, duration: 0.55, stagger: 0.055 }, 0.5)
                .from(nameEnRef.current, { autoAlpha: 0, y: 12, duration: 0.5 }, 1.15)
                .from([captionRef.current, progressRef.current], { autoAlpha: 0, y: 14, duration: 0.5 }, 1.3);
        }, root);

        return () => {
            context.revert();
        };
    }, [tryExit]);

    /* ready 变化时尝试揭幕；入场还没播完就先记下，等入场 onComplete 再触发 */
    useEffect(() => {
        readyRef.current = ready;
        if (ready) tryExit();
    }, [ready, tryExit]);

    return (
        <div className={`${styles.overlay} ${styles.splash}`} ref={rootRef} role="status" aria-live="polite">
            <div className={styles.logoStage}>
                <span className={styles.halo} ref={haloRef} aria-hidden="true" />
                <div className={`${styles.crop} ${styles.emblem}`} ref={emblemRef} aria-hidden="true" />
            </div>
            <div className={styles.name}>
                {/* 校名是位图裁切块，读屏由下方文案承担，这里整体隐藏 */}
                <div className={styles.nameCn} aria-hidden="true">
                    {NAME_CHAR_CLASSES.map((charClass, index) => (
                        <span
                            key={charClass}
                            className={`${styles.crop} ${charClass}`}
                            ref={(el) => {
                                charRefs.current[index] = el;
                            }}
                        />
                    ))}
                </div>
                <div className={`${styles.crop} ${styles.nameEn}`} ref={nameEnRef} aria-hidden="true" />
            </div>
            <div className={styles.caption} ref={captionRef}>
                <div className={styles.title}>正在生成校园沙盘</div>
                <div className={styles.sub}>实况 · 建筑 · 导航</div>
            </div>
            <div className={styles.progress} ref={progressRef} aria-hidden="true">
                <span className={styles.progressBar} />
            </div>
        </div>
    );
}
