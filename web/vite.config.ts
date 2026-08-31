import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 沙箱隔离验证：设置 API_PROXY_TARGET 指向沙箱后端（如 http://127.0.0.1:4778），
// 避免浏览器验证写回真实项目文件；默认仍指向本地后端 4777。
const apiTarget = process.env.API_PROXY_TARGET || 'http://127.0.0.1:4777';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': apiTarget,
      '/assets': apiTarget,
      '/comfyui': apiTarget,
    },
  },
});
