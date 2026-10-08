import { createRoot } from 'react-dom/client';
import { App } from './App';
import { EditorApp } from './editor/EditorApp';
import { applyThemeToDocument } from './services/themeService';
import { useUiStore } from './store/uiStore';
import './ui/styles/tokens.css';
import './ui/styles/global.css';

/*
 * 主题在挂载前先落到 <html data-theme>，避免首帧闪一下深色底。
 * 这里刻意不用 StrictMode：它会重复挂载副作用，而本应用的世界构建是
 * 「一次建一个 WebGL 上下文、内部持有十万级实例」的重活，重复建/销毁只会白烧时间。
 */
applyThemeToDocument(useUiStore.getState().theme);

const container = document.getElementById('root');
if (!container) {
    throw new Error('找不到挂载点 #root');
}

/*
 * 极简分流：/editor 进编辑器，其余进沙盘。
 * 【口径】只有两个页面，为此引入 react-router 得不偿失；
 * 用 pathname 判断一次即可 —— 两页之间是整页跳转（<a href>），不需要客户端路由。
 */
const isEditor = window.location.pathname.replace(/\/+$/, '').endsWith('/editor');

createRoot(container).render(isEditor ? <EditorApp /> : <App />);
