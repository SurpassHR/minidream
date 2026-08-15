import { expect, test } from '@playwright/test';
import type { DirectorEdge, DirectorNode } from '../src/types';

// 分镜多接口圆点：剧情/文字/视频/图像 四组 + 类型校验。
// 覆盖：图像接口接受 keyframe（图像源）；文字源连图像接口被拒（toast）；
// shot→shot 剧情链自动落到剧情接口（chain-0）
async function setup(page: import('@playwright/test').Page, tag: string, yBase = 260) {
  const created: string[] = [];
  const mk = async (type: string, title: string, x: number, y: number, fields?: Record<string, unknown>) => {
    const r = await page.request.post('/api/nodes', { data: { type, title, position: { x, y: yBase + y }, fields } });
    const node = ((await r.json()) as { node: DirectorNode }).node;
    created.push(node.id);
    return node;
  };
  return { mk, cleanup: async () => { for (const id of created) await page.request.delete(`/api/nodes/${id}?confirm=true`); } };
}

test('图像接口：keyframe 拖线到 image-0 透传 targetHandle 并自动追加', async ({ page }) => {
  const { mk, cleanup } = await setup(page, `e2e-inlet-${Date.now()}`, 200);
  try {
    const kf = await mk('keyframe', 'KF 01', 60, 0);
    const shot = await mk('shot', 'SHOT 01', 460, 0);
    await page.goto('/');

    const shotNode = page.locator(`.react-flow__node[data-id="${shot.id}"]`);
    await expect(shotNode.locator('.shot .inlet-label')).toHaveText(['剧情', '文字', '视频', '图像']);
    const image0 = shotNode.locator('.react-flow__handle.target[data-handleid="image-0"]');
    await expect(image0).toBeVisible();

    // 真实鼠标拖线：keyframe 右侧输出 → 分镜 image-0 圆点
    const src = page.locator(`.react-flow__node[data-id="${kf.id}"] .react-flow__handle.source`);
    const s = await src.boundingBox();
    const d = await image0.boundingBox();
    expect(s && d).toBeTruthy();
    await page.mouse.move((s?.x ?? 0) + (s?.width ?? 0) / 2, (s?.y ?? 0) + (s?.height ?? 0) / 2);
    await expect(src).toHaveClass(/connectionindicator/);
    await page.mouse.down();
    await page.mouse.move((d?.x ?? 0) + (d?.width ?? 0) / 2, (d?.y ?? 0) + (d?.height ?? 0) / 2, { steps: 8 });
    await page.mouse.up();

    const g = await (await page.request.get('/api/graph')).json();
    const edge = (g.graph.edges as DirectorEdge[]).find((e) => e.source === kf.id && e.target === shot.id);
    expect(edge?.targetHandle).toBe('image-0');
    // image-0 被占用 → 自动追加 image-1（标签「图像」×2）
    await expect(shotNode.locator('.react-flow__handle.target[data-handleid="image-1"]')).toBeVisible();
    await expect(shotNode.locator('.shot .inlet-label')).toHaveText(['剧情', '文字', '视频', '图像', '图像']);
  } finally { await cleanup(); }
});

test('类型校验：文字节点（prompt）连图像接口被拒并提示', async ({ page }) => {
  const { mk, cleanup } = await setup(page, `e2e-reject-${Date.now()}`, 440);
  try {
    const prompt = await mk('prompt', 'PROMPT 01', 60, 0);
    const shot = await mk('shot', 'SHOT 01', 460, 0);
    await page.goto('/');
    const shotNode = page.locator(`.react-flow__node[data-id="${shot.id}"]`);
    const image0 = shotNode.locator('.react-flow__handle.target[data-handleid="image-0"]');
    await expect(image0).toBeVisible();

    const src = page.locator(`.react-flow__node[data-id="${prompt.id}"] .react-flow__handle.source`);
    const s = await src.boundingBox();
    const d = await image0.boundingBox();
    expect(s && d).toBeTruthy();
    await page.mouse.move((s?.x ?? 0) + (s?.width ?? 0) / 2, (s?.y ?? 0) + (s?.height ?? 0) / 2);
    await expect(src).toHaveClass(/connectionindicator/);
    await page.mouse.down();
    await page.mouse.move((d?.x ?? 0) + (d?.width ?? 0) / 2, (d?.y ?? 0) + (d?.height ?? 0) / 2, { steps: 8 });
    await page.mouse.up();

    // 拒绝提示出现；边未创建
    await expect(page.locator('.canvas-toast')).toContainText('接口类型不匹配');
    const g = await (await page.request.get('/api/graph')).json();
    expect((g.graph.edges as DirectorEdge[]).some((e) => e.source === prompt.id && e.target === shot.id)).toBe(false);
  } finally { await cleanup(); }
});

test('剧情链：shot 拖 shot 自动落到剧情接口 chain-0（source 圆点可拖）', async ({ page }) => {
  const { mk, cleanup } = await setup(page, `e2e-chain-${Date.now()}`, 600);
  try {
    const a = await mk('shot', 'SHOT A', 60, 0);
    const b = await mk('shot', 'SHOT B', 460, 0);
    await page.goto('/');
    const aNode = page.locator(`.react-flow__node[data-id="${a.id}"]`);
    const bNode = page.locator(`.react-flow__node[data-id="${b.id}"]`);
    // 剧情接口存在（琥珀圆点）+ 标题在接口区上方
    await expect(bNode.locator('.shot .inlet-label')).toHaveText(['剧情', '文字', '视频', '图像']);

    // 从 A 右侧 source 拖到 B 节点主体 → chain 边自动落到 chain-0
    const src = aNode.locator('.react-flow__handle.source');
    const s = await src.boundingBox();
    const bBox = await bNode.boundingBox();
    expect(s && bBox).toBeTruthy();
    await page.mouse.move((s?.x ?? 0) + (s?.width ?? 0) / 2, (s?.y ?? 0) + (s?.height ?? 0) / 2);
    await expect(src).toHaveClass(/connectionindicator/);
    await page.mouse.down();
    // 目标：B 节点中心（fitView 缩放后节点高度变小，固定偏移会超出节点导致取消）
    await page.mouse.move((bBox?.x ?? 0) + (bBox?.width ?? 0) * 0.3, (bBox?.y ?? 0) + (bBox?.height ?? 0) * 0.5, { steps: 8 });
    await page.mouse.up();

    const g = await (await page.request.get('/api/graph')).json();
    const edge = (g.graph.edges as DirectorEdge[]).find((e) => e.source === a.id && e.target === b.id);
    expect(edge?.kind).toBe('chain');
    expect(edge?.targetHandle).toBe('chain-0');
  } finally { await cleanup(); }
});
