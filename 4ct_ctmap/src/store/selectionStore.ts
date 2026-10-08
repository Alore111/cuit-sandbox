import { create } from 'zustand';

/**
 * 悬停与选中。
 * 渲染层与 UI 层订阅同一个状态：3D 表现与界面高亮永远同源，
 * 不会出现「名录高亮的和相机对准的不是同一栋」。
 */
interface SelectionState {
    hoveredId: string | null;
    selectedId: string | null;
    setHovered: (id: string | null) => void;
    select: (id: string | null) => void;
}

export const useSelectionStore = create<SelectionState>((set) => ({
    hoveredId: null,
    selectedId: null,

    setHovered(id) {
        set({ hoveredId: id });
    },

    select(id) {
        set({ selectedId: id });
    }
}));
