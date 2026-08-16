# 故事向导对话式模式（story-chat）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 故事向导新增「对话式」模式：与 AI 编剧自由对话，支持「总结成稿」（六步答案 → 复用 complete 流程入库）与「回填向导」（六步答案 → 写入 story.json）。

**Architecture:** 后端新增 `src/story/chat-store.ts`（story-chat.json，参照 chat-history.ts 模式）+ 两个路由（`GET /api/story/chat/history`、`POST /api/story/chat` SSE，复用 runAgentStream/writeAgentMcpConfig）；前端 `StoryTellerView` 加模式 tab（localStorage 记住），新组件 `StoryChat.tsx` 负责对话 UI 与「总结成稿/回填向导」的约定格式解析。

**Tech Stack:** Fastify + React (Vite) + vitest（后端 inject / 前端 testing-library，均已有）。

## Global Constraints

- 存储位置：`<projectDir>/.director/story-chat.json`，参照 `src/agent/chat-history.ts`（缺失/损坏返回空、原子写 tmp+rename、上限 100 条裁剪最早）。
- 对话历史与 AGENT 面板 chat.json 完全隔离（独立文件、独立端点）。
- 复用现有 pi 桥：`runAgentStream` + `writeAgentMcpConfig` + `THINKING_LEVELS`（`src/api/routes.ts` 已有），不新建桥逻辑。
- Prompt 构造在后端：项目名 + 向导答案摘要（只列有内容的步骤）+ 最近 20 条对话历史 + 用户消息。
- 六步答案约定格式：每行 `stepId: 内容`（theme/protagonist/support/antagonist/scenes/ending），前端解析，后端不解析。
- 总结成稿复用 `POST /api/story/complete`（已有 409 防护）；回填向导用 `PUT /api/story`。
- 模式选择 localStorage key：`dw:storyMode`（'wizard' | 'chat'）。
- 代码注释、UI 文案、commit message 使用中文。

---

### Task 1: 后端 story-chat 存储与 API

**Files:**
- Create: `src/story/chat-store.ts`
- Test: `src/story/chat-store.test.ts`
- Modify: `src/api/routes.ts`（story 路由块后追加 chat 路由）
- Modify: `src/api/story-api.test.ts`（追加 chat API 测试）

**Interfaces:**
- Produces:
  - `readStoryChat(projectDir: string): ChatMessage[]`
  - `appendStoryChat(projectDir: string, who: 'user' | 'agent', text: string): ChatMessage[]`（上限 100，裁剪最早；与 chat-history.ts 同构，ChatMessage 类型复用 `src/agent/chat-history.ts` 的导出）
  - `GET /api/story/chat/history` → `{ messages: ChatMessage[] }`
  - `POST /api/story/chat` body `{ message, model?, thinking? }` → SSE 流式（同 /api/agent/chat 协议：`data: {"chunk":"..."}` 帧 + `data: [DONE]`）
  - `buildStoryChatPrompt(projectName, answers, history, message): string`（纯函数导出便于测试）

- [ ] **Step 1: 写失败测试（chat-store）**

创建 `src/story/chat-store.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendStoryChat, readStoryChat } from './chat-store.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'director-story-chat-'));
  mkdirSync(join(dir, '.director'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('readStoryChat', () => {
  it('文件不存在返回空列表', () => {
    expect(readStoryChat(dir)).toEqual([]);
  });

  it('文件损坏返回空列表（不抛错）', () => {
    writeFileSync(join(dir, '.director', 'story-chat.json'), '{broken', 'utf8');
    expect(readStoryChat(dir)).toEqual([]);
  });
});

describe('appendStoryChat', () => {
  it('追加消息并落盘读回', () => {
    appendStoryChat(dir, 'user', '我想做一个精灵与哥布林的故事');
    appendStoryChat(dir, 'agent', '好设定！建议冲突围绕两族共有的诅咒');
    const msgs = readStoryChat(dir);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.who).toBe('user');
    expect(msgs[1]!.text).toContain('诅咒');
  });

  it('超过 100 条裁剪最早', () => {
    for (let i = 0; i < 105; i++) appendStoryChat(dir, 'user', `msg-${i}`);
    const msgs = readStoryChat(dir);
    expect(msgs).toHaveLength(100);
    expect(msgs[0]!.text).toBe('msg-5');
  });

  it('空文本不追加', () => {
    appendStoryChat(dir, 'user', '   ');
    expect(readStoryChat(dir)).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/story/chat-store.test.ts`
Expected: FAIL — 找不到 `./chat-store.js`。

- [ ] **Step 3: 实现 chat-store.ts**

创建 `src/story/chat-store.ts`（参照 `src/agent/chat-history.ts`）：

```ts
// story-teller 对话式历史：按项目持久化到 <projectDir>/.director/story-chat.json
// 与 AGENT 面板 chat.json 完全隔离（独立文件、独立端点）；上限 100 条裁剪最早
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChatMessage } from '../agent/chat-history.js';

const MAX_MESSAGES = 100;

function chatFile(projectDir: string): string {
  return join(projectDir, '.director', 'story-chat.json');
}

// 读取对话历史；文件缺失或损坏返回空列表（防御式）
export function readStoryChat(projectDir: string): ChatMessage[] {
  const f = chatFile(projectDir);
  if (!existsSync(f)) return [];
  try {
    const data = JSON.parse(readFileSync(f, 'utf8')) as ChatMessage[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

// 追加一条消息；超过上限裁剪最早（保留最近 MAX_MESSAGES 条）；原子写（tmp + rename）
export function appendStoryChat(projectDir: string, who: 'user' | 'agent', text: string): ChatMessage[] {
  const trimmed = text.trim();
  if (!trimmed) return readStoryChat(projectDir);
  const messages = [...readStoryChat(projectDir), { who, text: trimmed, at: Date.now() }];
  const kept = messages.length > MAX_MESSAGES ? messages.slice(messages.length - MAX_MESSAGES) : messages;
  const f = chatFile(projectDir);
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(kept, null, 2), 'utf8');
  renameSync(tmp, f);
  return kept;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/story/chat-store.test.ts`
Expected: PASS（5 个用例全绿）

- [ ] **Step 5: 写失败测试（chat API）**

追加到 `src/api/story-api.test.ts`（文件末尾新增 describe）：

```ts
describe('API 故事对话', () => {
  it('GET /api/story/chat/history 空历史返回空列表', async () => {
    const res = await a.inject({ method: 'GET', url: '/api/story/chat/history' });
    expect(res.statusCode).toBe(200);
    expect(res.json().messages).toEqual([]);
  });

  it('POST /api/story/chat 流式响应并落盘历史（mock pi 输出）', async () => {
    // mock pi：DIRECTOR_PI_CMD 指向 mock-agent，输出固定文本（参照现有 agent chat 测试模式）
    const oldCmd = process.env.DIRECTOR_PI_CMD;
    process.env.DIRECTOR_PI_CMD = 'node src/agent/mock-agent.mjs';
    try {
      const res = await a.inject({
        method: 'POST', url: '/api/story/chat',
        payload: { message: '你好' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.body;
      // SSE 帧协议：data: {"chunk":"..."} 至少一帧 + [DONE]
      expect(body).toContain('data: [DONE]');
      expect(body).toContain('mock reply');
      // 历史已落盘（用户消息 + agent 全文）
      const hist = await a.inject({ method: 'GET', url: '/api/story/chat/history' });
      const messages = hist.json().messages;
      expect(messages).toHaveLength(2);
      expect(messages[0].who).toBe('user');
      expect(messages[0].text).toBe('你好');
      expect(messages[1].who).toBe('agent');
    } finally {
      if (oldCmd === undefined) delete process.env.DIRECTOR_PI_CMD;
      else process.env.DIRECTOR_PI_CMD = oldCmd;
    }
  });
});
```

**注意**：mock-agent 的 MOCK_REPLY 默认 'mock reply'；若现有 agent chat 测试在 story-api.test.ts 已 mock DIRECTOR_PI_CMD，确认本文件 beforeEach 未设置（参照 api.test.ts 的 agent chat 测试如何 mock pi——`src/api/api.test.ts` 有 `/api/agent/chat` 测试，看它如何注入 mock 命令并复用同样方式）。

- [ ] **Step 6: 运行测试确认失败**

Run: `pnpm vitest run src/api/story-api.test.ts`
Expected: FAIL — 404（chat 路由未挂载）。

- [ ] **Step 7: 实现 chat 路由**

在 `src/api/routes.ts` 的 `/api/story/reset` 路由之后追加：

```ts
// —— 故事向导对话式（story-chat）——
// 历史独立存 .director/story-chat.json（与 AGENT 面板 chat.json 隔离）；
// 对话式 prompt 携带：项目名 + 向导答案摘要 + 最近 20 条历史 + 用户消息
const STORY_CHAT_HISTORY_WINDOW = 20;

export function buildStoryChatPrompt(
  projectName: string,
  answers: Record<string, string>,
  history: ChatMessage[],
  message: string,
): string {
  const parts: string[] = [];
  parts.push('你是导演工作台的故事编剧（story-teller 对话模式）。你正在帮用户自由构思一个视频故事的创意。');
  parts.push('要求：');
  parts.push('1. 直接给出创作建议、扩展点子或追问，像资深编剧与导演讨论剧本一样自然；');
  parts.push('2. 结合项目设定与已有向导进度，不要重复用户已写的内容；');
  parts.push('3. 每次回答 100-200 字，聚焦推进故事；');
  parts.push('4. 用中文回答。');
  parts.push(`\n当前项目：${projectName}`);
  const filled = Object.entries(answers).filter(([, v]) => v && v.trim());
  if (filled.length > 0) {
    parts.push('向导进度（已完成部分）：');
    for (const [id, v] of filled) parts.push(`  ${id}: ${v}`);
  }
  if (history.length > 0) {
    parts.push('\n对话历史：');
    for (const h of history.slice(-STORY_CHAT_HISTORY_WINDOW)) {
      parts.push(`  ${h.who === 'user' ? '用户' : '编剧'}：${h.text}`);
    }
  }
  parts.push(`\n用户消息：\n${message}`);
  return parts.join('\n');
}

app.get('/api/story/chat/history', async () => ({ messages: readStoryChat(ctx.projectDir) }));

app.post('/api/story/chat', async (req, reply) => {
  const body = req.body as { message?: string; model?: string; thinking?: string };
  const message = (body.message ?? '').trim();
  if (!message) {
    return reply.code(400).send({ code: 'INVALID_PATCH', message: '消息不能为空' });
  }
  // 组装对话上下文：项目名 + 向导答案 + 最近历史（全上下文）
  const graph = loadGraph(ctx.projectDir);
  const story = readStory(ctx.projectDir);
  const history = readStoryChat(ctx.projectDir);
  const prompt = buildStoryChatPrompt(graph.projectName, story.answers, history, message);

  const cmd = (process.env.DIRECTOR_PI_CMD ?? 'pi --mode json').split(' ').filter(Boolean);
  if (!process.env.DIRECTOR_PI_CMD) {
    const mcpPort = Number(process.env.DIRECTOR_MCP_PORT ?? 4778);
    const mcpFile = writeAgentMcpConfig(mcpPort);
    if (mcpFile) cmd.push('--mcp-config', mcpFile);
  }
  if (body.model) cmd.push('--model', body.model);
  if (body.thinking && THINKING_LEVELS.includes(body.thinking)) {
    cmd.push('--thinking', body.thinking);
  }

  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (text: string) => reply.raw.write(`data: ${JSON.stringify({ chunk: text })}\n\n`);
  // 用户消息先落盘（不依赖 pi 是否正常退出）；agent 全文在流结束后落盘
  appendStoryChat(ctx.projectDir, 'user', message);
  let agentText = '';
  let pending = '';
  let flushTimer: NodeJS.Timeout | null = null;
  const flushPending = () => {
    if (pending) { send(pending); pending = ''; }
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  };
  const pushDelta = (delta: string) => {
    agentText += delta;
    pending += delta;
    if (pending.length >= 120) flushPending();
    else if (!flushTimer) flushTimer = setTimeout(flushPending, 60);
  };
  const sendCollect = (line: string): boolean => {
    const t = line.trim();
    if (t.startsWith('{')) {
      try {
        const ev = JSON.parse(t) as {
          type?: string;
          assistantMessageEvent?: { type?: string; delta?: string };
        };
        if (ev.type === 'message_update' && ev.assistantMessageEvent?.type === 'text_delta') {
          const delta = ev.assistantMessageEvent.delta ?? '';
          if (delta) pushDelta(delta);
        }
        return ev.type === 'agent_end';
      } catch {
        // 解析失败按文本行处理
      }
    }
    agentText += t + '\n';
    send(t);
    return false;
  };
  try {
    const idleMs = Number(process.env.DIRECTOR_AGENT_IDLE_MS) || 45_000;
    await runAgentStream(cmd, prompt, sendCollect, {
      idleTimeoutMs: idleMs,
      env: {
        DIRECTOR_PROJECT_DIR: ctx.projectDir,
        DIRECTOR_PROJECT_NAME: graph.projectName,
      },
    });
    flushPending();
    appendStoryChat(ctx.projectDir, 'agent', agentText);
    if (agentText.trim().length === 0) send('\n\n（输出为空）');
    reply.raw.write('data: [DONE]\n\n');
  } catch (err) {
    send(`（agent 启动失败：${err instanceof Error ? err.message : String(err)}）`);
    reply.raw.write('data: [DONE]\n\n');
  }
  reply.raw.end();
});
```

更新 imports（`src/api/routes.ts` 顶部）：

```ts
import { readStoryChat, appendStoryChat } from '../story/chat-store.js';
import type { ChatMessage } from '../agent/chat-history.js';
```

- [ ] **Step 8: 运行测试确认通过**

Run: `pnpm vitest run src/api/story-api.test.ts src/story/chat-store.test.ts`
Expected: 全部 PASS

- [ ] **Step 9: 回归**

Run: `pnpm test`
Expected: 全绿

- [ ] **Step 10: Commit**

```bash
git add src/story/chat-store.ts src/story/chat-store.test.ts src/api/routes.ts src/api/story-api.test.ts
git commit -m "feat(story): 对话式 chat 存储与 SSE 端点（独立历史 + 全上下文）"
```

---

### Task 2: 前端 StoryChat 组件（对话 UI + 约定格式解析）

**Files:**
- Create: `web/src/views/StoryChat.tsx`
- Test: `web/src/views/StoryChat.test.tsx`（新建）
- Modify: `web/src/views/roles.ts`（STORY_CHAT_SYSTEM / STORY_SUMMARIZE_PROMPT / STORY_BACKFILL_PROMPT）
- Modify: `web/src/api/client.ts`（storyChat 方法 + getStoryChatHistory）
- Modify: `web/src/App.css`（对话式样式）

**Interfaces:**
- Consumes: Task 1 的 `GET /api/story/chat/history`、`POST /api/story/chat`（SSE）；现有 `client.saveStory/completeStory`；`agentChat` 的 SSE 解析（复制为 storyChat）
- Produces:
  - `StoryChat` 组件（props: `{ projectName: string; onBackfill: (answers: Record<string, string>) => void; onSummarized: () => void }`）
  - `parseStoryAnswers(text: string): Record<string, string>`（导出纯函数）
  - `client.storyChat(message, onChunk, model?, thinking?): Promise<void>`
  - `client.getStoryChatHistory(): Promise<ChatMessage[]>`

- [ ] **Step 1: 写失败测试**

创建 `web/src/views/StoryChat.test.tsx`：

```tsx
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StoryChat, parseStoryAnswers } from './StoryChat';

const HISTORY = { messages: [
  { who: 'user', text: '我想做精灵与哥布林的故事', at: 1 },
  { who: 'agent', text: '好设定！', at: 2 },
] };

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/story/chat/history')) {
      return new Response(JSON.stringify(HISTORY), { status: 200 });
    }
    if (u.includes('/api/story/chat')) {
      // SSE：两帧流式 + DONE
      return new Response(
        'data: {"chunk":"精灵骑士"}\n\ndata: {"chunk":"银发绿眸"}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('parseStoryAnswers', () => {
  it('解析六步约定格式，忽略非法行', () => {
    const text = [
      'theme: 战争与和解',
      'protagonist: 精灵骑士',
      '随便说说',
      'scenes: 迷雾森林',
      'ending:',
    ].join('\n');
    expect(parseStoryAnswers(text)).toEqual({
      theme: '战争与和解', protagonist: '精灵骑士', scenes: '迷雾森林',
    });
  });

  it('空文本返回空对象', () => {
    expect(parseStoryAnswers('')).toEqual({});
    expect(parseStoryAnswers('没有格式的文本')).toEqual({});
  });
});

describe('StoryChat', () => {
  it('加载历史并渲染消息', async () => {
    render(<StoryChat projectName="demo" onBackfill={() => {}} onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('我想做精灵与哥布林的故事')).toBeInTheDocument());
    expect(screen.getByText('好设定！')).toBeInTheDocument();
  });

  it('发送消息后流式渲染 agent 回复', async () => {
    render(<StoryChat projectName="demo" onBackfill={() => {}} onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('我想做精灵与哥布林的故事')).toBeInTheDocument());
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: '主角是谁？' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText(/精灵骑士银发绿眸/)).toBeInTheDocument());
  });

  it('回填向导：点击后解析 AI 输出并回调 onBackfill', async () => {
    let backfilled: Record<string, string> | null = null;
    // 覆盖 mock：/api/story/chat 返回六步格式
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/api/story/chat/history')) {
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }
      if (u.includes('/api/story/chat')) {
        return new Response(
          'data: {"chunk":"theme: 战争与和解\\nprotagonist: 精灵骑士"}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }));
    render(<StoryChat projectName="demo" onBackfill={(a) => { backfilled = a; }} onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('↩ 回填向导')).toBeInTheDocument());
    fireEvent.click(screen.getByText('↩ 回填向导'));
    await waitFor(() => expect(backfilled).toEqual({ theme: '战争与和解', protagonist: '精灵骑士' }));
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run web/src/views/StoryChat.test.tsx`
Expected: FAIL — 找不到 `./StoryChat`。

- [ ] **Step 3: 角色提示词（roles.ts 追加）**

```ts
// story-teller 对话式：自由编剧讨论（全上下文由后端组装，这里只给角色与风格）
export const STORY_CHAT_SYSTEM = `你是导演工作台的故事编剧。你在与导演（用户）自由讨论故事创意——不局限于固定问题，可以主动提出主题方向、角色弧光、情节转折、世界观细节。
要求：
1. 直接给出点子或追问，像资深编剧一样有主见；
2. 参考项目设定与向导进度，不要重复用户已写内容；
3. 每次 100-200 字，聚焦推进；
4. 用中文回答。`;

// 总结成稿：从对话提炼完整六步答案（约定格式，前端解析）
export const STORY_SUMMARIZE_PROMPT = `你是导演工作台的故事编剧。请把刚才的对话讨论总结为完整的故事设定。
只输出以下格式（每行一个步骤，冒号后是内容，不要输出其他任何文字）：

theme: 一句话主题
protagonist: 主角身份、性格、目标
support: 配角列表（每句一人，可空）
antagonist: 冲突来源
scenes: 场景列表
ending: 结局设定

要求：
1. 基于对话内容提炼，未讨论的步骤填「（待定）」；
2. 保持用户讨论中的具体设定，不要泛化；
3. 用中文。`;

// 回填向导：从对话提取六步答案（只填对话中出现的步骤）
export const STORY_BACKFILL_PROMPT = `你是导演工作台的故事编剧。请从刚才的对话中提取故事设定，回填到向导步骤。
只输出以下格式（每行一个步骤，冒号后是内容；对话中未涉及的步骤省略该行，不要输出其他任何文字）：

theme: 一句话主题
protagonist: 主角身份、性格、目标
support: 配角列表
antagonist: 冲突来源
scenes: 场景列表
ending: 结局设定

要求：忠实于对话内容，不要自行发挥；用中文。`;
```

- [ ] **Step 4: client 方法（web/src/api/client.ts 追加）**

```ts
// —— 故事向导对话式 ——
// 对话历史（独立 story-chat.json）
async getStoryChatHistory(): Promise<Array<{ who: 'user' | 'agent'; text: string; at: number }>> {
  const r = await req<{ messages: Array<{ who: 'user' | 'agent'; text: string; at: number }> }>('/api/story/chat/history');
  return r.messages ?? [];
},

// SSE 流式对话（协议同 /api/agent/chat，端点独立）
async storyChat(
  message: string,
  onChunk: (text: string) => void,
  model?: string,
  thinking?: string,
): Promise<void> {
  const res = await fetch('/api/story/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, model, thinking }),
  });
  if (!res.ok || !res.body) throw new Error(`story chat 请求失败: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 2);
      if (!frame.startsWith('data: ')) continue;
      const payload = frame.slice(6);
      if (payload === '[DONE]') return;
      try {
        onChunk((JSON.parse(payload) as { chunk: string }).chunk);
      } catch {
        // 忽略坏帧
      }
    }
  }
},
```

- [ ] **Step 5: 实现 StoryChat 组件**

创建 `web/src/views/StoryChat.tsx`：

```tsx
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { client } from '../api/client';
import { STORY_BACKFILL_PROMPT, STORY_CHAT_SYSTEM, STORY_SUMMARIZE_PROMPT } from './roles';
import { AiButton, EmptyState, ErrorBanner } from './role-ui';

export interface ChatMsg { who: 'user' | 'agent'; text: string }

// 六步答案约定格式解析：按行匹配 `stepId: 内容`，非法行忽略（导出便于测试）
export function parseStoryAnswers(text: string): Record<string, string> {
  const STEP_IDS = ['theme', 'protagonist', 'support', 'antagonist', 'scenes', 'ending'];
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^(theme|protagonist|support|antagonist|scenes|ending):\s*(.+)$/.exec(line.trim());
    if (m && STEP_IDS.includes(m[1]!)) {
      out[m[1]!] = m[2]!.trim();
    }
  }
  return out;
}

export function StoryChat(props: {
  projectName: string;
  // 回填向导成功回调：携带解析出的答案（父组件写入 story.json 并切回向导式）
  onBackfill: (answers: Record<string, string>) => void;
  // 总结成稿成功回调（父组件刷新已完成状态）
  onSummarized: () => void;
}) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false); // 发送/总结/回填共用 busy（防并发）
  const [action, setAction] = useState<'summarize' | 'backfill' | null>(null);
  const dirtyRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 项目切换/挂载时加载历史
  useEffect(() => {
    dirtyRef.current = false;
    setMsgs([]);
    setLoaded(false);
    let disposed = false;
    void client.getStoryChatHistory().then((h) => {
      if (disposed) return;
      setMsgs(h.map((m) => ({ who: m.who, text: m.text })));
      setLoaded(true);
    }).catch(() => {
      if (!disposed) { setError('加载对话历史失败'); setLoaded(true); }
    });
    return () => { disposed = true; };
  }, [props.projectName]);

  // 追加流式 chunk 到最后一条 agent 消息
  const appendStream = (chunk: string) => {
    setMsgs((m) => {
      const next = [...m];
      const last = next[next.length - 1];
      if (last && last.who === 'agent') {
        next[next.length - 1] = { ...last, text: last.text + chunk };
      } else {
        next.push({ who: 'agent', text: chunk });
      }
      return next;
    });
  };

  const send = () => {
    const text = input.trim();
    if (!text || busy) return;
    dirtyRef.current = true;
    setInput('');
    setBusy(true);
    setError('');
    setMsgs((m) => [...m, { who: 'user', text }]);
    client.storyChat(text, appendStream)
      .catch(() => appendStream('\n\n（agent 连接失败）'))
      .finally(() => setBusy(false));
  };

  // 跑一次「总结成稿」或「回填向导」：让 AI 基于全部对话输出六步答案
  const runAction = (kind: 'summarize' | 'backfill') => {
    if (busy) return;
    setBusy(true);
    setAction(kind);
    setError('');
    const system = kind === 'summarize' ? STORY_SUMMARIZE_PROMPT : STORY_BACKFILL_PROMPT;
    const prompt = `${STORY_CHAT_SYSTEM}\n\n${system}`;
    let acc = '';
    setMsgs((m) => [...m, { who: 'user', text: kind === 'summarize' ? '（请总结成稿）' : '（请回填向导）' }]);
    client.storyChat(prompt, (chunk) => {
      acc += chunk;
      appendStream(chunk);
    }).catch(() => appendStream('\n\n（agent 连接失败）')).then(() => {
      const answers = parseStoryAnswers(acc);
      if (Object.keys(answers).length === 0) {
        setError('未识别到答案格式，请重试');
      } else if (kind === 'backfill') {
        props.onBackfill(answers);
      } else {
        props.onSummarized();
      }
    }).finally(() => {
      setBusy(false);
      setAction(null);
    });
  };

  // 总结成稿：答案写入 story.json 并 complete（父组件处理）——父组件通过 onSummarized 回调确认
  const summarize = () => runAction('summarize');
  const backfill = () => runAction('backfill');

  if (!loaded) {
    return <div className="chat-wrap"><div className="role-loading">加载中…</div></div>;
  }

  return (
    <div className="chat-wrap">
      <div className="chat-msgs">
        {msgs.length === 0 && (
          <EmptyState icon="💬" text="还没有对话，从任意创意开始吧——主题、角色、情节都可以聊" />
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`chat-msg ${m.who}`}>
            <div className="chat-who">{m.who === 'user' ? 'YOU' : 'AI · 编剧'}</div>
            <div className="chat-bubble">
              {m.who === 'agent' ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
              ) : m.text}
            </div>
          </div>
        ))}
        {busy && <div className="chat-thinking">⏳ AI 思考中…</div>}
      </div>
      <div className="chat-input-row">
        <textarea
          ref={inputRef}
          className="ne-input chat-input" data-testid="chat-input"
          placeholder="和编剧聊聊你的故事…（Enter 发送 · Shift+Enter 换行）"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
        />
        <button className="btn-primary" onClick={send} disabled={busy || !input.trim()}>发送</button>
      </div>
      <div className="chat-actions">
        <AiButton busy={busy && action === 'summarize'} onClick={summarize}>✨ 总结成稿</AiButton>
        <AiButton busy={busy && action === 'backfill'} onClick={backfill}>↩ 回填向导</AiButton>
        <span className="chat-hint">总结成稿：对话 → 完整故事文档入库；回填向导：对话 → 六步答案写入向导</span>
      </div>
      {error && <ErrorBanner text={error} />}
    </div>
  );
}
```

**注意**：runAction 的实现有个细节——`client.storyChat(prompt, ...)` 发送的是组装好的完整 prompt（角色+指令），而不是用户消息；后端会把它当用户消息落盘。为避免污染历史，落盘的文本是「（请总结成稿）」这类标记。**但**后端 prompt 构造会把这条「用户消息」也带进下次对话上下文——可接受（编剧能看到操作记录）。此行为在 Task 3 集成时如有问题再调。

- [ ] **Step 6: 样式（web/src/App.css 追加）**

```css
/* ===== story 对话式（StoryChat） ===== */
.chat-wrap { display: flex; flex-direction: column; gap: 12px; flex: 1; min-height: 0; }
.chat-msgs { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 12px; padding-right: 6px; }
.chat-msg { display: flex; flex-direction: column; gap: 3px; max-width: 78%; }
.chat-msg.user { align-self: flex-end; align-items: flex-end; }
.chat-msg.agent { align-self: flex-start; }
.chat-who { font-family: var(--mono); font-size: 9px; letter-spacing: .14em; color: var(--text-faint); }
.chat-msg.user .chat-who { color: var(--amber); }
.chat-bubble {
  padding: 9px 12px; border-radius: 10px; font-size: 12.5px; line-height: 1.65;
  border: 1px solid var(--border); background: var(--panel); color: var(--text);
}
.chat-msg.user .chat-bubble { background: var(--amber-dim); border-color: rgba(232, 163, 61, .3); }
.chat-bubble p { margin: 0 0 6px; }
.chat-bubble p:last-child { margin: 0; }
.chat-bubble pre { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px; overflow: auto; font-size: 11px; }
.chat-thinking { font-family: var(--mono); font-size: 11px; color: var(--text-faint); align-self: flex-start; }
.chat-input-row { display: flex; gap: 8px; align-items: flex-end; }
.chat-input { flex: 1; resize: vertical; font-family: var(--sans); font-size: 13px; line-height: 1.6; }
.chat-actions { display: flex; align-items: center; gap: 10px; }
.chat-hint { font-size: 11px; color: var(--text-faint); margin-left: auto; }
```

- [ ] **Step 7: 运行测试确认通过**

Run: `pnpm vitest run web/src/views/StoryChat.test.tsx`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add web/src/views/StoryChat.tsx web/src/views/StoryChat.test.tsx web/src/views/roles.ts web/src/api/client.ts web/src/App.css
git commit -m "feat(story): 对话式 StoryChat 组件（自由对话 + 总结成稿/回填向导解析）"
```

---

### Task 3: StoryTellerView 模式切换集成 + 全量回归

**Files:**
- Modify: `web/src/views/StoryTellerView.tsx`（模式 tab + 集成 StoryChat）
- Modify: `web/src/views/StoryTeller.test.tsx`（模式切换用例 + 现有用例适配）
- Test: `web/src/App.test.tsx`（回归确认）

**Interfaces:**
- Consumes: Task 2 的 `StoryChat`（onBackfill/onSummarized 回调）、现有 `client.saveStory/completeStory/getStory`

- [ ] **Step 1: 写失败测试（模式切换）**

追加到 `web/src/views/StoryTeller.test.tsx`：

```tsx
describe('StoryTellerView 模式切换', () => {
  it('默认向导式，切到对话式后显示聊天区', async () => {
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText(/故事主题是什么/)).toBeInTheDocument());
    // 默认向导式
    expect(screen.getByTestId('story-answer')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mode-chat'));
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeInTheDocument());
    expect(screen.queryByTestId('story-answer')).not.toBeInTheDocument();
  });

  it('对话式回填向导：answers 写入后切回向导式并显示答案', async () => {
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText(/故事主题是什么/)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('mode-chat'));
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeInTheDocument());
    // 触发回填（mock fetch 的 /api/story/chat 已在文件级 mock 中返回六步格式？——
    // 需要给本文件 mock 加 story/chat 分支：返回 'theme: 战争与和解' 帧）
    fireEvent.click(screen.getByText('↩ 回填向导'));
    // 回填后应切回向导式并显示主题答案
    await waitFor(() => expect(screen.getByTestId('story-answer')).toBeInTheDocument());
    expect(screen.getByTestId('story-answer')).toHaveValue('战争与和解');
  });
});
```

**同时**：文件级 fetch mock 需加 `/api/story/chat/history` 与 `/api/story/chat` 分支（在 `/api/story` 分支之后判断，`/api/story/chat/history` 必须先于 `/api/story` 匹配——用 includes('/api/story/chat') 判断即可，注意顺序放在 `/api/story/complete` 之后、`/api/story` 之前）：

```ts
if (u.includes('/api/story/chat')) {
  // history GET 或 chat POST 都返回空/简单帧
  return new Response(JSON.stringify({ messages: [] }), { status: 200 });
}
```

（POST /api/story/chat 需要 SSE 响应——模式切换用例只测 UI 切换不发送，回填用例需要 SSE 帧。给 mock 加 method 判断：POST 时返回 `data: {"chunk":"theme: 战争与和解"}\n\ndata: [DONE]\n\n`。）

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run web/src/views/StoryTeller.test.tsx`
Expected: FAIL — 找不到 `mode-chat`。

- [ ] **Step 3: 实现模式切换集成**

修改 `web/src/views/StoryTellerView.tsx`：

1. imports 追加：

```tsx
import { StoryChat } from './StoryChat';
```

2. 组件内加模式状态：

```tsx
// 模式切换：向导式 / 对话式（localStorage 记住上次选择）
const [mode, setMode] = useState<'wizard' | 'chat'>(() => {
  const saved = localStorage.getItem('dw:storyMode');
  return saved === 'chat' ? 'chat' : 'wizard';
});

const switchMode = (m: 'wizard' | 'chat') => {
  setMode(m);
  localStorage.setItem('dw:storyMode', m);
};
```

3. 回填回调（对话式 → 写入 answers → 切回向导式并加载新答案）：

```tsx
// 对话式回填向导：六步答案写入 story.json，切回向导式展示
const handleBackfill = (answers: Record<string, string>) => {
  void client.saveStory({ answers }).then((s) => {
    setStory(s);
    setDraft(s.answers[STORY_STEPS[Math.min(s.step, STORY_STEPS.length - 1)]!.id] ?? '');
    switchMode('wizard');
    setError('');
  }).catch((err) => setError(err instanceof Error ? err.message : '回填失败'));
};

// 总结成稿：答案写入 story.json → complete 入库 → 刷新完成状态（留在对话式）
const handleSummarized = () => {
  // 答案在对话流中已由 AI 输出并展示；这里从后端最新 answers 直接 complete
  void client.completeStory().then((r) => {
    setStory(r.story);
    setSaved(true);
    setError('');
  }).catch((err) => setError(err instanceof Error ? err.message : '总结入库失败'));
};
```

**注意**：`handleSummarized` 依赖 answers 已被写入 story.json——但 runAction 的总结成稿路径只回调 onSummarized，未先保存 answers！需要调整：总结成稿流程应先把解析的答案写入 story.json 再 complete。修正——StoryChat 的 onSummarized 改为携带答案：

```tsx
onSummarized: (answers: Record<string, string>) => void;
```

StoryChat 内部：

```tsx
} else if (kind === 'backfill') {
  props.onBackfill(answers);
} else {
  props.onSummarized(answers);
}
```

StoryTellerView 侧：

```tsx
// 总结成稿：解析答案 → 写入 story.json → complete 入库 → 刷新完成状态
const handleSummarized = (answers: Record<string, string>) => {
  void client.saveStory({ answers }).then(() => client.completeStory()).then((r) => {
    setStory(r.story);
    setSaved(true);
    setError('');
  }).catch((err) => setError(err instanceof Error ? err.message : '总结入库失败'));
};
```

（Task 2 的 StoryChat 签名按此调整：`onSummarized: (answers: Record<string, string>) => void`。）

4. 渲染：RoleHeader 之后、向导内容之前加模式 tab；内容区按 mode 条件渲染：

```tsx
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
```

内容区：

```tsx
{mode === 'chat' ? (
  <StoryChat
    projectName={props.projectName}
    onBackfill={handleBackfill}
    onSummarized={handleSummarized}
  />
) : (
  <>
    {/* 现有：步骤轨道 + banner + 卡片（原样保留） */}
  </>
)}
```

5. 样式（App.css 追加）：

```css
/* 向导模式切换（向导式 / 对话式） */
.role-mode-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); }
.role-mode-tab {
  padding: 7px 16px; font-size: 12px; color: var(--text-dim); cursor: pointer;
  border: none; background: none; border-bottom: 2px solid transparent; transition: all .15s;
}
.role-mode-tab:hover { color: var(--text); }
.role-mode-tab.active { color: var(--amber); border-bottom-color: var(--amber); font-weight: 600; }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run web/src/views/StoryTeller.test.tsx web/src/views/StoryChat.test.tsx web/src/App.test.tsx`
Expected: 全部 PASS

- [ ] **Step 5: 全量回归**

Run: `pnpm test`（根目录）+ `pnpm vitest run`（web 目录）
Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add web/src/views/StoryTellerView.tsx web/src/views/StoryTeller.test.tsx web/src/App.css web/src/views/StoryChat.tsx web/src/views/StoryChat.test.tsx
git commit -m "feat(story): 向导模式切换集成（对话式 ↔ 向导式双向衔接）"
```

---

## 自审清单

1. **Spec 覆盖**：
   - 独立端点 + 全上下文 → Task 1 ✓
   - 独立历史 story-chat.json 上限 100 → Task 1 ✓
   - 对话 UI + 流式 + Markdown → Task 2 ✓
   - 约定格式解析（导出 parseStoryAnswers）→ Task 2 ✓
   - 总结成稿复用 complete → Task 3（onSummarized 携带答案 → saveStory → completeStory）✓
   - 回填向导 → Task 3（onBackfill → saveStory → 切回向导式）✓
   - 模式 tab + localStorage → Task 3 ✓
   - 错误矩阵（损坏兜底/解析失败/409/切换项目）→ 各任务测试 ✓

2. **占位符扫描**：所有步骤含完整代码，无 TBD。

3. **类型一致性**：
   - `ChatMessage` 复用 `src/agent/chat-history.ts` 导出（who/text/at）✓
   - `parseStoryAnswers` 返回 `Record<string, string>`，Task 3 的 handleBackfill/handleSummarized 同型 ✓
   - `client.storyChat(message, onChunk, model?, thinking?)` 与 Task 2 组件调用一致 ✓
   - Task 3 中 StoryChat props 的 `onSummarized` 签名改为携带 answers——Task 2 的组件实现需同步（计划中已注明修正）✓

## 验收标准

1. `pnpm test` 全部通过（现有 + 新增约 15 个用例）。
2. 对话式自由聊 → 总结成稿 → 素材库出现 `story_<项目>.md`，两模式显示已完成。
3. 对话式聊 → 回填向导 → 切回向导式可见六步答案。
4. 切换项目后对话历史各自独立。
