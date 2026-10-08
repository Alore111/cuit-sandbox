import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** 后端端口：与 4ct_ctmap_server 的 PORT 保持一致 */
const SERVER_ORIGIN = process.env.VITE_DEV_SERVER_ORIGIN ?? 'http://127.0.0.1:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    /* 前端只写相对路径 /api/...，后端地址只出现在这一处与 VITE_API_BASE */
    proxy: {
      '/api': { target: SERVER_ORIGIN, changeOrigin: true }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: false
  }
});
