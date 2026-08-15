import { expect, test } from '@playwright/test';
import type { DirectorNode } from '../src/types';

// 快照交互：点击直接回滚（免确认）、未来分支变灰、Ctrl+Z/Y 撤销重做、覆盖需确认。
// 后端保留最近 300 个快照（历史累积），断言一律用相对 seq（baseSeq 之后的新链）

test.beforeAll(async ({ request }) => {
  // 历史存在灰色分支时才批准（否则 approve 标志残留会让后续覆盖场景自动放行）
  const s = await (await request.get('/api/snapshots')).json();
  const maxSeq = (s.snapshots as Array<{ seq: number }>).at(-1)?.seq ?? 0;
  if ((s.headSeq as number) < maxSeq) {
    await request.post('/api/snapshots/approve-overwrite', {});
  }
  // 清空图节点（若上一步批准了，第一个删除会覆盖历史灰色分支）
  const g = await (await request.get('/api/graph')).json();
  for (const n of (g.graph.nodes as DirectorNode[])) {
    await request.delete(`/api/nodes/${n.id}?confirm=true`);
  }
});

test('点击快照直接回滚 → 未来变灰 → Ctrl+Z/Y → 新操作覆盖需确认', async ({ page }) => {
  // 自备数据：4 个节点 = 新链 4 个快照（seq baseSeq+1..+4）
  const created: string[] = [];
  const snap0 = await (await page.request.get('/api/snapshots')).json();
  const baseSeq = snap0.headSeq as number;
  for (let i = 1; i <= 4; i++) {
    const r = await page.request.post('/api/nodes', { data: { type: 'shot', title: `SHOT ${i}`, position: { x: 100 + i * 60, y: 200 } } });
    created.push(((await r.json()) as { node: DirectorNode }).node.id);
  }
  try {
    await page.goto('/');
    const versions = page.getByTestId('versions');
    // 新链 4 个版本，HEAD=最新（无灰色）
    await expect(versions.getByTestId(`version-${baseSeq + 4}`)).toBeVisible();
    await expect(versions.locator('.v-row.future')).toHaveCount(0);
    await expect(versions.getByTestId(`version-${baseSeq + 4}`)).toHaveClass(/sel/);

    // 点击新链第 2 个快照 → 直接回滚（免确认：无对话框出现）
    await versions.getByTestId(`version-${baseSeq + 2}`).click();
    await expect(page.locator('.dialog-mask')).toHaveCount(0);
    let g = await (await page.request.get('/api/graph')).json();
    expect((g.graph.nodes as DirectorNode[]).map((n) => n.title)).toEqual(['SHOT 1', 'SHOT 2']);
    // 其后 2 个快照变灰（未来分支），HEAD 行高亮
    await expect(versions.locator('.v-row.future')).toHaveCount(2);
    await expect(versions.getByTestId(`version-${baseSeq + 2}`)).toHaveClass(/sel/);

    // Ctrl+Z 撤销：HEAD 后退一个快照（图 1 节点，灰色 3）
    await page.keyboard.press('Control+z');
    await expect(versions.getByTestId(`version-${baseSeq + 1}`)).toHaveClass(/sel/);
    await expect(versions.locator('.v-row.future')).toHaveCount(3);
    g = await (await page.request.get('/api/graph')).json();
    expect((g.graph.nodes as DirectorNode[])).toHaveLength(1);

    // Ctrl+Y 重做：HEAD 前进回第 2 个快照
    await page.keyboard.press('Control+y');
    await expect(versions.getByTestId(`version-${baseSeq + 2}`)).toHaveClass(/sel/);
    g = await (await page.request.get('/api/graph')).json();
    expect((g.graph.nodes as DirectorNode[])).toHaveLength(2);

    // 右键新建分镜（页面内写操作）→ 覆盖未来快照需确认
    const pane = page.locator('.react-flow__pane');
    await pane.click({ position: { x: 500, y: 400 }, button: 'right' });
    await page.getByText('＋ 新建分镜节点').click();
    await expect(page.locator('.dialog-mask')).toBeVisible();
    await expect(page.getByText('覆盖未来快照')).toBeVisible();
    await page.getByRole('button', { name: '确认删除' }).click();
    // 确认后自动重放：节点创建成功，未来快照被覆盖（灰色清空）
    await expect(page.locator('.dialog-mask')).toHaveCount(0);
    g = await (await page.request.get('/api/graph')).json();
    expect((g.graph.nodes as DirectorNode[])).toHaveLength(3);
    await expect(versions.locator('.v-row.future')).toHaveCount(0);

    // 灰色清空后再新建：无需确认（用画布左上空白，避免命中节点弹出节点菜单）
    await pane.click({ position: { x: 260, y: 120 }, button: 'right' });
    await page.getByText('＋ 新建分镜节点').click();
    await expect(page.locator('.dialog-mask')).toHaveCount(0);
    await expect(page.getByText('覆盖未来快照')).toHaveCount(0);
    g = await (await page.request.get('/api/graph')).json();
    expect((g.graph.nodes as DirectorNode[])).toHaveLength(4);
  } finally {
    // 防御清理（尽力而为，全部带超时）：仅在确有灰色分支时批准（防标志泄漏），
    // 然后删除节点；测试主体完成后 request 可能异常卡住
    const snap = await page.request.get('/api/snapshots', { timeout: 3000 })
      .then((r) => r.json()).catch(() => null);
    const maxSeq = ((snap?.snapshots as Array<{ seq: number }> | undefined)?.at(-1)?.seq) ?? 0;
    if (snap && (snap.headSeq as number) < maxSeq) {
      await page.request.post('/api/snapshots/approve-overwrite', { timeout: 3000 }).catch(() => {});
    }
    const g = await page.request.get('/api/graph', { timeout: 3000 }).then((r) => r.json()).catch(() => null);
    for (const n of ((g?.graph as { nodes?: DirectorNode[] } | undefined)?.nodes ?? [])) {
      await page.request.delete(`/api/nodes/${n.id}?confirm=true`, { timeout: 3000 }).catch(() => {});
    }
  }
});

test('撤销在输入框内不触发（编辑文本不受影响）', async ({ page }) => {
  await page.goto('/');
  const textarea = page.locator('.agent-input textarea');
  await textarea.click();
  await textarea.pressSequentially('hello');
  await page.keyboard.press('Control+z');
  // 输入框内撤销的是文本（hello → hell），不是快照
  await expect(textarea).toHaveValue('hell');
});
