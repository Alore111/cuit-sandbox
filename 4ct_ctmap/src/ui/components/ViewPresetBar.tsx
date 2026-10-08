import { useUiStore } from '../../store/uiStore';
import { VIEW_PRESET_NAMES, type ViewPresetName } from '../../types/view';
import styles from '../styles/hud.module.css';

/** 预设机位的按钮文案（几何口径在 render/view/presets.ts，UI 只认名字） */
const PRESET_LABELS: Record<ViewPresetName, string> = {
    overview: '全景',
    top: '俯瞰',
    orbit: '环岛',
    ground: '贴地'
};

/**
 * 视角预设条：点一下就把镜头平滑推到该机位。
 * 当前高亮的是「最近一次点选的机位」，手动转视角后高亮不会跟着变 ——
 * 这里刻意不做反向识别，避免把用户的自由操作误判成某个预设。
 */
export function ViewPresetBar() {
    const viewPreset = useUiStore((state) => state.viewPreset);
    const setViewPreset = useUiStore((state) => state.setViewPreset);

    return (
        <div className={styles.viewBar}>
            {VIEW_PRESET_NAMES.map((name) => (
                <button
                    key={name}
                    type="button"
                    className={
                        name === viewPreset
                            ? `${styles.viewBarBtn} ${styles.viewBarBtnActive}`
                            : styles.viewBarBtn
                    }
                    onClick={() => setViewPreset(name)}
                >
                    {PRESET_LABELS[name]}
                </button>
            ))}
        </div>
    );
}
