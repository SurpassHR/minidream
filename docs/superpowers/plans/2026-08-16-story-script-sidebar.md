# 故事向导右侧剧本栏实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 故事向导页改为两栏，完成后（总结成稿 / 完成故事）右侧常驻剧本栏以代码视图（行号 + object/`<>`/`[]` 高亮）展示 `story_<项目名>.md` 内容。

**Architecture:** 后端 `GET /api/story`（已完成时）与 `POST /api/story/complete` 响应携带 `md`（复用 `buildStoryMarkdown`，单一来源）；前端 `StoryTellerView` 两栏布局 + 新组件 `ScriptViewer`（零依赖 tokenizer → React span 渲染）；`client.ts` 两个方法返回类型同步扩展。

**Tech Stack:** Fastify（后端）、React 18 + TypeScript + vitest + @testing-library/react（前端）、纯 CSS（主题变量 `--amber/--blue/--ok/--mono`）。

## Global Constraints

- 零新依赖：不引入 Monaco/CodeMirror 等编辑器库。
- 文档模板单一来源：`md` 一律由后端 `buildStoryMarkdown`（`src/story/store.ts`）构建，前端不重建模板。
- 高亮规则固定：`object`（词边界、大小写不敏感）→ `--amber` 加粗；`<...>`（非贪婪、含括号、不跨行）→ `--blue`；`[...]`（同上）→ `--ok`。
- 布局固定：右侧栏宽 380px，常驻（未完成显示占位），不做拖拽分割条。
- 中文 UI 文案；沿用片场风格 CSS（`--panel`/`--border`/`--mono`）。
- 所有改动 TDD：先写失败测试，再实现，再提交。

---
## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/api/routes.ts` | GET /api/story 与 complete 响应加 `md` | 修改 |
| `src/api/story-api.test.ts` | 后端 md 返回测试 | 修改 |
| `web/src/views/ScriptViewer.tsx` | 代码视图组件 + `tokenizeScriptLine` 纯函数 | 新建 |
| `web/src/views/ScriptViewer.test.tsx` | tokenize 规则 + 渲染测试 | 新建 |
| `web/src/api/client.ts` | `getStory` / `completeStory` 返回类型加 `md` | 修改 |
| `web/src/views/StoryTellerView.tsx` | 两栏布局 + `md` state | 修改 |
| `web/src/views/StoryTeller.test.tsx` | 右侧栏展示/占位/恢复/reset 测试 | 修改 |
| `web/src/App.css` | 两栏布局与代码视图样式 | 修改 |

---

### Task 1: 后端响应携带 md

**Files:**
- Modify: `src/api/routes.ts:478`（GET /api/story）、`src/api/routes.ts:498`（complete 返回）
- Test: `src/api/story-api.test.ts`

**Interfaces:**
- Produces: `GET /api/story` → `{ story: StoryProgress, md: string | null }`（`completedAt` 非空时 `md` 为 `buildStoryMarkdown` 产物，否则 `null`）；`POST /api/story/complete` → `{ asset, story, md: string }`。前端 Task 3 依赖这两个形状。

- [ ] **Step 1: 写失败测试**

在 `src/api/story-api.test.ts` 的 `describe('API 故事向导')` 内追加三个用例（放在 `POST /api/story/complete 组装文档入库并标记完成` 用例之后）：

```ts
  it('GET /api/story 未完成时 md 为 null', async () => {
    const res = await a.inject({ method: 'GET', url: '/api/story' });
    expect(res.statusCode).toBe(200);
    expect(res.json().md).toBeNull();
  });

  it('POST /api/story/complete 响应含 md（buildStoryMarkdown 产物）', async () => {
    await a.inject({
      method: 'PUT', url: '/api/story',
      payload: { answers: { theme: '精灵与哥布林' } },
    });
    const res = await a.inject({ method: 'POST', url: '/api/story/complete', payload: {} });
    expect(res.statusCode).toBe(201);
    const { md } = res.json();
    expect(md).toContain('# ');
    expect(md).toContain('## 主题');
    expect(md).toContain('精灵与哥布林');
    expect(md).toContain('（未填写）'); // 未填步骤占位
  });

  it('GET /api/story 完成后返回 md', async () => {
    await a.inject({
      method: 'PUT', url: '/api/story',
      payload: { answers: { theme: '精灵与哥布林' } },
    });
    await a.inject({ method: 'POST', url: '/api/story/complete', payload: {} });
    const res = await a.inject({ method: 'GET', url: '/api/story' });
    expect(res.statusCode).toBe(200);
    expect(res.json().md).toContain('## 主题');
    expect(res.json().md).toContain('精灵与哥布林');
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/api/story-api.test.ts`
Expected: 新用例 FAIL（`md` 为 `undefined`），其余用例 PASS。

- [ ] **Step 3: 实现**

修改 `src/api/routes.ts` 的 GET 处理器（约 478 行）：

```ts
app.get('/api/story', async () => {
  const story = readStory(ctx.projectDir);
  // 已完成时附带剧本 md（buildStoryMarkdown 单一来源；未完成返回 null，前端显示占位）
  const md = story.completedAt
    ? buildStoryMarkdown(loadGraph(ctx.projectDir).projectName || '未命名项目', story.answers)
    : null;
  return { story, md };
});
```

修改 complete 处理器返回（约 498 行，`md` 复用已构建变量，零额外计算）：

```ts
  reply.code(201);
  return { asset, story: readStory(ctx.projectDir), md };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/api/story-api.test.ts`
Expected: 全部 PASS（新 3 个 + 原有全部）。

- [ ] **Step 5: 提交**

```bash
git add src/api/routes.ts src/api/story-api.test.ts
git commit -m "feat(story): GET/complete 响应携带剧本 md（buildStoryMarkdown 单一来源）"
```

---

### Task 2: ScriptViewer 组件（tokenizer + 渲染）

**Files:**
- Create: `web/src/views/ScriptViewer.tsx`
- Create: `web/src/views/ScriptViewer.test.tsx`

**Interfaces:**
- Produces: `tokenizeScriptLine(line: string): ScriptToken[]`（`ScriptToken = { text: string; kind: 'plain' | 'object' | 'angle' | 'square' }`）；组件 `ScriptViewer(props: { text: string }): JSX.Element`，根节点 `data-testid="script-viewer"`，每行 `data-testid="script-line-N"`（N 从 1 起）。Task 3 依赖这两个导出。

- [ ] **Step 1: 写失败测试**

创建 `web/src/views/ScriptViewer.test.tsx`：

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScriptViewer, tokenizeScriptLine } from './ScriptViewer';

describe('tokenizeScriptLine', () => {
  it('object 关键字：词边界 + 大小写不敏感', () => {
    expect(tokenizeScriptLine('object: 精灵骑士')).toEqual([
      { text: 'object', kind: 'object' },
      { text: ': 精灵骑士', kind: 'plain' },
    ]);
    expect(tokenizeScriptLine('Object 和 OBJECT 和 myobjects')).toEqual([
      { text: 'Object', kind: 'object' },
      { text: ' 和 ', kind: 'plain' },
      { text: 'OBJECT', kind: 'object' },
      { text: ' 和 ', kind: 'plain' },
      { text: 'myobjects', kind: 'plain' }, // 词边界：myobjects 不是 object
    ]);
  });

  it('<> 与 [] 字段：含括号、多组、不跨行', () => {
    expect(tokenizeScriptLine('<相机> 拉近 [特写] 结束')).toEqual([
      { text: '<相机>', kind: 'angle' },
      { text: ' 拉近 ', kind: 'plain' },
      { text: '[特写]', kind: 'square' },
      { text: ' 结束', kind: 'plain' },
    ]);
    expect(tokenizeScriptLine('<Picture 2> 保持场景一致')).toEqual([
      { text: '<Picture 2>', kind: 'angle' },
      { text: ' 保持场景一致', kind: 'plain' },
    ]);
    expect(tokenizeScriptLine('无括号字段')).toEqual([{ text: '无括号字段', kind: 'plain' }]);
  });

  it('优先级：<> 优先于 [] 优先于 object', () => {
    expect(tokenizeScriptLine('<object>')).toEqual([{ text: '<object>', kind: 'angle' }]);
    expect(tokenizeScriptLine('[object]')).toEqual([{ text: '[object]', kind: 'square' }]);
    expect(tokenizeScriptLine('object [x] <y>')).toEqual([
      { text: 'object', kind: 'object' },
      { text: ' ', kind: 'plain' },
      { text: '[x]', kind: 'square' },
      { text: ' ', kind: 'plain' },
      { text: '<y>', kind: 'angle' },
    ]);
  });

  it('空行与空字符串', () => {
    expect(tokenizeScriptLine('')).toEqual([]);
    expect(tokenizeScriptLine('   ')).toEqual([{ text: '   ', kind: 'plain' }]);
  });
});

describe('ScriptViewer', () => {
  it('渲染行号与三类高亮 token', () => {
    render(<ScriptViewer text={'object: 精灵\n<相机> [特写]'} />);
    expect(screen.getByTestId('script-line-1')).toHaveTextContent('object: 精灵');
    expect(screen.getByTestId('script-line-2')).toHaveTextContent('<相机> [特写]');
    expect(screen.getByText('object').className).toContain('tok-object');
    expect(screen.getByText('<相机>').className).toContain('tok-angle');
    expect(screen.getByText('[特写]').className).toContain('tok-square');
  });

  it('特殊字符原样展示（无注入）', () => {
    render(<ScriptViewer text={'<img onerror="x"> [<script>]'} />);
    // 文本节点渲染：<img ...> 作为文本出现，不产生 img 元素
    expect(screen.getByTestId('script-line-1')).toHaveTextContent('<img onerror="x"> [<script>]');
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/views/ScriptViewer.test.tsx`（工作目录 `web/`）
Expected: FAIL（模块不存在：`Cannot find module './ScriptViewer'`）。

- [ ] **Step 3: 实现**

创建 `web/src/views/ScriptViewer.tsx`：

```tsx
// 只读代码视图：行号 + 自定义高亮（object / <...> / [...]）。
// 零依赖：单行 tokenizer → React span 渲染（文本节点天然转义，无注入风险）。
export type ScriptToken = { text: string; kind: 'plain' | 'object' | 'angle' | 'square' };

// 单行扫描：优先级 <> > [] > object 关键字（词边界、大小写不敏感）。
// 正则需要捕获组内部分：外层捕获组 (…) 命中后 m[0] 即完整 token。
export function tokenizeScriptLine(line: string): ScriptToken[] {
  const tokens: ScriptToken[] = [];
  const re = /(<[^<>]*>|\[[^\[\]]*\]|\bobject\b)/i;
  let rest = line;
  for (;;) {
    const m = re.exec(rest);
    if (!m) {
      if (rest) tokens.push({ text: rest, kind: 'plain' });
      return tokens;
    }
    const hit = m[0]!;
    if (m.index > 0) tokens.push({ text: rest.slice(0, m.index), kind: 'plain' });
    const kind: ScriptToken['kind'] = hit.startsWith('<')
      ? 'angle'
      : hit.startsWith('[')
        ? 'square'
        : 'object';
    tokens.push({ text: hit, kind });
    rest = rest.slice(m.index + hit.length);
  }
}

export function ScriptViewer(props: { text: string }) {
  const lines = props.text.replace(/\r\n/g, '\n').split('\n');
  return (
    <div className="script-viewer" data-testid="script-viewer">
      {lines.map((ln, i) => (
        <div key={i} className="script-line" data-testid={`script-line-${i + 1}`}>
          <span className="script-no">{i + 1}</span>
          <span className="script-code">
            {tokenizeScriptLine(ln).map((t, j) =>
              t.kind === 'plain' ? t.text : (
                <span key={j} className={`tok-${t.kind}`}>{t.text}</span>
              ),
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/views/ScriptViewer.test.tsx`（工作目录 `web/`）
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add web/src/views/ScriptViewer.tsx web/src/views/ScriptViewer.test.tsx
git commit -m "feat(web): ScriptViewer 代码视图组件（行号 + object/<>/[] 高亮 tokenizer）"
```

---

### Task 3: StoryTellerView 两栏布局 + md 接线

**Files:**
- Modify: `web/src/api/client.ts:269-285`（`getStory` / `completeStory`）
- Modify: `web/src/views/StoryTellerView.tsx`（md state、两栏布局）
- Modify: `web/src/views/StoryTeller.test.tsx`（mock 加 md + 新用例）
- Modify: `web/src/App.css`（布局与代码视图样式）

**Interfaces:**
- Consumes: Task 1 的响应形状 `{ story, md }`；Task 2 的 `ScriptViewer` 组件。
- Produces: `StoryTellerView` 渲染右侧栏（`data-testid="script-sidebar"`），未完成显示占位文案，完成后渲染 `ScriptViewer`。

- [ ] **Step 1: 写失败测试**

先改 `web/src/views/StoryTeller.test.tsx` 的共享 mock（约 16-20 行的 complete 分支与约 33-44 行的 GET/PUT 分支），让 mock 携带 md：

```tsx
    if (u.includes('/api/story/complete')) {
      return new Response(JSON.stringify({
        asset: { id: 'a1', kind: 'txt', name: 'story_demo.md', ext: '.md', size: 1, importedAt: 1 },
        story: { ...STORY_API.story, completedAt: '2026-08-15T00:00:00.000Z' },
        md: '# demo · 故事设定\n\n## 主题\n战争与和解',
      }), { status: 201 });
    }
```

```tsx
    if (u.includes('/api/story')) {
      // PUT 合并更新共享 mock 数据（step / answers），返回更新后进度——模拟真实后端合并写
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as { step?: number; answers?: Record<string, string> };
        STORY_API.story = {
          ...STORY_API.story,
          ...(body.step !== undefined ? { step: body.step } : {}),
          answers: { ...STORY_API.story.answers, ...(body.answers ?? {}) },
        };
      }
      // GET：已完成时携带 md（模拟后端行为）
      return new Response(JSON.stringify({
        ...STORY_API,
        md: STORY_API.story.completedAt ? '# demo · 故事设定\n\n## 主题\n战争与和解' : null,
      }), { status: 200 });
    }
```

在 `describe('StoryTellerView 模式切换')` 末尾追加三个用例：

```tsx
  it('对话式总结成稿完成后：右侧栏展示剧本 md', async () => {
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText(/故事主题是什么/)).toBeInTheDocument());
    // 未完成：右侧栏占位
    expect(screen.getByTestId('script-sidebar')).toHaveTextContent('剧本将在这里展示');
    fireEvent.click(screen.getByTestId('mode-chat'));
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeInTheDocument());
    fireEvent.click(screen.getByText('✨ 总结成稿'));
    // 总结完成 → 右侧栏代码视图出现剧本
    await waitFor(() => expect(screen.getByTestId('script-viewer')).toBeInTheDocument());
    expect(screen.getByTestId('script-viewer')).toHaveTextContent('# demo · 故事设定');
    expect(screen.getByTestId('script-viewer')).toHaveTextContent('## 主题');
  });

  it('已完成项目挂载：右侧栏从 GET 恢复剧本', async () => {
    STORY_API.story = { step: 5, answers: { theme: 't', protagonist: 'p', antagonist: 'a', scenes: 's', ending: 'e' }, completedAt: '2026-08-15T00:00:00.000Z' };
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByTestId('script-viewer')).toBeInTheDocument());
    expect(screen.getByTestId('script-viewer')).toHaveTextContent('# demo · 故事设定');
  });

  it('向导式完成故事后右侧栏展示剧本，重新生成后回占位', async () => {
    STORY_API.story = { step: 5, answers: { theme: 't', protagonist: 'p', antagonist: 'a', scenes: 's', ending: 'e' }, completedAt: null };
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText(/结局如何/)).toBeInTheDocument());
    const textarea = screen.getByTestId('story-answer');
    fireEvent.change(textarea, { target: { value: '圆满结局' } });
    fireEvent.click(screen.getByText('完成故事'));
    await waitFor(() => expect(screen.getByTestId('script-viewer')).toBeInTheDocument());
    expect(screen.getByTestId('script-viewer')).toHaveTextContent('# demo · 故事设定');
    // 重新生成 → 占位
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByText('重新生成'));
    await waitFor(() => expect(screen.queryByTestId('script-viewer')).not.toBeInTheDocument());
    expect(screen.getByTestId('script-sidebar')).toHaveTextContent('剧本将在这里展示');
    vi.restoreAllMocks();
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/views/StoryTeller.test.tsx`（工作目录 `web/`）
Expected: 新 3 个用例 FAIL（无 `script-sidebar` / `script-viewer` 节点），原有用例 PASS（mock 改动不影响）。

- [ ] **Step 3: 实现 client.ts**

修改 `web/src/api/client.ts`（约 268-285 行）：

```ts
  // —— story-teller 向导 ——
  // 响应携带 md（剧本全文）：GET 仅已完成时非 null；complete 恒为字符串（后端单一来源）
  async getStory(): Promise<{ story: StoryProgress; md: string | null }> {
    const r = await req<{ story: StoryProgress; md: string | null }>('/api/story');
    return r;
  },

  async saveStory(patch: { step?: number; answers?: Record<string, string> }): Promise<StoryProgress> {
    const r = await req<{ story: StoryProgress }>('/api/story', {
      method: 'PUT', body: JSON.stringify(patch),
    });
    return r.story;
  },

  async completeStory(): Promise<{ asset: AssetRecord; story: StoryProgress; md: string }> {
    return await req<{ asset: AssetRecord; story: StoryProgress; md: string }>('/api/story/complete', {
      method: 'POST', body: JSON.stringify({}),
    });
  },
```

- [ ] **Step 4: 实现 StoryTellerView.tsx**

修改 `web/src/views/StoryTellerView.tsx`：

(a) 新增 state（约 26 行 `const [saved, setSaved] = useState(false);` 之后）：

```tsx
  // 剧本 md（buildStoryMarkdown 产物）：完成时由 GET/complete 响应写入，reset 清空
  const [md, setMd] = useState<string | null>(null);
```

(b) 挂载加载（约 50-53 行）：

```tsx
    void client.getStory().then(({ story: s, md: m }) => {
      if (disposed) return;
      setStory(s);
      setMd(m ?? null);
      setDraft(s.answers[STORY_STEPS[Math.min(s.step, STORY_STEPS.length - 1)]!.id] ?? '');
      setLoaded(true);
    }).catch(() => {
```

(c) 向导式 complete（约 142-144 行）：

```tsx
      const r = await client.completeStory();
      setStory(r.story);
      setMd(r.md);
      setSaved(true);
      setError('');
```

(d) reset（约 154-158 行）：

```tsx
    void client.resetStory().then((s) => {
      setStory(s);
      setMd(null);
      setDraft('');
      setError('');
    }).catch((err) => setError(err instanceof Error ? err.message : '重置失败'));
```

(e) handleSummarized（约 172-181 行）：

```tsx
  const handleSummarized = (answers: Record<string, string>) => {
    void client.saveStory({ answers })
      .then(() => client.completeStory())
      .then((r) => {
        setStory(r.story);
        setMd(r.md);
        setSaved(true);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : '总结入库失败'));
  };
```

(f) 布局（约 187 行起 return 结构）：外层保持 `role-view story-view`；模式 tab、模式内容、错误横幅包进左侧 `story-main`；新增右侧 `script-sidebar`。完整替换 return 内容：

```tsx
  return (
    <div className="role-view story-view" data-testid="story-teller-view">
      <RoleHeader
        eyebrow="STORY TELLER"
        title="故事向导"
        meta={
          // 第几步是向导式（问卷）的概念：对话式无步骤，meta 显示模式提示
          mode === 'wizard'
            ? <span className="story-step-meta">第 {story.step + 1}/{STORY_STEPS.length} 步</span>
            : <span className="story-step-meta">自由对话 · 探索故事方向</span>
        }
      />
      <div className="story-layout">
        <div className="story-main">
          {/* 模式切换：向导式 / 对话式 */}
          <div className="role-mode-tabs" role="tablist" aria-label="向导模式">
            <button
              type="button"
              className={`role-mode-tab${mode === 'wizard' ? ' active' : ''}`}
              data-testid="mode-wizard"
              onClick={() => switchMode('wizard')}
            >⬡ 向导式</button>
            <button
              type="button"
              className={`role-mode-tab${mode === 'chat' ? ' active' : ''}`}
              data-testid="mode-chat"
              onClick={() => switchMode('chat')}
            >✦ 对话式</button>
          </div>
          {mode === 'chat' ? (
            <StoryChat
              projectName={props.projectName}
              completedAt={story.completedAt}
              onBackfill={handleBackfill}
              onSummarized={handleSummarized}
            />
          ) : (
            <>
              {/* 场记板步骤轨道：编号可点击跳转；完成=ok 绿+✓；当前=amber 发光 */}
              <div className="story-track" role="tablist" aria-label="向导步骤">
                {STORY_STEPS.map((s, i) => {
                  const done = i < story.step;
                  const cur = i === story.step;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      className={`track-seg${done ? ' done' : ''}${cur ? ' cur' : ''}`}
                      title={`${s.question}${s.required ? '' : '（可留空）'}`}
                      onClick={() => goto(i)}
                    >
                      <span className="track-no">{String(i + 1).padStart(2, '0')}</span>
                      <span className="track-mark">{done ? '✓' : cur ? '●' : ''}</span>
                    </button>
                  );
                })}
              </div>
              {story.completedAt && (
                <div className="story-banner">
                  ✅ 已完成 · 已生成故事文档进素材库（{new Date(story.completedAt).toLocaleString()}）
                  <button className="btn-ghost story-reset" onClick={reset}>重新生成</button>
                </div>
              )}
              <RoleCard className="story-card">
                <div className="story-q">❓ {step.question}</div>
                <div className="story-hint">{step.hint}</div>
                <textarea
                  className="ne-input story-answer" data-testid="story-answer"
                  value={draft}
                  placeholder="在这里填写…"
                  onChange={(e) => { setDraft(e.target.value); persist(story, e.target.value); }}
                  rows={6}
                />
                <div className="story-actions">
                  <AiButton busy={aiBusy} onClick={aiSuggest}>✨ AI 建议</AiButton>
                  <span className="story-save-hint">{saved ? '已保存 ✓' : ''}</span>
                </div>
                <div className="story-nav">
                  <button className="btn-ghost" disabled={story.step === 0} onClick={() => void prev()}>← 上一步</button>
                  {isLast ? (
                    <button className="btn-primary" onClick={() => void complete()}>完成故事</button>
                  ) : (
                    <button className="btn-primary" onClick={() => void next()}>下一步 →</button>
                  )}
                </div>
              </RoleCard>
            </>
          )}
          {/* 错误横幅：对话式 / 向导式共用（提升到模式条件之外，避免 chat 模式静默失败） */}
          {error && <ErrorBanner text={error} />}
        </div>
        {/* 右侧剧本栏：常驻；完成后以代码视图展示 buildStoryMarkdown 产物 */}
        <aside className="script-sidebar" data-testid="script-sidebar">
          <div className="panel-title">剧本 <span className="mini">story_{props.projectName || '未命名项目'}.md</span></div>
          {md ? (
            <ScriptViewer text={md} />
          ) : (
            <div className="script-empty">
              对话结束点击 ✨ 总结成稿（或向导完成故事）后，
              剧本将在这里展示
            </div>
          )}
        </aside>
      </div>
    </div>
  );
```

同时在文件头部导入 `ScriptViewer`（约 7 行）：

```tsx
import { StoryChat } from './StoryChat';
import { ScriptViewer } from './ScriptViewer';
```

- [ ] **Step 5: 实现 App.css 样式**

修改 `web/src/App.css`：`.story-view` 行（572 行）`max-width: 760px` 改为 `max-width: 1180px`，并在文件末尾（661 行后）追加：

```css
/* ===== story 右侧剧本栏（两栏布局 + 代码视图高亮） ===== */
.story-layout { display: flex; gap: 22px; align-items: flex-start; }
.story-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 18px; }
.script-sidebar {
  flex: 0 0 380px; display: flex; flex-direction: column; gap: 10px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 14px;
}
.script-empty {
  border: 1px dashed var(--border-2); border-radius: 10px; padding: 20px 14px;
  font-size: 12px; color: var(--text-faint); text-align: center; line-height: 1.8;
}
.script-viewer {
  overflow: auto; max-height: 62vh; background: var(--bg);
  border: 1px solid var(--border-2); border-radius: 8px; padding: 8px 0;
}
.script-line { display: flex; font-family: var(--mono); font-size: 12px; line-height: 1.7; min-width: max-content; }
.script-no {
  flex: none; width: 46px; padding: 0 10px; text-align: right; color: var(--text-faint);
  user-select: none; background: var(--panel-2); border-right: 1px solid var(--border);
}
.script-code { flex: none; padding: 0 12px; color: var(--text); white-space: pre; }
.tok-object { color: var(--amber); font-weight: 700; }
.tok-angle { color: var(--blue); }
.tok-square { color: var(--ok); }
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm exec vitest run src/views/StoryTeller.test.tsx src/views/ScriptViewer.test.tsx`（工作目录 `web/`）
Expected: 全部 PASS（含新 3 个用例与原有全部）。

再跑后端与全量回归：

Run: `pnpm exec vitest run src/api/story-api.test.ts`（工作目录仓库根）
Run: `pnpm test`
Expected: 全部 PASS。

- [ ] **Step 7: 提交**

```bash
git add web/src/api/client.ts web/src/views/StoryTellerView.tsx web/src/views/StoryTeller.test.tsx web/src/App.css
git commit -m "feat(web): 故事向导右侧剧本栏（总结成稿后代码视图展示，高亮 object/<>/[]）"
```

---

## 验收（对照 spec）

1. 对话式点「✨ 总结成稿」→ 流结束 → 右侧栏出现剧本全文 —— Task 3 用例 1。
2. `object`（任意大小写、词边界）琥珀加粗、`<...>` 蓝、`[...]` 绿 —— Task 2。
3. 刷新 / 切项目后已完成项目剧本仍展示 —— Task 3 用例 2（GET 恢复）。
4. 「重新生成」后右侧栏回占位 —— Task 3 用例 3。
5. 向导式「完成故事」同样展示 —— Task 3 用例 3。
6. 全部新增单测通过、现有测试不回归 —— Task 3 Step 6 全量回归。
