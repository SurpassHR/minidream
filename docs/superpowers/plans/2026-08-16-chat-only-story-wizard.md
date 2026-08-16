# 去除向导式仅保留对话式实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 故事向导去掉向导式，只保留对话式；对话式（自由聊天 + 总结成稿）统一使用 storyTeller 系统提示词（默认 MiniMax H3 Prompt Director）；删除回填向导；提示词库收为 3 键。

**Architecture:** 后端 `buildStoryChatPrompt` 增加 `systemPrompt?` 参数（缺省用原写死文本兜底），`POST /api/story/chat` body 透传；前端 `roles.ts` 收键为 storyTeller/objectDesigner/storySummarize 并删两个死常量；`client.storyChat` 加第 7 参；`StoryChat` 删回填、send/runAction 统一 storyTeller；`StoryTellerView` 删全部向导式状态机与 UI，仅渲染对话式布局。

**Tech Stack:** Fastify（后端）、React 18 + vitest + @testing-library/react（前端）。

## Global Constraints

- 零新依赖。
- 对话式基础系统提示词 = `resolvePrompt(prompts, 'storyTeller')`（自由聊天经后端 `systemPrompt` 字段；总结成稿前端组装）；缺省回退内置默认。
- 后端 `/api/story`（step/answers）、complete、reset 端点与 `src/story/steps.ts` **保留不动**（总结成稿入库与重新生成依赖）。
- `roles.ts` 删除 `STORY_CHAT_SYSTEM` / `STORY_BACKFILL_PROMPT` 常量与 `storyChat` / `storyBackfill` 键（无消费点）；保留 `STORY_TELLER_SYSTEM` / `STORY_SUMMARIZE_PROMPT` / `OBJECT_DESIGNER_SYSTEM`。
- 中文 UI/注释/测试命名；TDD 每任务。

---
## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/api/routes.ts` | buildStoryChatPrompt systemPrompt 参数 + POST body 透传 | 修改 |
| `src/api/api.test.ts`（或 story-api.test.ts） | buildStoryChatPrompt 单测 | 修改 |
| `web/src/views/roles.ts` | 收 3 键、删 2 常量 | 修改 |
| `web/src/views/roles.test.ts` | 键集断言更新 | 修改 |
| `web/src/api/client.ts` | storyChat 第 7 参 systemPrompt | 修改 |
| `web/src/panels/SettingsModal.tsx` | 标签更新（storyTeller=故事向导·对话式，删 2 键标签） | 修改 |
| `web/src/panels/SettingsModal.test.tsx` | 3 键断言 | 修改 |
| `web/src/views/StoryChat.tsx` | 删回填、send/runAction 统一 storyTeller | 修改 |
| `web/src/views/StoryChat.test.tsx` | 适配（删回填用例、新增 systemPrompt 断言） | 修改 |
| `web/src/views/StoryTellerView.tsx` | 去向导式重写 | 修改 |
| `web/src/views/StoryTeller.test.tsx` | 对话式用例重写 | 修改 |

---

### Task 1: 后端 systemPrompt 接入

**Files:**
- Modify: `src/api/routes.ts`（buildStoryChatPrompt + POST /api/story/chat body）
- Test: `src/api/api.test.ts` 或 `src/api/story-api.test.ts`（buildStoryChatPrompt 纯函数单测；POST 透传接线由 review 覆盖）

**Interfaces:**
- Produces: `buildStoryChatPrompt(projectName, answers, history, message, systemPrompt?)`——`systemPrompt?.trim()` 非空时替换写死系统文本，否则原文本；`POST /api/story/chat` body 接受 `systemPrompt?: string`。Task 2/3 依赖。

- [ ] **Step 1: 写失败测试**

`src/api/story-api.test.ts` 追加（buildStoryChatPrompt 已是导出函数，直接单测）：

```ts
  it('buildStoryChatPrompt：systemPrompt 替换写死文本；缺省兜底', async () => {
    const { buildStoryChatPrompt } = await import('../routes.js');
    const base = buildStoryChatPrompt('p', {}, [], '你好');
    expect(base).toContain('你是导演工作台的故事编剧');
    const custom = buildStoryChatPrompt('p', {}, [], '你好', '你是定制系统提示词');
    expect(custom).toContain('你是定制系统提示词');
    expect(custom).not.toContain('你是导演工作台的故事编剧');
    // 空白 systemPrompt 视为缺省
    const blank = buildStoryChatPrompt('p', {}, [], '你好', '   ');
    expect(blank).toContain('你是导演工作台的故事编剧');
  });
```

> 若 `buildStoryChatPrompt` 不在该文件测试范围内（import 路径为 `../routes.js` 导出），放 `src/api/api.test.ts` 同构追加亦可；以实际导出位置为准。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/api/story-api.test.ts src/api/api.test.ts`
Expected: 新用例 FAIL（函数无第 5 参行为）。

- [ ] **Step 3: 实现**

`src/api/routes.ts` buildStoryChatPrompt 签名与首行：

```ts
export function buildStoryChatPrompt(
  projectName: string,
  answers: Record<string, string>,
  history: ChatMessage[],
  message: string,
  systemPrompt?: string,
): string {
  const parts: string[] = [];
  parts.push(systemPrompt?.trim() || '你是导演工作台的故事编剧（story-teller 对话模式）。你正在帮用户自由构思一个视频故事的创意。');
```

POST /api/story/chat body 类型加字段并传入：

```ts
    const body = req.body as { message?: string; model?: string; thinking?: string; persistAs?: string; sessionId?: string; systemPrompt?: string };
```

```ts
  const prompt = buildStoryChatPrompt(graph.projectName, story.answers, history, message, body.systemPrompt);
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/api/story-api.test.ts src/api/api.test.ts`，再 `pnpm test`。
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/api/routes.ts src/api/story-api.test.ts src/api/api.test.ts
git commit -m "feat(api): 故事对话式自由聊天支持 systemPrompt（替换写死系统文本，缺省兜底）"
```

---

### Task 2: roles 收键 + client.systemPrompt + 设置标签

**Files:**
- Modify: `web/src/views/roles.ts`、`web/src/views/roles.test.ts`、`web/src/api/client.ts`、`web/src/panels/SettingsModal.tsx`、`web/src/panels/SettingsModal.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `systemPrompt` 字段。
- Produces: `ROLE_PROMPT_KEYS` = `{ storyTeller, objectDesigner, storySummarize }`；删除 `STORY_CHAT_SYSTEM` / `STORY_BACKFILL_PROMPT`；`client.storyChat(message, onChunk, model?, thinking?, persistAs?, sessionId?, systemPrompt?)`；`ROLE_PROMPT_LABELS.storyTeller` = 「故事向导 · 对话式」。Task 3/4 依赖。

- [ ] **Step 1: 写失败测试**

`web/src/views/roles.test.ts` 键集用例改为：

```tsx
  it('3 个角色键均有非空内置默认', () => {
    expect(Object.keys(ROLE_PROMPT_KEYS).sort()).toEqual(
      ['objectDesigner', 'storySummarize', 'storyTeller'],
    );
    for (const v of Object.values(ROLE_PROMPT_KEYS)) {
      expect(v.trim().length).toBeGreaterThan(0);
    }
  });
```

其余用例中引用 `'storyChat'` 的（空串回退用例）改为 `'storySummarize'`。

`web/src/panels/SettingsModal.test.tsx` 中两处角色键列表改为 3 键：

```tsx
    for (const n of ['storyTeller', 'objectDesigner', 'storySummarize']) {
      expect(screen.getByText(n)).toBeInTheDocument();
    }
    expect(screen.getByText('故事向导 · 对话式')).toBeInTheDocument();
    expect(screen.queryByText('storyChat')).not.toBeInTheDocument();
```

保存 payload 用例的键集断言改为：

```tsx
    expect(Object.keys(body.prompts).sort()).toEqual(
      ['objectDesigner', 'storySummarize', 'storyTeller'],
    );
    expect(body.prompts.storySummarize).toBe(''); // 空内容保留（消费点回退默认）
```

（原 storyBackfill 相关断言删除/替换为 storySummarize。）

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/views/roles.test.ts src/panels/SettingsModal.test.tsx`（工作目录 `web/`）
Expected: 新断言 FAIL（仍 5 键）。

- [ ] **Step 3: 实现**

`web/src/views/roles.ts`：
- 删除 `STORY_CHAT_SYSTEM` 与 `STORY_BACKFILL_PROMPT` 两个常量定义。
- `ROLE_PROMPT_KEYS` 改为：

```ts
// 角色提示词库键表：键=消费键（设置里提示词库的条目名），值=内置默认（回退来源）
export const ROLE_PROMPT_KEYS = {
  storyTeller: STORY_TELLER_SYSTEM,
  objectDesigner: OBJECT_DESIGNER_SYSTEM,
  storySummarize: STORY_SUMMARIZE_PROMPT,
} as const;
```

`web/src/api/client.ts` `storyChat` 签名与 body：

```ts
  async storyChat(
    message: string,
    onChunk: (chunk: string) => void,
    model?: string,
    thinking?: string,
    persistAs?: string,
    sessionId?: string | null,
    systemPrompt?: string,
  ): Promise<void> {
    const res = await fetch('/api/story/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, model, thinking, persistAs, sessionId: sessionId ?? undefined, systemPrompt: systemPrompt ?? undefined }),
    });
    ...（其余不变）
```

`web/src/panels/SettingsModal.tsx` `ROLE_PROMPT_LABELS` 改为：

```ts
const ROLE_PROMPT_LABELS: Record<RolePromptKey, string> = {
  storyTeller: '故事向导 · 对话式',
  objectDesigner: '物体设计 · AI 优化',
  storySummarize: '总结成稿指令',
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/views/roles.test.ts src/panels/SettingsModal.test.tsx`（工作目录 `web/`），再全量 `pnpm exec vitest run` + `pnpm exec tsc -b`。
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add web/src/views/roles.ts web/src/views/roles.test.ts web/src/api/client.ts web/src/panels/SettingsModal.tsx web/src/panels/SettingsModal.test.tsx
git commit -m "feat(web): 提示词库收为 3 键 + storyChat 支持 systemPrompt 透传"
```

---

### Task 3: StoryChat 删回填、统一 storyTeller

**Files:**
- Modify: `web/src/views/StoryChat.tsx`、`web/src/views/StoryChat.test.tsx`

**Interfaces:**
- Consumes: Task 1/2 的 `systemPrompt` 与 3 键。
- Produces: `StoryChat` props 移除 `onBackfill`；action 仅 `'summarize'`；`send` 传 `systemPrompt=resolvePrompt(prompts,'storyTeller')`；`runAction` prompt = `withArmorBreak(storyTeller + '\n\n' + storySummarize)`。Task 4 依赖（无 onBackfill 的 StoryChat）。

- [ ] **Step 1: 写失败测试**

`web/src/views/StoryChat.test.tsx`：
- 删除「回填」相关用例（如「对话式回填向导」「总结成稿使用配置的 storyChat + storySummarize」改为 storyTeller 断言）。
- 「发送携带当前 sessionId」用例追加断言：

```tsx
    expect(CHAT_BODIES.at(-1)!.systemPrompt).toContain('你是导演工作台的故事编剧');
```

> 若 CHAT_BODIES 类型未含 systemPrompt，改为 `(CHAT_BODIES.at(-1) as { message: string; sessionId?: string; systemPrompt?: string }).systemPrompt`。

- 「总结成稿」配置断言用例改为：

```tsx
  it('总结成稿使用配置的 storyTeller + storySummarize 提示词', async () => {
    const onSummarized = vi.fn();
    render(
      <StoryChat
        projectName="demo"
        onSummarized={onSummarized}
        prompts={{ storyTeller: '定制编剧', storySummarize: '定制总结' }}
      />,
    );
    await waitFor(() => expect(screen.getByText('我想做精灵与哥布林的故事')).toBeInTheDocument());
    fireEvent.click(screen.getByText('✨ 总结成稿'));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/story/chat'),
      expect.objectContaining({ method: 'POST' }),
    ));
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => String(c[0]).includes('/api/story/chat') && (c[1] as RequestInit)?.method === 'POST',
    );
    const body = JSON.parse(String(calls.at(-1)![1]?.body)) as { message: string };
    expect(body.message).toContain('定制编剧');
    expect(body.message).toContain('定制总结');
    expect(body.message).not.toContain('你是导演工作台的故事编剧');
  });
```

- 所有 render 调用移除 `onBackfill={() => {}}`。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/views/StoryChat.test.tsx`（工作目录 `web/`）
Expected: 编译/断言失败（onBackfill prop 不存在、断言不匹配）。

- [ ] **Step 3: 实现**

`web/src/views/StoryChat.tsx`：
- props 删除 `onBackfill`；`action` state 类型改 `'summarize' | null`。
- `runAction` 简化为仅 summarize：

```tsx
  const summarize = () => runAction();

  const runAction = async () => {
    if (busy) return;
    setBusy(true);
    setAction('summarize');
    setError('');
    const prompt = withArmorBreak(
      `${resolvePrompt(props.prompts, 'storyTeller')}\n\n${resolvePrompt(props.prompts, 'storySummarize')}`,
      props.armorBreak,
      props.armorBreakEnabled,
    );
    let acc = '';
    setMsgs((m) => [...m, { who: 'user', text: '（请总结成稿）' }]);
    try {
      await client.storyChat(prompt, (chunk) => {
        acc += chunk;
        appendStream(chunk);
      }, undefined, undefined, '（请总结成稿）', activeId);
      const answers = parseStoryAnswers(acc);
      if (Object.keys(answers).length === 0) {
        setError('未识别到答案格式，请重试');
      } else {
        props.onSummarized(answers);
      }
    } catch {
      appendStream('\n\n（agent 连接失败）');
    } finally {
      setBusy(false);
      setAction(null);
      refreshSessions();
    }
  };
```

- `send` 传 systemPrompt：

```tsx
    client.storyChat(text, appendStream, undefined, undefined, undefined, activeId, resolvePrompt(props.prompts, 'storyTeller'))
```

- JSX：删除「↩ 回填向导」按钮；hint 文案改「总结成稿：对话 → 完整故事文档入库」；`AiButton busy={busy && action === 'summarize'}` → `busy={busy}`（仅一个动作）。
- 导入：删除 `STORY_CHAT_SYSTEM` 相关（本文件已用 resolvePrompt）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/views/StoryChat.test.tsx`（工作目录 `web/`），再全量 `pnpm exec vitest run` + `pnpm exec tsc -b`。
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add web/src/views/StoryChat.tsx web/src/views/StoryChat.test.tsx
git commit -m "feat(web): 对话式统一 storyTeller 系统提示词，删除回填向导"
```

---

### Task 4: StoryTellerView 去向导式

**Files:**
- Modify: `web/src/views/StoryTellerView.tsx`、`web/src/views/StoryTeller.test.tsx`

**Interfaces:**
- Consumes: Task 3 的 StoryChat（无 onBackfill）。
- Produces: `StoryTellerView` 仅渲染对话式（根类 `role-view story-view chat-mode` 常驻）+ 完成横幅（重新生成）+ 右侧剧本栏；删除 STORY_STEPS 导出与全部向导状态。

- [ ] **Step 1: 写失败测试**

`web/src/views/StoryTeller.test.tsx` **整体重写**为对话式用例（保留既有 mock 结构：fetch stub + STORY_API + GET_STORY_FAIL）：

```tsx
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StoryTellerView } from './StoryTellerView';

const STORY_API: { story: { step: number; answers: Record<string, string>; completedAt: string | null } } = { story: { step: 0, answers: {}, completedAt: null } };

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/story/reset')) {
      STORY_API.story = { step: 0, answers: {}, completedAt: null };
      return new Response(JSON.stringify(STORY_API), { status: 200 });
    }
    if (u.includes('/api/story/complete')) {
      return new Response(JSON.stringify({
        asset: { id: 'a1', kind: 'txt', name: 'story_demo.md', ext: '.md', size: 1, importedAt: 1 },
        story: { ...STORY_API.story, completedAt: '2026-08-15T00:00:00.000Z' },
        md: '# demo · 故事设定\n\n## 主题\n战争与和解',
      }), { status: 201 });
    }
    if (u.includes('/api/story/chat/sessions')) {
      // GET 空库 → StoryChat 自动 POST 新建（返回 s1 并置 active）
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ sessions: [{ id: 's1', title: '新会话', createdAt: 1, updatedAt: 1 }], activeId: 's1' }), { status: 200 });
      }
      return new Response(JSON.stringify({ sessions: [], activeId: null }), { status: 200 });
    }
    if (u.includes('/api/story/chat/history')) {
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    }
    if (u.includes('/api/story/chat')) {
      if (init?.method === 'POST') {
        return new Response(
          'data: {"chunk":"theme: 战争与和解"}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }
    if (u.includes('/api/story')) {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as { answers?: Record<string, string> };
        STORY_API.story = { ...STORY_API.story, answers: { ...STORY_API.story.answers, ...(body.answers ?? {}) } };
      }
      return new Response(JSON.stringify({ ...STORY_API, md: STORY_API.story.completedAt ? '# demo · 故事设定' : null }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('StoryTellerView 对话式', () => {
  beforeEach(() => {
    STORY_API.story = { step: 0, answers: {}, completedAt: null };
  });

  it('仅对话式：无模式 tab 与向导元素，显示聊天区', async () => {
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeInTheDocument());
    expect(screen.queryByText('⬡ 向导式')).not.toBeInTheDocument();
    expect(screen.queryByTestId('story-answer')).not.toBeInTheDocument();
    expect(screen.queryByText(/第 \d+\/6 步/)).not.toBeInTheDocument();
    // chat-mode 布局常驻
    expect(screen.getByTestId('story-teller-view').className).toContain('chat-mode');
  });

  it('未完成时右侧剧本栏占位', async () => {
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeInTheDocument());
    expect(screen.getByTestId('script-sidebar')).toHaveTextContent('剧本将在这里展示');
  });

  it('总结成稿后显示完成横幅 + 右侧剧本 md', async () => {
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeInTheDocument());
    fireEvent.click(screen.getByText('✨ 总结成稿'));
    await waitFor(() => expect(screen.getByText(/已完成 · 已生成故事文档/)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('script-viewer')).toBeInTheDocument());
  });

  it('重新生成：清空完成态与剧本栏', async () => {
    STORY_API.story = { step: 5, answers: { theme: 't' }, completedAt: '2026-08-15T00:00:00.000Z' };
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText(/已完成 · 已生成故事文档/)).toBeInTheDocument());
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByText('重新生成'));
    await waitFor(() => expect(screen.queryByText(/已完成 · 已生成故事文档/)).not.toBeInTheDocument());
    expect(screen.getByTestId('script-sidebar')).toHaveTextContent('剧本将在这里展示');
    vi.restoreAllMocks();
  });

  it('已完成项目挂载：右侧栏从 GET 恢复剧本', async () => {
    STORY_API.story = { step: 5, answers: { theme: 't' }, completedAt: '2026-08-15T00:00:00.000Z' };
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByTestId('script-viewer')).toBeInTheDocument());
  });
});
```

> 注意：sessions 分支必须位于 `/api/story/chat` 之前（URL 包含关系）；reset 分支先于 `/api/story`。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/views/StoryTeller.test.tsx`（工作目录 `web/`）
Expected: 编译失败（组件仍含向导式 prop/元素）或断言失败。

- [ ] **Step 3: 实现 StoryTellerView.tsx 全量重写**

```tsx
import { useEffect, useState } from 'react';
import { client } from '../api/client';
import type { StoryProgress } from '../types';
import { AiButton, ErrorBanner, LoadingState, RoleHeader } from './role-ui';
import { StoryChat } from './StoryChat';
import { ScriptViewer } from './ScriptViewer';

// story-teller 仅对话式：自由聊天 + 总结成稿入库（向导式已移除）。
// story 状态只需 completedAt（完成横幅/剧本栏）；answers 由总结成稿写入后端。
export function StoryTellerView(props: { projectName: string; prompts?: Record<string, string>; armorBreak?: string; armorBreakEnabled?: boolean }) {
  const [story, setStory] = useState<StoryProgress>({ step: 0, answers: {}, completedAt: null });
  const [md, setMd] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  // 项目切换/挂载时加载进度（completedAt + md）
  useEffect(() => {
    let disposed = false;
    setLoaded(false);
    setError('');
    void client.getStory().then(({ story: s, md: m }) => {
      if (disposed) return;
      setStory(s);
      setMd(m ?? null);
      setLoaded(true);
    }).catch(() => {
      if (!disposed) { setError('加载故事进度失败'); setLoaded(true); }
    });
    return () => { disposed = true; };
  }, [props.projectName]);

  // 对话式总结成稿：解析答案 → 写入 story.json → complete 入库 → 刷新完成状态
  const handleSummarized = (answers: Record<string, string>) => {
    void client.saveStory({ answers })
      .then(() => client.completeStory())
      .then((r) => {
        setStory(r.story);
        setMd(r.md);
        setSaved(true);
        setError('');
        setTimeout(() => setSaved(false), 1200);
      })
      .catch((err) => setError(err instanceof Error ? err.message : '总结入库失败'));
  };

  // 重新生成：清空进度与完成标记，回到未完成态（确认门防误触）
  const reset = () => {
    if (!window.confirm('重新生成将清空当前故事进度，确定？')) return;
    void client.resetStory().then((s) => {
      setStory(s);
      setMd(null);
      setError('');
    }).catch((err) => setError(err instanceof Error ? err.message : '重置失败'));
  };

  if (!loaded) {
    return <div className="role-view" data-testid="story-teller-view"><LoadingState /></div>;
  }

  return (
    // 仅对话式：chat-mode 布局常驻（高度受限，仅消息区滚动）
    <div className="role-view story-view chat-mode" data-testid="story-teller-view">
      <RoleHeader
        eyebrow="STORY TELLER"
        title="故事向导"
        meta={<span className="story-step-meta">自由对话 · 探索故事方向</span>}
      />
      <div className="story-layout">
        <div className="story-main">
          {story.completedAt && (
            <div className="story-banner">
              ✅ 已完成 · 已生成故事文档进素材库（{new Date(story.completedAt).toLocaleString()}）
              <button className="btn-ghost story-reset" onClick={reset}>重新生成</button>
            </div>
          )}
          <StoryChat
            projectName={props.projectName}
            completedAt={story.completedAt}
            onSummarized={handleSummarized}
            prompts={props.prompts}
            armorBreak={props.armorBreak}
            armorBreakEnabled={props.armorBreakEnabled}
          />
          {error && <ErrorBanner text={error} />}
        </div>
        {/* 右侧剧本栏：常驻；完成后以代码视图展示 buildStoryMarkdown 产物 */}
        <aside className="script-sidebar" data-testid="script-sidebar">
          <div className="panel-title">剧本 <span className="mini">story_{props.projectName || '未命名项目'}.md</span></div>
          {md ? (
            <ScriptViewer text={md} />
          ) : (
            <div className="script-empty">
              对话结束点击 ✨ 总结成稿后，
              剧本将在这里展示
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
```

> 同时删除文件顶部 `STORY_STEPS` 定义与 `STORY_TELLER_SYSTEM`/`AiButton` 相关导入（重写后不再使用；若 tsc 报未使用导入请清理）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/views/StoryTeller.test.tsx src/views/StoryChat.test.tsx`（工作目录 `web/`），再全量 `pnpm exec vitest run` + `pnpm exec tsc -b` + 仓库根 `pnpm test`。
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add web/src/views/StoryTellerView.tsx web/src/views/StoryTeller.test.tsx
git commit -m "feat(web): 故事向导仅保留对话式（移除向导式模式与状态机）"
```

---

## 验收（对照 spec）

1. 故事向导页仅对话式（无模式 tab/六步问卷）—— Task 4 用例 1。
2. 自由聊天请求携带 storyTeller 系统提示词 —— Task 3 send systemPrompt 断言 + Task 1 后端单测。
3. 回填向导按钮/代码/键移除 —— Task 2/3。
4. 提示词库 3 键 + storyTeller 标签「故事向导 · 对话式」—— Task 2 测试。
5. 总结成稿入库/完成横幅/右侧剧本栏/重新生成保留 —— Task 4 用例；后端 API 不回归（Task 1 Step 4 全量）。
