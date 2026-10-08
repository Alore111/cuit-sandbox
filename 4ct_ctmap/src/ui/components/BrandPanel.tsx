import type { School } from '../../contract';
import styles from '../styles/hud.module.css';

/** 品牌面板：圆徽取自 public/LOGO.png，标题与副标题仍来自数据（换学校只改 school.json） */
export function BrandPanel({ school }: { school: School }) {
    return (
        <header className={`${styles.panel} ${styles.brand}`}>
            {/* 取像规则统一在 global.css 的 .schoolEmblem，这里只声明展示尺寸 */}
            <span className={`schoolEmblem ${styles.brandMark}`} aria-hidden="true" />
            <div>
                <div className={styles.brandTitle}>{school.title}</div>
                <div className={styles.brandSub}>
                    {school.subtitle} / {school.campusName}
                </div>
            </div>
        </header>
    );
}
