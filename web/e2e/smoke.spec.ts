import { expect, test } from '@playwright/test';

// 冒烟：页面加载出五区；后端未启动时画布为空提示仍可见
test('工作台加载出五区布局', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('left-panel')).toBeVisible();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect(page.getByTestId('agent-panel')).toBeVisible();
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('queue')).toBeVisible();
  await expect(page.locator('.logo-name')).toHaveText('导演工作台');
});

test('素材库空态与导入菜单', async ({ page }) => {
  await page.goto('/');
  // 后端未启动时素材库显示空态（不误显 mock 数据）
  await expect(page.locator('.asset-grid').getByText(/暂无素材/)).toBeVisible();
  // 作用域限定到左侧面板：顶栏也有一个“＋ 导入”按钮（项目导入）
  await page.getByTestId('left-panel').getByText('＋ 导入').click();
  await expect(page.getByText('文字 / 提示词')).toBeVisible();
});
