import type { RefObject } from 'react';

/**
 * 3D 主画布。
 * 它是整页的底：HUD 面板全部绝对定位浮在其上，因此这里只负责铺满与可访问性标注。
 * 画布之下垫一层 .sceneBackdrop 作为场景底色 —— 画布自身透明，
 * 底色独立成层后其颜色可以参与昼夜 CSS 过渡。
 */
export function SceneCanvas({
    canvasRef,
    label
}: {
    canvasRef: RefObject<HTMLCanvasElement>;
    label: string;
}) {
    return (
        <>
            <div className="sceneBackdrop" aria-hidden="true" />
            <canvas ref={canvasRef} className="scene" role="img" aria-label={label} />
        </>
    );
}
