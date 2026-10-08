import { useEffect } from 'react';
import { useUiStore } from '../../store/uiStore';

/** 与 CSS 里隐藏名录/图例的断点保持一致 */
const WIDE_SCREEN = '(min-width: 1201px)';

/**
 * 量出左侧面板的占宽，交给相机做安全框避让。
 * 面板宽度定义在 tokens.css 的 --roster-w / --gap：这里读同一份变量，
 * 面板改宽时不必在两处同步数字。
 */
export function useLayoutBias(): void {
    const setLayoutBias = useUiStore((state) => state.setLayoutBias);

    useEffect(() => {
        const measure = (): void => {
            const styles = getComputedStyle(document.documentElement);
            const rosterWidth = parseFloat(styles.getPropertyValue('--roster-w')) || 0;
            const liveWidth = parseFloat(styles.getPropertyValue('--campus-live-w')) || 0;

            setLayoutBias(
                window.matchMedia(WIDE_SCREEN).matches ? rosterWidth - liveWidth : 0
            );
        };

        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, [setLayoutBias]);
}
