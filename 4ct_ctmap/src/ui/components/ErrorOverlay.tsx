import styles from '../styles/overlay.module.css';

/** 错误遮罩：数据非法、世界构建失败、WebGL2 不可用都走这里，明确给出原因 */
export function ErrorOverlay({ title, message }: { title: string; message: string }) {
    return (
        <div className={`${styles.overlay} ${styles.overlayFade}`}>
            <div className={styles.inner}>
                <div className={styles.title}>{title}</div>
                <div className={styles.sub}>{message}</div>
            </div>
        </div>
    );
}
