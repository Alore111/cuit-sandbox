import { useState } from 'react';
import type { RenderWarning } from '../../types/world';
import { useMapStore } from '../../store/mapStore';
import styles from '../styles/hud.module.css';

/** 稳定的空数组：选择器每次返回同一个引用，避免无谓的重渲染 */
const NO_WARNINGS: RenderWarning[] = [];

/**
 * 数据告警：数据合法但栅格化后一格都出不来（轮廓太小、或整条落在校园边界外）。
 * 由渲染层汇总，在 HUD 上显性化 —— 不静默丢弃，也不打断使用。
 */
export function DataWarningBadge() {
    const warnings = useMapStore((state) => state.world?.warnings ?? NO_WARNINGS);
    const [open, setOpen] = useState(false);

    if (warnings.length === 0) return null;

    return (
        <div className={styles.warnBadge} onClick={() => setOpen((value) => !value)}>
            数据告警 {warnings.length}
            {open ? (
                <div className={styles.warnPanel}>
                    <p className={styles.warnTitle}>以下条目未参与渲染</p>
                    <ul className={styles.warnList}>
                        {warnings.map((warning) => (
                            <li key={`${warning.kind}-${warning.id}`}>
                                <b>{warning.name}</b>（{warning.kind === 'building' ? '建筑' : '地皮'}{' '}
                                {warning.id}）：{warning.reason}
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}
        </div>
    );
}
