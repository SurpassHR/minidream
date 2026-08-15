import { expect, test } from '@playwright/test';
import type { DirectorNode } from '../src/types';

// 交互修复验证：Delete 键删除节点 / Ctrl 框选 / 素材拖放位置
async function setup(page: import('@playwright/test').Page, yBase = 200) {
  const created: string[] = [];
  const mk = async (type: string, title: string, x: number, y: number) => {
    const r = await page.request.post('/api/nodes', { data: { type, title, position: { x, y: yBase + y } } });
    const node = ((await r.json()) as { node: DirectorNode }).node;
    created.push(node.id);
    return node;
  };
  return {
    mk,
    cleanup: async () => { for (const id of created.splice(0)) await page.request.delete(`/api/nodes/${id}?confirm=true`); },
  };
}

// 等待 fitView 完成（节点屏幕位置稳定）：图加载时 fitView 会在节点初始化后
// 重新执行一次，直接操作会与 viewport 变化竞态（框选区域/拖放换算漂移）
async function waitViewportStable(page: import('@playwright/test').Page) {
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  let prev = '';
  for (let i = 0; i < 10; i++) {
    const box = await page.locator('.react-flow__node').first().boundingBox();
    const key = box ? `${Math.round(box.x)},${Math.round(box.y)}` : '';
    if (key && key === prev) return;
    prev = key;
    await page.waitForTimeout(350);
  }
}

test('Delete 键删除选中节点（前端移除 + 后端同步）', async ({ page }) => {
  const { mk, cleanup } = await setup(page);
  try {
    const node = await mk('shot', `SHOT ${Date.now()}`, 900, 0);
    await page.goto('/');
    const nodeEl = page.locator(`.react-flow__node[data-id="${node.id}"]`);
    await expect(nodeEl).toBeVisible();
    await nodeEl.click();
    await expect(nodeEl).toHaveClass(/selected/);
    await page.keyboard.press('Delete');
    await expect(nodeEl).toHaveCount(0);
    const g = await (await page.request.get('/api/graph')).json();
    expect((g.graph.nodes as DirectorNode[]).some((n) => n.id === node.id)).toBe(false);
  } finally { await cleanup(); }
});

test('Ctrl 拖拽框选多个节点', async ({ page }) => {
  const { mk, cleanup } = await setup(page);
  try {
    const a = await mk('shot', `A ${Date.now()}`, 760, 0);
    const b = await mk('shot', `B ${Date.now()}`, 1120, 0);
    await page.goto('/');
    const aEl = page.locator(`.react-flow__node[data-id="${a.id}"]`);
    const bEl = page.locator(`.react-flow__node[data-id="${b.id}"]`);
    await waitViewportStable(page);
    // 动态计算框选区域：以两个节点包围盒向外扩 40px（避免命中其他节点），
    // 并钳制到画布区域（fitView 放大时节点可能贴画布边缘，越界会命中左侧面板）
    const ab = await aEl.boundingBox();
    const bb = await bEl.boundingBox();
    const cvs = await page.locator('.canvas-wrap').boundingBox();
    expect(ab && bb && cvs).toBeTruthy();
    const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
    const sx = clamp(Math.min(ab!.x, bb!.x) - 40, cvs!.x + 4, cvs!.x + cvs!.width - 10);
    const sy = clamp(Math.min(ab!.y, bb!.y) - 40, cvs!.y + 4, cvs!.y + cvs!.height - 10);
    const ex = clamp(Math.max(ab!.x + ab!.width, bb!.x + bb!.width) + 40, cvs!.x + 10, cvs!.x + cvs!.width - 4);
    const ey = clamp(Math.max(ab!.y + ab!.height, bb!.y + bb!.height) + 40, cvs!.y + 10, cvs!.y + cvs!.height - 4);
    await page.keyboard.down('Control');
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(ex, ey, { steps: 12 });
    await page.mouse.up();
    await page.keyboard.up('Control');
    await expect(aEl).toHaveClass(/selected/);
    await expect(bEl).toHaveClass(/selected/);
  } finally { await cleanup(); }
});

test('素材拖到画布：节点出现在松手处（画布坐标换算）', async ({ page }) => {
  const { mk, cleanup } = await setup(page);
  await page.goto('/');
  try {
    // 自备一个节点并等 fitView 稳定（图空时 fitView 在节点加载后重跑，
    // screenToFlowPosition 换算会随 viewport 漂移）
    const anchor = await mk('shot', `ANCHOR ${Date.now()}`, 300, 0);
    await waitViewportStable(page);
    // 模拟从素材库拖出并松手在画布 (dropX, dropY)
    const dropX = 460;
    const dropY = 260;
    await page.locator('.react-flow').evaluate((el, [x, y]) => {
      const dt = new DataTransfer();
      dt.setData('application/x-asset', JSON.stringify({ id: 'e2e-asset', kind: 'img', name: `e2e-drop-${Date.now()}.png` }));
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
    }, [dropX, dropY] as const);

    // 等 asset 节点出现：节点中心 ≈ 松手点（画布坐标换算正确）
    const nodeHead = page.locator('.react-flow__node .node-head', { hasText: '素材 e2e-drop-' });
    await expect(nodeHead).toBeVisible();
    const rfNode = nodeHead.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " react-flow__node ")]');
    const box = await rfNode.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.abs((box?.x ?? 0) + (box?.width ?? 0) / 2 - dropX)).toBeLessThan(40);
    expect(Math.abs((box?.y ?? 0) + (box?.height ?? 0) / 2 - dropY)).toBeLessThan(40);
    // 清理后端创建的节点
    const g = await (await page.request.get('/api/graph')).json();
    const node = (g.graph.nodes as DirectorNode[]).find((n) => String(n.fields?.assetName).startsWith('e2e-drop-'));
    if (node) await page.request.delete(`/api/nodes/${node.id}?confirm=true`);
  } finally {
    // 兜底清理（失败路径）
    const g = await (await page.request.get('/api/graph')).json();
    for (const n of (g.graph.nodes as DirectorNode[]).filter((n) => String(n.fields?.assetName).startsWith('e2e-drop-'))) {
      await page.request.delete(`/api/nodes/${n.id}?confirm=true`);
    }
  }
});
