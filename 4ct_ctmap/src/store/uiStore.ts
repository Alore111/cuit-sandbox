import { create } from 'zustand';
import { applyThemeToDocument, persistTheme, readInitialTheme } from '../services/themeService';
import type { ThemeName } from '../types/theme';
import type { ViewPresetName } from '../types/view';

/** 移动端断点：屏幕逻辑宽度（含竖/横屏）低于该值视为移动设备布局 */
export const MOBILE_BREAKPOINT = 768;

function readIsMobile(): boolean {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`).matches;
}

interface UiState {
    theme: ThemeName;
    /** 昼夜过渡动画是否进行中 */
    transitioning: boolean;
    /** 过渡的目标主题（过渡结束后写入 theme） */
    targetTheme: ThemeName;
    /** 左侧面板占宽（含外边距），供相机安全框避让，避免 3D 主体被面板压住 */
    layoutBias: number;
    /** 当前（最近一次点选的）预设机位；3D 侧订阅它做补间 */
    viewPreset: ViewPresetName;
    /** 是否为移动设备布局（≤ MOBILE_BREAKPOINT）。桌面/移动各自渲染独立 UI 外壳 */
    isMobile: boolean;
    /** 移动端底部抽屉可见高度（css px），驱动地图取景上移，保持主体不被抽屉遮住 */
    bottomInset: number;
    /** 事件铭牌点击后请求的镜头聚焦（seq 自增保证同一事件可重复点击触发）；
     * null 表示无请求。3D 侧订阅它，把镜头推到事件锚点。 */
    eventFocusRequest: { eventId: string; seq: number } | null;
    setTheme: (theme: ThemeName) => void;
    toggleTheme: () => void;
    /** 过渡动画结束后由 3D 侧调用，完成主题收尾 */
    finishTransition: () => void;
    setLayoutBias: (bias: number) => void;
    setViewPreset: (preset: ViewPresetName) => void;
    setDevice: (mobile: boolean) => void;
    setBottomInset: (px: number) => void;
    /** 点击事件铭牌时调：请求镜头聚焦到该事件锚点 */
    requestEventFocus: (eventId: string) => void;
}

export const useUiStore = create<UiState>((set, get) => ({
    theme: readInitialTheme(),
    transitioning: false,
    targetTheme: readInitialTheme(),
    layoutBias: 0,
    viewPreset: 'overview',
    isMobile: readIsMobile(),
    bottomInset: 0,
    eventFocusRequest: null,

    setTheme(theme) {
        applyThemeToDocument(theme);
        persistTheme(theme);
        set({ theme, targetTheme: theme });
    },

    toggleTheme() {
        const from = get().theme;
        const to: ThemeName = from === 'night' ? 'day' : 'night';
        /* 立即切换 HUD CSS（触发 CSS transition），3D 侧订阅 transitioning 启动动画 */
        applyThemeToDocument(to);
        set({ transitioning: true, targetTheme: to });
    },

    finishTransition() {
        const target = get().targetTheme;
        persistTheme(target);
        set({ theme: target, transitioning: false });
    },

    setLayoutBias(bias) {
        if (get().layoutBias !== bias) set({ layoutBias: bias });
    },

    setViewPreset(preset) {
        /* 反复点同一个机位也要重新推过去，因此不做等值短路 */
        set({ viewPreset: preset });
    },

    setDevice(mobile) {
        if (get().isMobile !== mobile) set({ isMobile: mobile });
    },

    setBottomInset(px) {
        const v = Math.max(0, Math.round(px));
        if (get().bottomInset !== v) set({ bottomInset: v });
    },

    requestEventFocus(eventId) {
        const prev = get().eventFocusRequest;
        // seq 自增：即使连续点击同一个事件，也会触发新的聚焦
        set({ eventFocusRequest: { eventId, seq: (prev?.seq ?? 0) + 1 } });
    }
}));

/** 在根应用挂载时监听分辨断点，把设备类型写入 uiStore（避免每次渲染都查 matchMedia）。 */
export function initDeviceDetection(): () => void {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const apply = () => useUiStore.getState().setDevice(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
}
