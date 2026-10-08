import { useUiStore } from '../../store/uiStore';
import styles from '../styles/hud.module.css';

/** 昼夜切换：点击后触发 5 秒日出/日落过渡动画，动画期间按钮禁用 */
export function ThemeToggle() {
    const theme = useUiStore((state) => state.theme);
    const targetTheme = useUiStore((state) => state.targetTheme);
    const transitioning = useUiStore((state) => state.transitioning);
    const toggleTheme = useUiStore((state) => state.toggleTheme);
    /* 过渡期间显示目标主题（即将到达的状态），过渡结束由 theme 接管 */
    const displayTheme = transitioning ? targetTheme : theme;
    const isNight = displayTheme === 'night';

    return (
        <button
            type="button"
            className={styles.toggle}
            onClick={toggleTheme}
            disabled={transitioning}
            aria-label={isNight ? '切换到白天' : '切换到夜晚'}
        >
            <span className={styles.toggleIcon}>{isNight ? '☾' : '☀'}</span>
            {isNight ? '夜晚' : '白天'}
        </button>
    );
}
