import { expect, test } from '@playwright/test';
import type { DirectorEdge, DirectorNode } from '../src/types';

// 连线终点拖拽重连：拖到另一个同类型圆点 → targetHandle 更新为所拖圆点；
// 拖到错误类型圆点 → 拒绝并提示，旧边保持

// 前置清空图：其他测试（smoke 时间线等）会残留位于 (0,0) 的节点，
// fitView 后可能与本测试的拖线/重连目标区域重叠，导致松手点误命中残留圆点
test.beforeAll(async ({ request }) => {
  const g = await (await request.get('/api/graph')).json();
  for (const n of (g.graph.nodes as DirectorNode[])) {
    await request.delete(`/api/nodes/${n.id}?confirm=true`);
  }
});
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

// 从源节点拖线到目标圆点（公共拖线流程）；等待 WS 回推稳定后再返回
async function dragConnect(
  page: import('@playwright/test').Page,
  srcSel: string,
  dstSel: string,
): Promise<void> {
  const src = page.locator(srcSel);
  await src.scrollIntoViewIfNeeded();
  const s = await src.boundingBox();
  const d = await page.locator(dstSel).boundingBox();
  expect(s && d).toBeTruthy();
  await page.mouse.move((s?.x ?? 0) + (s?.width ?? 0) / 2, (s?.y ?? 0) + (s?.height ?? 0) / 2);
  await expect(src).toHaveClass(/connectionindicator/);
  await page.mouse.down();
  await page.mouse.move((d?.x ?? 0) + (d?.width ?? 0) / 2, (d?.y ?? 0) + (d?.height ?? 0) / 2, { steps: 8 });
  await page.mouse.up();
  // 等后端边创建 + WS 回推（store 圆点占用状态与 DOM 稳定）
  await page.waitForTimeout(500);
}

test('重连：终点拖到另一个图像圆点（image-1），targetHandle 更新', async ({ page }) => {
  const { mk, cleanup } = await setup(page);
  try {
    const kf = await mk('keyframe', 'KF 01', 60, 0);
    const shot = await mk('shot', 'SHOT 01', 460, 0);
    await page.goto('/');
    const shotNode = page.locator(`.react-flow__node[data-id="${shot.id}"]`);
    // 先连 image-0
    await dragConnect(page, `.react-flow__node[data-id="${kf.id}"] .react-flow__handle.source`,
      `.react-flow__node[data-id="${shot.id}"] .react-flow__handle.target[data-handleid="image-0"]`);
    await expect(page.locator('.edge-drag-handle').first()).toBeVisible();

    // 拖拽边终点 → image-1 圆点
    const drag = page.locator('.edge-drag-handle').first();
    const dh = await drag.boundingBox();
    const i1 = await page.locator(`.react-flow__node[data-id="${shot.id}"] .react-flow__handle.target[data-handleid="image-1"]`).boundingBox();
    expect(dh && i1).toBeTruthy();
    await page.mouse.move((dh?.x ?? 0) + (dh?.width ?? 0) / 2, (dh?.y ?? 0) + (dh?.height ?? 0) / 2);
    await page.mouse.down();
    await page.mouse.move((i1?.x ?? 0) + (i1?.width ?? 0) / 2, (i1?.y ?? 0) + (i1?.height ?? 0) / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(600);

    // 后端：唯一一条 kf→shot 边，targetHandle=image-1
    const g = await (await page.request.get('/api/graph')).json();
    const edges = (g.graph.edges as DirectorEdge[]).filter((e) => e.source === kf.id && e.target === shot.id);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.targetHandle).toBe('image-1');
  } finally { await cleanup(); }
});

test('chain 重连：SHOT1→SHOT2 的箭头拖到 SHOT3 剧情圆点，落到 SHOT3', async ({ page }) => {
  const { mk, cleanup } = await setup(page, 700);
  try {
    const a = await mk('shot', 'SHOT A', 60, 0);
    const b = await mk('shot', 'SHOT B', 460, 0);
    const c = await mk('shot', 'SHOT C', 860, 0);
    await page.goto('/');
    // SHOT A → SHOT B 剧情链（chain 自动落 chain-0）
    const aEl = page.locator(`.react-flow__node[data-id="${a.id}"]`);
    const bEl = page.locator(`.react-flow__node[data-id="${b.id}"]`);
    await expect(bEl.locator('.shot .inlet-label')).toHaveText(['剧情', '文字', '视频', '图像']);
    const src = aEl.locator('.react-flow__handle.source');
    const s = await src.boundingBox();
    const bBox = await bEl.boundingBox();
    expect(s && bBox).toBeTruthy();
    await page.mouse.move((s?.x ?? 0) + (s?.width ?? 0) / 2, (s?.y ?? 0) + (s?.height ?? 0) / 2);
    await expect(src).toHaveClass(/connectionindicator/);
    await page.mouse.down();
    await page.mouse.move((bBox?.x ?? 0) + (bBox?.width ?? 0) * 0.3, (bBox?.y ?? 0) + (bBox?.height ?? 0) * 0.5, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    let g = await (await page.request.get('/api/graph')).json();
    let edges = (g.graph.edges as DirectorEdge[]).filter((e) => e.kind === 'chain');
    expect(edges).toHaveLength(1);
    expect(edges[0]?.target).toBe(b.id);

    // 从 SHOT B 的箭头（拖拽点）拖到 SHOT C 的剧情圆点 chain-0
    const cEl = page.locator(`.react-flow__node[data-id="${c.id}"]`);
    const chain0 = cEl.locator('.react-flow__handle.target[data-handleid="chain-0"]');
    await expect(chain0).toBeVisible();
    const drag = page.locator('.edge-drag-handle').first();
    const dh = await drag.boundingBox();
    const c0 = await chain0.boundingBox();
    expect(dh && c0).toBeTruthy();
    await page.mouse.move((dh?.x ?? 0) + (dh?.width ?? 0) / 2, (dh?.y ?? 0) + (dh?.height ?? 0) / 2);
    await page.mouse.down();
    await page.mouse.move((c0?.x ?? 0) + (c0?.width ?? 0) / 2, (c0?.y ?? 0) + (c0?.height ?? 0) / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(600);

    // 箭头落到 SHOT C（旧边被替换删除）
    g = await (await page.request.get('/api/graph')).json();
    edges = (g.graph.edges as DirectorEdge[]).filter((e) => e.kind === 'chain');
    expect(edges).toHaveLength(1);
    expect(edges[0]?.source).toBe(a.id);
    expect(edges[0]?.target).toBe(c.id);
    expect(edges[0]?.targetHandle).toBe('chain-0');
  } finally { await cleanup(); }
});

test('创建后立即重连（乐观边稳定前）：旧箭头不残留且落到目标', async ({ page }) => {
  const { mk, cleanup } = await setup(page, 900);
  try {
    const a = await mk('shot', 'SHOT A', 60, 0);
    const b = await mk('shot', 'SHOT B', 460, 0);
    const c = await mk('shot', 'SHOT C', 860, 0);
    await page.goto('/');
    // A → B（不等 WS 回推，立即重连模拟快速操作）
    const aEl = page.locator(`.react-flow__node[data-id="${a.id}"]`);
    const bEl = page.locator(`.react-flow__node[data-id="${b.id}"]`);
    const cEl = page.locator(`.react-flow__node[data-id="${c.id}"]`);
    const src = aEl.locator('.react-flow__handle.source');
    const s = await src.boundingBox();
    const bBox = await bEl.boundingBox();
    await page.mouse.move((s?.x ?? 0) + (s?.width ?? 0) / 2, (s?.y ?? 0) + (s?.height ?? 0) / 2);
    await expect(src).toHaveClass(/connectionindicator/);
    await page.mouse.down();
    await page.mouse.move((bBox?.x ?? 0) + (bBox?.width ?? 0) * 0.3, (bBox?.y ?? 0) + (bBox?.height ?? 0) * 0.5, { steps: 8 });
    await page.mouse.up();
    // 拖拽点只在乐观边稳定（后端 id 回推）后出现；等它出现再重连
    const drag = page.locator('.edge-drag-handle').first();
    await expect(drag).toBeVisible();
    const chain0 = cEl.locator('.react-flow__handle.target[data-handleid="chain-0"]');
    const dh = await drag.boundingBox();
    const c0 = await chain0.boundingBox();
    expect(dh && c0).toBeTruthy();
    await page.mouse.move((dh?.x ?? 0) + (dh?.width ?? 0) / 2, (dh?.y ?? 0) + (dh?.height ?? 0) / 2);
    await page.mouse.down();
    await page.mouse.move((c0?.x ?? 0) + (c0?.width ?? 0) / 2, (c0?.y ?? 0) + (c0?.height ?? 0) / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(1000);
    // 前端 1 条边 + 后端 1 条（A→C），旧边被原子替换删除
    expect(await page.evaluate(() => document.querySelectorAll('.react-flow__edge').length)).toBe(1);
    const g = await (await page.request.get('/api/graph')).json();
    const edges = (g.graph.edges as DirectorEdge[]);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.source).toBe(a.id);
    expect(edges[0]?.target).toBe(c.id);
  } finally { await cleanup(); }
});

test('重连：终点拖到错误类型圆点（text-0）被拒，旧边保持并提示', async ({ page }) => {
  const { mk, cleanup } = await setup(page, 400);
  try {
    const kf = await mk('keyframe', 'KF 01', 60, 0);
    const shot = await mk('shot', 'SHOT 01', 460, 0);
    await page.goto('/');
    await dragConnect(page, `.react-flow__node[data-id="${kf.id}"] .react-flow__handle.source`,
      `.react-flow__node[data-id="${shot.id}"] .react-flow__handle.target[data-handleid="image-0"]`);
    await expect(page.locator('.edge-drag-handle').first()).toBeVisible();

    // 拖边终点 → text-0（错误类型：keyframe 是图像源）
    const drag = page.locator('.edge-drag-handle').first();
    const dh = await drag.boundingBox();
    const t0 = await page.locator(`.react-flow__node[data-id="${shot.id}"] .react-flow__handle.target[data-handleid="text-0"]`).boundingBox();
    expect(dh && t0).toBeTruthy();
    await page.mouse.move((dh?.x ?? 0) + (dh?.width ?? 0) / 2, (dh?.y ?? 0) + (dh?.height ?? 0) / 2);
    await page.mouse.down();
    await page.mouse.move((t0?.x ?? 0) + (t0?.width ?? 0) / 2, (t0?.y ?? 0) + (t0?.height ?? 0) / 2, { steps: 8 });
    await page.mouse.up();

    // 提示出现；边保持 image-0（未重连）
    await expect(page.locator('.canvas-toast')).toContainText('接口类型不匹配');
    const g = await (await page.request.get('/api/graph')).json();
    const edges = (g.graph.edges as DirectorEdge[]).filter((e) => e.source === kf.id && e.target === shot.id);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.targetHandle).toBe('image-0');
  } finally { await cleanup(); }
});
