import { useMemo } from 'react';
import styles from '../styles/hud.module.css';

/** 精确指针（鼠标）才提示悬停；触摸端没有 hover 语义 */
export function isFinePointer(): boolean {
    return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

export function HintBar() {
    const fine = useMemo(isFinePointer, []);

    return (
        <div className={styles.hint}>
            {fine
                ? '拖拽旋转 · 滚轮缩放 · 点击建筑查看详情 · Esc 取消选中'
                : '单指拖动旋转 · 双指缩放 · 点击建筑查看详情'}
        </div>
    );
}
