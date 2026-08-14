import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// dev 代理到 Director Server；/ws 走 ws 协议；host 显式绑定 127.0.0.1
// （避免 localhost 解析到 IPv6 ::1 导致 Playwright 等 IPv4 客户端探测失败）
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4777', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:4777', ws: true },
    },
  },
});
