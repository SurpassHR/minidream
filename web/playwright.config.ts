import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  // e2e 共享同一个后端图（.director/project.json）：并行时节点增删互相干扰，
  // 串行执行保证断言稳定（13 个用例 ~20s）
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5173',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
