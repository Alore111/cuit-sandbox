/// <reference types="vite/client" />

/** 自定义环境变量（只有 VITE_ 前缀的会被注入前端） */
interface ImportMetaEnv {
    /** 后端地址；留空表示同源（开发期由 vite proxy 转发） */
    readonly VITE_API_BASE?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
