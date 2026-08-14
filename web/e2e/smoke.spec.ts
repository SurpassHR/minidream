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
  // 空素材库显示空态卡片（非 mock）
  await expect(page.getByTestId('asset-empty')).toBeVisible();
  await expect(page.getByText('素材库是空的')).toBeVisible();
  // 作用域限定到左侧面板：顶栏也有一个“＋ 导入”按钮（项目导入）；
  // 空态内另有“＋ 导入素材”按钮，需精确匹配工具栏按钮
  await page.getByTestId('left-panel').getByText('＋ 导入', { exact: true }).click();
  await expect(page.getByText('文字 / 提示词')).toBeVisible();
});
test('项目栏：真实项目列表 + 当前项目高亮 + 头部项目名一致', async ({ page }) => {
  await page.goto('/');
  // 当前项目项高亮（来自 /api/projects，非 mock）
  const active = page.locator('.proj.active');
  await expect(active).toHaveCount(1);
  // 头部项目名与项目栏当前项一致
  const header = (await page.getByTestId('project-name').textContent())?.trim() ?? '';
  await expect(active.locator('.pname')).toHaveText(header);
  // 项目项可点击（切换接口可调用；不切换当前项避免影响其他用例）
  await expect(active).toBeVisible();
});

test('时间线：剧情时间轴（SEG + 真实时间码）+ 版本历史面板分离', async ({ page }) => {
  // 自备数据：图内无 shot 节点时创建 3 个（各 3.75s），保证剧情时间轴可渲染
  const g = await (await page.request.get('/api/graph')).json();
  const shots = g.graph.nodes.filter((n: { type: string }) => n.type === 'shot');
  if (shots.length === 0) {
    for (const [title, start] of [['SHOT 01', 0], ['SHOT 02', 3.75], ['SHOT 03', 7.5]] as const) {
      await page.request.post('/api/nodes', { data: {
        type: 'shot', title, fields: { duration: '3.75s', start },
      } });
    }
  }
  await page.goto('/');
  // 分镜段（SEG）沿剧情时间轴渲染
  await expect(page.locator('.seg')).toHaveCount(3);
  await expect(page.getByText(/SEG 01/)).toBeVisible();
  // 标尺末刻度 = 真实总时长 3 × 3.75s
  await expect(page.locator('.tl-ruler .tick').nth(3)).toHaveText('00:11.250');
  // 时间轴内不再有快照标记；快照在独立的版本历史面板（按时间倒序、可回滚）
  await expect(page.locator('.timeline .snap')).toHaveCount(0);
  const versions = page.getByTestId('versions');
  await expect(versions).toBeVisible();
  await expect(versions.locator('.v-row').first()).toBeVisible();
  await expect(versions.getByText(/SN-/).first()).toBeVisible();
  // 点击版本行 → 出现回滚按钮
  await versions.locator('.v-row').first().click();
  await expect(versions.getByText('↩ 回滚')).toBeVisible();
});

test('素材库：拖入图像自动入库并显示', async ({ page }) => {
  await page.goto('/');
  // 构造真实 File + DataTransfer 派发 drop（模拟从系统拖入图片）
  await page.locator('.assets').evaluate((el) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'e2e-drop.png', { type: 'image/png' }));
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await expect(page.locator('.asset-card', { hasText: 'e2e-drop.png' })).toBeVisible();
  // 清理：删除该素材避免污染素材库
  const assets = await (await page.request.get('/api/assets')).json();
  const hit = assets.assets.find((a: { name: string }) => a.name === 'e2e-drop.png');
  if (hit) await page.request.delete(`/api/assets/${hit.id}?confirm=true`);
});

test('素材库：Ctrl+V 粘贴图像自动入库', async ({ page }) => {
  await page.goto('/');
  await page.locator('.assets').evaluate((el) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'e2e-paste.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
  });
  await expect(page.locator('.asset-card', { hasText: 'e2e-paste.png' })).toBeVisible();
  const assets = await (await page.request.get('/api/assets')).json();
  const hit = assets.assets.find((a: { name: string }) => a.name === 'e2e-paste.png');
  if (hit) await page.request.delete(`/api/assets/${hit.id}?confirm=true`);
});

test('面板分割条：拖拽调整左栏宽度并持久化', async ({ page }) => {
  await page.goto('/');
  const left = page.getByTestId('left-panel');
  const splitter = page.getByTestId('splitter-left');
  const box = await splitter.boundingBox();
  expect(box).not.toBeNull();
  // 拖拽：按下 → 移动 +80px → 抬起
  await page.mouse.move((box?.x ?? 0) + 2, (box?.y ?? 0) + 200);
  await page.mouse.down();
  await page.mouse.move((box?.x ?? 0) + 82, (box?.y ?? 0) + 200, { steps: 5 });
  await page.mouse.up();
  const basis = await left.evaluate((el) => (el as HTMLElement).style.flexBasis);
  expect(Number.parseFloat(basis)).toBeGreaterThan(232);
  // 持久化
  const stored = await page.evaluate(() => localStorage.getItem('dw:leftW'));
  expect(Number(stored)).toBeGreaterThan(232);
});