# Agent 对话多会话实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AGENT 面板与故事向导对话式支持多会话——会话历史列表、新建/点选查看并继续/重命名/删除；会话按项目隔离、按会话作用域落盘与取上下文。

**Architecture:** 新建共享会话存储 `src/sessions/store.ts`（文件参数化，`{ sessions:[{id,title,createdAt,updatedAt,messages}], activeId }`，旧扁平数组自动迁移为「会话 1」）；`chat-history.ts` / `story/chat-store.ts` 改薄封装（保留导出名 + 上限 300/100）；每区域一组 sessions CRUD 端点 + history/chat 按 sessionId 作用域；前端 AgentPanel 顶部会话条（下拉）、StoryChat 左侧会话列表面板。

**Tech Stack:** Fastify + Node fs（后端）、React 18 + vitest + @testing-library/react（前端）、纯 CSS。

## Global Constraints

- 零新依赖。
- 会话文件结构：`{ sessions: [{ id, title, createdAt, updatedAt, messages }], activeId: string | null }`；旧扁平数组（ChatMessage[]）读时迁移为标题「会话 1」的会话（惰性写回：下次写操作落盘新结构）。
- 每会话消息上限沿用：AGENT 300、故事 100（裁剪最早）；会话总数不设限。
- 标题：首条用户消息截断 20 字符；无消息 = 「新会话」；空标题重命名忽略。
- 删除当前会话 → activeId 回退最近 updatedAt 的会话；无会话 → null。删除不存在 → 404 `SESSION_NOT_FOUND`（`DirectorErrorCode` 新增 + 错误处理器映射 404）。
- `GET .../history` 不带 sessionId → 当前 active 会话消息（向后兼容）。
- 中文 UI/注释/测试命名；TDD 每任务。

---
## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/sessions/store.ts` | 共享会话存储（read/create/rename/delete/append/list/activeMessages + 迁移） | 新建 |
| `src/sessions/store.test.ts` | 存储语义测试 | 新建 |
| `src/types.ts` | DirectorErrorCode 加 `SESSION_NOT_FOUND` | 修改 |
| `src/agent/chat-history.ts` | 薄封装（chat.json，上限 300，保留导出名） | 重写 |
| `src/agent/chat-history.test.ts` | 适配新签名 + 会话语义 | 修改 |
| `src/story/chat-store.ts` | 薄封装（story-chat.json，上限 100） | 重写 |
| `src/story/chat-store.test.ts` | 适配新签名 + 会话语义 | 修改 |
| `src/api/routes.ts` | sessions CRUD + history/chat 作用域 + 404 映射 | 修改 |
| `src/api/api.test.ts`（及 story-api.test.ts） | 端点与作用域测试 | 修改 |
| `web/src/api/client.ts` | 会话 CRUD 方法 + history/chat 加 sessionId | 修改 |
| `web/src/api/agent.ts` | agentChat body 加 sessionId | 修改 |
| `web/src/panels/AgentPanel.tsx` | 顶部会话条（下拉：点选/新建/重命名/删除） | 修改 |
| `web/src/panels/agent.test.tsx` | 会话条测试 | 修改 |
| `web/src/views/StoryChat.tsx` | 左侧会话列表面板 + sessionId 接线 | 修改 |
| `web/src/views/StoryChat.test.tsx` | 会话面板测试 | 修改 |
| `web/src/App.tsx` | handleAgentStream 传 sessionId | 修改 |
| `web/src/App.css` | 会话条/会话面板样式 | 修改 |
| `web/src/types.ts` | SessionMeta 等类型 | 修改 |

---

### Task 1: 共享会话存储

**Files:**
- Create: `src/sessions/store.ts`、`src/sessions/store.test.ts`
- Modify: `src/types.ts`（DirectorErrorCode + SESSION_NOT_FOUND）、`src/api/routes.ts`（错误处理器 404 映射）

**Interfaces:**
- Produces:
```ts
export interface ChatMessage { who: 'user' | 'agent'; text: string; at: number }
export interface ChatSession { id: string; title: string; createdAt: number; updatedAt: number; messages: ChatMessage[] }
export interface SessionFile { sessions: ChatSession[]; activeId: string | null }
export interface SessionMeta { id: string; title: string; createdAt: number; updatedAt: number }
export function readSessions(file: string): SessionFile            // 迁移旧数组；损坏→空库
export function createSession(file: string): SessionFile           // 新会话 active；标题「新会话」
export function renameSession(file: string, id: string, title: string): SessionFile  // 空标题忽略；不存在抛 SESSION_NOT_FOUND
export function deleteSession(file: string, id: string): SessionFile // 抛 SESSION_NOT_FOUND；删当前→回退最近 updatedAt；无会话→activeId null
export function appendMessage(file: string, sessionId: string | null, who: ChatMessage['who'], text: string, maxMessages: number): SessionFile // 无会话自动创建（标题=首条用户消息 20 字）；裁剪；刷新 updatedAt
export function sessionList(file: string): { sessions: SessionMeta[]; activeId: string | null }
export function activeMessages(file: string, sessionId?: string | null): ChatMessage[]
```

- [ ] **Step 1: 写失败测试**

创建 `src/sessions/store.test.ts`：

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activeMessages, appendMessage, createSession, deleteSession,
  readSessions, renameSession, sessionList,
} from './store.js';
import { DirectorError } from '../types.js';

let dir: string;
let file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'director-sessions-')); file = join(dir, 's.json'); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('readSessions', () => {
  it('缺失文件返回空库', () => {
    expect(readSessions(file)).toEqual({ sessions: [], activeId: null });
  });

  it('损坏文件返回空库（不抛错）', () => {
    writeFileSync(file, '{broken', 'utf8');
    expect(readSessions(file)).toEqual({ sessions: [], activeId: null });
  });

  it('旧扁平数组迁移为「会话 1」', () => {
    writeFileSync(file, JSON.stringify([
      { who: 'user', text: '你好', at: 1 },
      { who: 'agent', text: '嗨', at: 2 },
    ]), 'utf8');
    const f = readSessions(file);
    expect(f.sessions).toHaveLength(1);
    expect(f.sessions[0]!.title).toBe('会话 1');
    expect(f.sessions[0]!.messages).toEqual([
      { who: 'user', text: '你好', at: 1 },
      { who: 'agent', text: '嗨', at: 2 },
    ]);
    expect(f.activeId).toBe(f.sessions[0]!.id);
  });
});

describe('createSession / renameSession', () => {
  it('createSession 新建并置为 active；重命名生效；空标题忽略', () => {
    const f1 = createSession(file);
    expect(f1.sessions).toHaveLength(1);
    expect(f1.sessions[0]!.title).toBe('新会话');
    expect(f1.activeId).toBe(f1.sessions[0]!.id);
    const f2 = createSession(file);
    expect(f2.sessions).toHaveLength(2);
    expect(f2.activeId).toBe(f2.sessions[1]!.id);
    const id = f2.sessions[1]!.id;
    const f3 = renameSession(file, id, '精灵与哥布林');
    expect(f3.sessions.find((s) => s.id === id)!.title).toBe('精灵与哥布林');
    const f4 = renameSession(file, id, '   ');
    expect(f4.sessions.find((s) => s.id === id)!.title).toBe('精灵与哥布林');
  });

  it('renameSession 不存在的 id 抛 SESSION_NOT_FOUND', () => {
    expect(() => renameSession(file, 'nope', 'x')).toThrowError(DirectorError);
    expect(() => renameSession(file, 'nope', 'x')).toThrowError(/SESSION_NOT_FOUND/);
  });
});

describe('deleteSession', () => {
  it('删除当前会话回退最近 updatedAt 的会话', () => {
    const f1 = createSession(file);           // s1（当前）
    const f2 = appendMessage(file, f1.activeId, 'user', '第一条', 300);
    const s1 = f2.activeId!;
    const f3 = createSession(file);           // s2（当前，无消息）
    const s2 = f3.activeId!;
    appendMessage(file, s2, 'user', '第二条', 300);
    // 手动把 s1 的 updatedAt 改新：append s1 再 append s2 → s2 更新；为测「最近」，先 append s2 后 append s1
    appendMessage(file, s1, 'user', '第三条', 300); // s1 变最新
    const f4 = deleteSession(file, s2);       // 删当前 s2 → 回退 s1
    expect(f4.sessions.map((s) => s.id)).not.toContain(s2);
    expect(f4.activeId).toBe(s1);
  });

  it('删除不存在的 id 抛 SESSION_NOT_FOUND', () => {
    expect(() => deleteSession(file, 'nope')).toThrowError(/SESSION_NOT_FOUND/);
  });

  it('删光所有会话 → activeId null', () => {
    const f1 = createSession(file);
    const f2 = deleteSession(file, f1.activeId!);
    expect(f2.sessions).toEqual([]);
    expect(f2.activeId).toBeNull();
  });
});

describe('appendMessage', () => {
  it('追加消息、刷新 updatedAt、按 maxMessages 裁剪最早', () => {
    const f1 = createSession(file);
    const id = f1.activeId!;
    for (let i = 0; i < 5; i++) appendMessage(file, id, 'user', `m${i}`, 3);
    const f2 = readSessions(file);
    expect(f2.sessions[0]!.messages.map((m) => m.text)).toEqual(['m2', 'm3', 'm4']);
    expect(f2.sessions[0]!.updatedAt).toBeGreaterThanOrEqual(f1.sessions[0]!.createdAt);
  });

  it('sessionId null 时自动创建会话（标题=首条用户消息 20 字）', () => {
    const f = appendMessage(file, null, 'user', '这是一条很长的用户消息用来测试标题截断行为', 300);
    expect(f.sessions).toHaveLength(1);
    expect(f.sessions[0]!.title).toBe('这是一条很长的用户消息用来测');
    expect(f.activeId).toBe(f.sessions[0]!.id);
    // agent 消息不生成标题：新会话首条为空消息场景 → 标题「新会话」
    const f2 = createSession(file);
    appendMessage(file, f2.activeId, 'user', '', 300); // 空文本忽略
    expect(f2.sessions.find((s) => s.id === f2.activeId)!.title).toBe('新会话');
  });

  it('空文本忽略不追加', () => {
    createSession(file);
    const before = activeMessages(file);
    appendMessage(file, null, 'user', '   ', 300);
    expect(activeMessages(file)).toEqual(before);
  });
});

describe('sessionList / activeMessages', () => {
  it('sessionList 返回元数据（不含 messages）；activeMessages 按会话取消息', () => {
    const f1 = createSession(file);
    appendMessage(file, f1.activeId, 'user', 'hello', 300);
    const list = sessionList(file);
    expect(list.sessions[0]).toEqual({
      id: f1.activeId, title: 'hello', createdAt: expect.any(Number), updatedAt: expect.any(Number),
    });
    expect(activeMessages(file)).toEqual([{ who: 'user', text: 'hello', at: expect.any(Number) }]);
    expect(activeMessages(file, 'missing')).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/sessions/store.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 store.ts**

创建 `src/sessions/store.ts`：

```ts
// 共享会话存储：AGENT 面板（chat.json）与故事对话式（story-chat.json）共用的多会话结构。
// 文件参数化（调用方传路径）；结构 { sessions: [{id,title,createdAt,updatedAt,messages}], activeId }；
// 旧扁平消息数组（ChatMessage[]）读时自动迁移为「会话 1」（惰性写回：下次写操作落盘新结构）。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DirectorError } from '../types.js';

export interface ChatMessage { who: 'user' | 'agent'; text: string; at: number }
export interface ChatSession { id: string; title: string; createdAt: number; updatedAt: number; messages: ChatMessage[] }
export interface SessionFile { sessions: ChatSession[]; activeId: string | null }
export interface SessionMeta { id: string; title: string; createdAt: number; updatedAt: number }

const TITLE_LIMIT = 20;
let seq = 0;

function newId(): string {
  seq += 1;
  return `s-${Date.now().toString(36)}-${seq.toString(36)}`;
}

function trimTitle(text: string): string {
  const t = text.trim();
  return t ? Array.from(t).slice(0, TITLE_LIMIT).join('') : '新会话';
}

export function readSessions(file: string): SessionFile {
  if (!existsSync(file)) return { sessions: [], activeId: null };
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    // 旧结构：扁平消息数组 → 迁移为单个「会话 1」
    if (Array.isArray(data)) {
      const id = newId();
      return { sessions: [{ id, title: '会话 1', createdAt: Date.now(), updatedAt: Date.now(), messages: data }], activeId: id };
    }
    if (typeof data !== 'object' || data === null) return { sessions: [], activeId: null };
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    return {
      sessions: sessions.map((s: Partial<ChatSession>) => ({
        id: String(s.id ?? newId()),
        title: typeof s.title === 'string' && s.title.trim() ? s.title : '新会话',
        createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
        updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now(),
        messages: Array.isArray(s.messages) ? s.messages : [],
      })),
      activeId: typeof data.activeId === 'string' ? data.activeId : null,
    };
  } catch {
    return { sessions: [], activeId: null };
  }
}

function writeSessions(file: string, f: SessionFile): SessionFile {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(f, null, 2), 'utf8');
  renameSync(tmp, file);
  return f;
}

export function sessionList(file: string): { sessions: SessionMeta[]; activeId: string | null } {
  const f = readSessions(file);
  return {
    sessions: f.sessions.map((s) => ({ id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt })),
    activeId: f.activeId,
  };
}

export function activeMessages(file: string, sessionId?: string | null): ChatMessage[] {
  const f = readSessions(file);
  const id = sessionId ?? f.activeId;
  return f.sessions.find((s) => s.id === id)?.messages ?? [];
}

export function createSession(file: string): SessionFile {
  const f = readSessions(file);
  const now = Date.now();
  const s: ChatSession = { id: newId(), title: '新会话', createdAt: now, updatedAt: now, messages: [] };
  f.sessions.push(s);
  f.activeId = s.id;
  return writeSessions(file, f);
}

export function renameSession(file: string, id: string, title: string): SessionFile {
  const f = readSessions(file);
  const s = f.sessions.find((x) => x.id === id);
  if (!s) throw new DirectorError('SESSION_NOT_FOUND', `会话不存在: ${id}`);
  const t = title.trim();
  if (t) s.title = Array.from(t).slice(0, TITLE_LIMIT).join('');
  return writeSessions(file, f);
}

export function deleteSession(file: string, id: string): SessionFile {
  const f = readSessions(file);
  const idx = f.sessions.findIndex((s) => s.id === id);
  if (idx < 0) throw new DirectorError('SESSION_NOT_FOUND', `会话不存在: ${id}`);
  f.sessions.splice(idx, 1);
  if (f.activeId === id) {
    // 回退最近 updatedAt 的会话；无会话 → null
    const rest = [...f.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    f.activeId = rest[0]?.id ?? null;
  }
  return writeSessions(file, f);
}

export function appendMessage(
  file: string,
  sessionId: string | null,
  who: ChatMessage['who'],
  text: string,
  maxMessages: number,
): SessionFile {
  const trimmed = text.trim();
  if (!trimmed) return readSessions(file);
  const f = readSessions(file);
  let s = f.sessions.find((x) => x.id === sessionId);
  if (!s) {
    // 无会话自动创建：标题 = 首条用户消息截断 20 字
    const now = Date.now();
    s = { id: newId(), title: who === 'user' ? trimTitle(trimmed) : '新会话', createdAt: now, updatedAt: now, messages: [] };
    f.sessions.push(s);
    f.activeId = s.id;
  }
  s.messages.push({ who, text: trimmed, at: Date.now() });
  if (s.messages.length > maxMessages) {
    s.messages = s.messages.slice(s.messages.length - maxMessages);
  }
  s.updatedAt = Date.now();
  return writeSessions(file, f);
}
```

`src/types.ts` DirectorErrorCode 增加：

```ts
  | 'YAML_EXPORT_FAILED' | 'SESSION_NOT_FOUND';
```

`src/api/routes.ts` 错误处理器（约 896-899 行）增加映射：

```ts
        : err.code === 'NODE_NOT_FOUND' || err.code === 'EDGE_NOT_FOUND' || err.code === 'SESSION_NOT_FOUND' ? 404
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/sessions/store.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/sessions/store.ts src/sessions/store.test.ts src/types.ts src/api/routes.ts
git commit -m "feat(sessions): 共享会话存储（多会话 CRUD + 旧历史迁移 + SESSION_NOT_FOUND 404）"
```

---

### Task 2: 薄封装 + 路由作用域

**Files:**
- Modify: `src/agent/chat-history.ts`、`src/agent/chat-history.test.ts`、`src/story/chat-store.ts`、`src/story/chat-store.test.ts`、`src/api/routes.ts`
- Test: `src/agent/chat-history.test.ts`、`src/story/chat-store.test.ts`、`src/api/api.test.ts`、`src/api/story-api.test.ts`

**Interfaces:**
- Consumes: Task 1 的 store 函数与类型。
- Produces:
```ts
// chat-history.ts：chat.json，MAX 300
export type { ChatMessage, ChatSession, SessionFile, SessionMeta } from '../sessions/store.js';
export function readChatHistory(projectDir: string, sessionId?: string | null): ChatMessage[]
export function appendChatMessage(projectDir: string, sessionId: string | null, who: ChatMessage['who'], text: string): SessionFile
export function listChatSessions(projectDir: string): { sessions: SessionMeta[]; activeId: string | null }
export function createChatSession(projectDir: string): SessionFile
export function renameChatSession(projectDir: string, id: string, title: string): SessionFile
export function deleteChatSession(projectDir: string, id: string): SessionFile
// story/chat-store.ts：story-chat.json，MAX 100，同构导出 readStoryChat(projectDir, sessionId?) / appendStoryChat(projectDir, sessionId, who, text) / listStorySessions / createStorySession / renameStorySession / deleteStorySession
```

- [ ] **Step 1: 写失败测试**

先改 `src/agent/chat-history.test.ts`（沿用其既有隔离模式：临时 projectDir + 顶部 node:fs 导入；若文件顶部已导入 `writeFileSync`/`mkdirSync` 则复用，否则补充），替换为：

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendChatMessage, createChatSession, deleteChatSession,
  listChatSessions, readChatHistory, renameChatSession,
} from './chat-history.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'director-chat-hist-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('chat-history 会话封装', () => {
  it('旧扁平数组历史迁移为「会话 1」并可读回', () => {
    writeFileSync(join(dir, '.director', 'chat.json'), JSON.stringify([
      { who: 'user', text: '旧消息', at: 1 },
    ]), 'utf8');
    const hist = readChatHistory(dir);
    expect(hist).toEqual([{ who: 'user', text: '旧消息', at: 1 }]);
  });

  it('appendChatMessage 落入指定会话；跨会话隔离', () => {
    const f1 = createChatSession(dir);            // s1
    const s1 = f1.activeId!;
    const f2 = createChatSession(dir);            // s2（当前）
    const s2 = f2.activeId!;
    appendChatMessage(dir, s1, 'user', '给 s1 的消息');
    appendChatMessage(dir, s2, 'user', '给 s2 的消息');
    expect(readChatHistory(dir, s1).map((m) => m.text)).toEqual(['给 s1 的消息']);
    expect(readChatHistory(dir, s2).map((m) => m.text)).toEqual(['给 s2 的消息']);
    // 不带 sessionId → 当前 active（s2）
    expect(readChatHistory(dir).map((m) => m.text)).toEqual(['给 s2 的消息']);
  });

  it('appendChatMessage 无会话时自动创建（sessionId null）', () => {
    const f = appendChatMessage(dir, null, 'user', '第一条消息');
    expect(f.sessions).toHaveLength(1);
    expect(f.sessions[0]!.title).toBe('第一条消息');
  });

  it('listChatSessions 元数据 + rename/delete 走封装', () => {
    const f1 = createChatSession(dir);
    const id = f1.activeId!;
    renameChatSession(dir, id, '改名后');
    expect(listChatSessions(dir).sessions[0]!.title).toBe('改名后');
    const f2 = deleteChatSession(dir, id);
    expect(f2.sessions).toEqual([]);
    expect(f2.activeId).toBeNull();
  });
});
```

`src/story/chat-store.test.ts` 追加会话用例（同构）：迁移、跨会话隔离、自动创建、rename/delete（沿用该文件既有的隔离模式）。

`src/api/api.test.ts`（或既有 chat 相关 describe）追加：

```ts
  it('sessions CRUD：新建/重命名/删除/回退 activeId', async () => {
    const r1 = await a.inject({ method: 'POST', url: '/api/agent/sessions', payload: {} });
    expect(r1.statusCode).toBe(200);
    const id1 = r1.json().activeId;
    const r2 = await a.inject({ method: 'POST', url: '/api/agent/sessions', payload: {} });
    const id2 = r2.json().activeId;
    expect(id1).not.toBe(id2);
    // 重命名 id1
    const r3 = await a.inject({ method: 'PATCH', url: `/api/agent/sessions/${id1}`, payload: { title: '会话甲' } });
    expect(r3.json().sessions.find((s: { id: string }) => s.id === id1).title).toBe('会话甲');
    // 删除当前（id2）→ 回退 id1
    const r4 = await a.inject({ method: 'DELETE', url: `/api/agent/sessions/${id2}`, payload: {} });
    expect(r4.statusCode).toBe(200);
    expect(r4.json().activeId).toBe(id1);
    // 删除不存在 → 404
    const r5 = await a.inject({ method: 'DELETE', url: '/api/agent/sessions/nope', payload: {} });
    expect(r5.statusCode).toBe(404);
    expect(r5.json().code).toBe('SESSION_NOT_FOUND');
  });

  it('chat 落盘到指定会话；history?sessionId 读回', async () => {
    vi.stubEnv('DIRECTOR_PI_CMD', `node ${join(process.cwd(), 'src/agent/mock-agent.mjs')}`);
    vi.stubEnv('MOCK_REPLY', '回显');
    const r = await a.inject({ method: 'POST', url: '/api/agent/sessions', payload: {} });
    const sid = r.json().activeId as string;
    await a.inject({ method: 'POST', url: '/api/agent/chat', payload: { message: '你好', sessionId: sid } });
    const h = await a.inject({ method: 'GET', url: `/api/agent/history?sessionId=${sid}` });
    expect(h.statusCode).toBe(200);
    const messages = h.json().messages;
    expect(messages).toHaveLength(2);
    expect(messages[0].text).toBe('你好');
    // 不带 sessionId 也返回当前 active 会话（向后兼容）
    const h2 = await a.inject({ method: 'GET', url: '/api/agent/history' });
    expect(h2.json().messages).toHaveLength(2);
  });
```

`src/api/story-api.test.ts` 故事会话同构：POST /api/story/chat/sessions + chat { message, sessionId }（mock pi）+ history?sessionId 读回 + 跨会话隔离（两个会话的消息不串）。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/agent/chat-history.test.ts src/story/chat-store.test.ts src/api/api.test.ts src/api/story-api.test.ts`
Expected: 新用例 FAIL（旧签名/无会话端点）。

- [ ] **Step 3: 实现**

`src/agent/chat-history.ts` 全量替换：

```ts
// —— AGENT 聊天历史：按项目多会话持久化 ——
// 存储到 <projectDir>/.director/chat.json（与图数据/快照同级的运行时数据目录）：
// 重启服务器 / 刷新页面不丢失；切换项目时历史随项目加载，互不串扰。
// 结构见 src/sessions/store.ts（多会话 + 旧扁平数组迁移）。
import { join } from 'node:path';
import {
  activeMessages, appendMessage, createSession, deleteSession,
  renameSession, sessionList,
  type ChatMessage, type SessionFile, type SessionMeta,
} from '../sessions/store.js';

export type { ChatMessage, SessionFile, SessionMeta } from '../sessions/store.js';

const MAX_MESSAGES = 300;

function chatFile(projectDir: string): string {
  return join(projectDir, '.director', 'chat.json');
}

// 读取项目聊天历史（指定会话；缺省当前 active）；文件缺失或损坏返回空列表（防御式）
export function readChatHistory(projectDir: string, sessionId?: string | null): ChatMessage[] {
  return activeMessages(chatFile(projectDir), sessionId);
}

// 追加一条消息到指定会话（无会话自动创建）；超过上限裁剪最早；原子写
export function appendChatMessage(projectDir: string, sessionId: string | null, who: ChatMessage['who'], text: string): SessionFile {
  return appendMessage(chatFile(projectDir), sessionId, who, text, MAX_MESSAGES);
}

export function listChatSessions(projectDir: string): { sessions: SessionMeta[]; activeId: string | null } {
  return sessionList(chatFile(projectDir));
}

export function createChatSession(projectDir: string): SessionFile {
  return createSession(chatFile(projectDir));
}

export function renameChatSession(projectDir: string, id: string, title: string): SessionFile {
  return renameSession(chatFile(projectDir), id, title);
}

export function deleteChatSession(projectDir: string, id: string): SessionFile {
  return deleteSession(chatFile(projectDir), id);
}
```

`src/story/chat-store.ts` 同构重写（MAX_MESSAGES=100；文件 story-chat.json；导出 readStoryChat / appendStoryChat / listStorySessions / createStorySession / renameStorySession / deleteStorySession）。

`src/api/routes.ts` 改动：
- AGENT 会话端点（放在 `GET /api/agent/history` 前后）：

```ts
// —— AGENT 会话（多会话：列表/新建/重命名/删除；历史按会话作用域）——
app.get('/api/agent/sessions', async () => listChatSessions(ctx.projectDir));

app.post('/api/agent/sessions', async () => {
  const f = createChatSession(ctx.projectDir);
  return listChatSessions(ctx.projectDir);
});

app.patch('/api/agent/sessions/:id', async (req) => {
  const { id } = req.params as { id: string };
  const body = req.body as { title?: string };
  renameChatSession(ctx.projectDir, id, body.title ?? '');
  return listChatSessions(ctx.projectDir);
});

app.delete('/api/agent/sessions/:id', async (req) => {
  const { id } = req.params as { id: string };
  deleteChatSession(ctx.projectDir, id);
  return listChatSessions(ctx.projectDir);
});
```

- `GET /api/agent/history` 改：

```ts
app.get('/api/agent/history', async (req) => {
  const { sessionId } = req.query as { sessionId?: string };
  return { messages: readChatHistory(ctx.projectDir, sessionId ?? null) };
});
```

- `POST /api/agent/chat`：body 加 `sessionId?: string`；两处落盘改：

```ts
    const sessionId = body.sessionId ?? null;
    appendChatMessage(ctx.projectDir, sessionId, 'user', body.message);
    ...
      appendChatMessage(ctx.projectDir, sessionId, 'agent', agentText);
```

- 故事会话端点（`/api/story/chat/sessions` 一组，与 AGENT 同构）放在 story-chat 区：

```ts
app.get('/api/story/chat/sessions', async () => listStorySessions(ctx.projectDir));
app.post('/api/story/chat/sessions', async () => {
  createStorySession(ctx.projectDir);
  return listStorySessions(ctx.projectDir);
});
app.patch('/api/story/chat/sessions/:id', async (req) => {
  const { id } = req.params as { id: string };
  const body = req.body as { title?: string };
  renameStorySession(ctx.projectDir, id, body.title ?? '');
  return listStorySessions(ctx.projectDir);
});
app.delete('/api/story/chat/sessions/:id', async (req) => {
  const { id } = req.params as { id: string };
  deleteStorySession(ctx.projectDir, id);
  return listStorySessions(ctx.projectDir);
});
```

- `GET /api/story/chat/history` 改（带 sessionId）；`POST /api/story/chat` body 加 `sessionId`；prompt 历史改：

```ts
  const sessionId = body.sessionId ?? null;
  const history = readStoryChat(ctx.projectDir, sessionId);
  const prompt = buildStoryChatPrompt(graph.projectName, story.answers, history, message);
  ...
    appendStoryChat(ctx.projectDir, sessionId, 'user', body.persistAs ?? message);
  ...
    appendStoryChat(ctx.projectDir, sessionId, 'agent', agentText);
```

- 导入更新：routes.ts 增加 `listChatSessions, createChatSession, renameChatSession, deleteChatSession` 与故事侧同构导入。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/agent/chat-history.test.ts src/story/chat-store.test.ts src/api/api.test.ts src/api/story-api.test.ts`
Expected: 全部 PASS。再跑 `pnpm test`（后端全量）。

- [ ] **Step 5: 提交**

```bash
git add src/agent/chat-history.ts src/agent/chat-history.test.ts src/story/chat-store.ts src/story/chat-store.test.ts src/api/routes.ts src/api/api.test.ts src/api/story-api.test.ts
git commit -m "feat(api): 会话 CRUD 端点 + 历史/聊天按会话作用域（AGENT + 故事对话式）"
```

---

### Task 3: client + AgentPanel 会话条

**Files:**
- Modify: `web/src/api/client.ts`、`web/src/api/agent.ts`、`web/src/App.tsx`、`web/src/panels/AgentPanel.tsx`、`web/src/panels/agent.test.tsx`、`web/src/App.css`、`web/src/types.ts`

**Interfaces:**
- Consumes: Task 2 端点形状 `{ sessions: SessionMeta[]; activeId: string | null }`（CRUD 均返回该形状）；`GET .../history?sessionId=`；`POST chat` body.sessionId。
- Produces: `client.listAgentSessions / createAgentSession / renameAgentSession / deleteAgentSession`、`listChatHistory(sessionId?)`、`agentChat(..., sessionId?)`；`AgentPanel` 内部会话 state（sessions/activeId）+ 会话条 UI；App 的 `handleAgentStream` 透传 sessionId。

- [ ] **Step 1: 写失败测试**

`web/src/panels/agent.test.tsx` 改造 mock（URL 感知：sessions/history 返回 JSON，agent/chat 返回 SSE）并追加会话用例。将 beforeEach 的 fetch mock 替换为：

```tsx
let SESSIONS: Array<{ id: string; title: string; createdAt: number; updatedAt: number }> = [];
let ACTIVE: string | null = null;
let HISTORY: Array<{ who: string; text: string; at: number }> = [];

beforeEach(() => {
  SESSIONS = [];
  ACTIVE = null;
  HISTORY = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (u.includes('/api/agent/sessions')) {
      if (method === 'POST') {
        const id = `s${SESSIONS.length + 1}`;
        SESSIONS = [...SESSIONS, { id, title: '新会话', createdAt: 1, updatedAt: 1 }];
        ACTIVE = id;
        HISTORY = [];
      } else if (method === 'PATCH') {
        const id = u.split('/').pop();
        const body = JSON.parse(String(init?.body)) as { title: string };
        SESSIONS = SESSIONS.map((s) => (s.id === id ? { ...s, title: body.title } : s));
      } else if (method === 'DELETE') {
        const id = u.split('/').pop();
        SESSIONS = SESSIONS.filter((s) => s.id !== id);
        ACTIVE = SESSIONS[0]?.id ?? null;
        HISTORY = [];
      }
      return new Response(JSON.stringify({ sessions: SESSIONS, activeId: ACTIVE }), { status: 200 });
    }
    if (u.includes('/api/agent/history')) {
      return new Response(JSON.stringify({ messages: HISTORY }), { status: 200 });
    }
    if (u.includes('/api/agent/chat')) {
      return sseResponse(['分析中', '——结论：节奏递进']);
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());
```

> 既有 5 个用例依赖旧 mock（全 SSE）：`/api/agent/history` 现在返回 JSON —— 既有用例的发送/流式断言不受影响（发送走 /api/agent/chat SSE）；历史加载 `listChatHistory` 现在拿到空数组（原为解析失败静默）——断言仍成立。若个别用例断言受影响，以行为等价方式调整。

追加用例：

```tsx
  it('会话条：无会话时自动新建；显示当前会话标题', async () => {
    render(<AgentPanel chips={[]} onChipsChange={() => {}} onSend={() => []} />);
    await waitFor(() => expect(screen.getByTestId('agent-session-current')).toHaveTextContent('新会话'));
  });

  it('下拉选择历史会话：加载该会话消息', async () => {
    SESSIONS = [
      { id: 's1', title: '会话甲', createdAt: 1, updatedAt: 2 },
      { id: 's2', title: '会话乙', createdAt: 3, updatedAt: 4 },
    ];
    ACTIVE = 's2';
    HISTORY = [{ who: 'user', text: '乙的消息', at: 5 }];
    render(<AgentPanel chips={[]} onChipsChange={() => {}} onSend={() => []} />);
    await waitFor(() => expect(screen.getByText('乙的消息')).toBeInTheDocument());
    // 切到 s1：mock 里选择时把 HISTORY 换成 s1 内容（测试内联调整）
    SESSIONS = [{ id: 's1', title: '会话甲', createdAt: 1, updatedAt: 2 }];
    ACTIVE = 's1';
    HISTORY = [{ who: 'agent', text: '甲的历史', at: 6 }];
    fireEvent.click(screen.getByTestId('agent-session-current'));
    fireEvent.click(screen.getByText('会话甲'));
    await waitFor(() => expect(screen.getByText('甲的历史')).toBeInTheDocument());
  });

  it('发送携带当前 sessionId 到 chat 请求体', async () => {
    SESSIONS = [{ id: 's9', title: '当前', createdAt: 1, updatedAt: 1 }];
    ACTIVE = 's9';
    render(<AgentPanel chips={[]} onChipsChange={() => {}} onSend={() => []} />);
    await waitFor(() => expect(screen.getByTestId('agent-session-current')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText(/对画布提问/), { target: { value: '分析节奏' } });
    fireEvent.click(screen.getByText('发送'));
    await waitFor(() => expect(screen.getByText(/分析中/)).toBeInTheDocument());
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => String(c[0]).includes('/api/agent/chat'),
    );
    const body = JSON.parse(String(calls.at(-1)![1]?.body)) as { sessionId?: string };
    expect(body.sessionId).toBe('s9');
  });

  it('重命名/删除会话（确认后）', async () => {
    SESSIONS = [{ id: 's1', title: '旧名', createdAt: 1, updatedAt: 2 }];
    ACTIVE = 's1';
    vi.spyOn(window, 'prompt').mockReturnValue('新名字');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AgentPanel chips={[]} onChipsChange={() => {}} onSend={() => []} />);
    await waitFor(() => expect(screen.getByTestId('agent-session-current')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('agent-session-current'));
    fireEvent.click(screen.getByTestId('agent-session-rename-s1'));
    await waitFor(() => expect(screen.getByText('新名字')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('agent-session-current'));
    fireEvent.click(screen.getByTestId('agent-session-del-s1'));
    await waitFor(() => expect(screen.queryByText('新名字')).not.toBeInTheDocument());
    vi.restoreAllMocks();
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/panels/agent.test.tsx`（工作目录 `web/`）
Expected: 新用例 FAIL（无会话条）。

- [ ] **Step 3: 实现**

`web/src/types.ts` 增加：

```ts
// 会话元数据（镜像后端 src/sessions/store.ts）
export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}
```

`web/src/api/client.ts` 增加（放在 listChatHistory 附近）：

```ts
  // —— AGENT 会话（多会话 CRUD；全部返回列表 + activeId）——
  async listAgentSessions(): Promise<{ sessions: SessionMeta[]; activeId: string | null }> {
    const r = await req<{ sessions: SessionMeta[]; activeId: string | null }>('/api/agent/sessions');
    return r;
  },
  async createAgentSession(): Promise<{ sessions: SessionMeta[]; activeId: string | null }> {
    const r = await req<{ sessions: SessionMeta[]; activeId: string | null }>('/api/agent/sessions', {
      method: 'POST', body: JSON.stringify({}),
    });
    return r;
  },
  async renameAgentSession(id: string, title: string): Promise<{ sessions: SessionMeta[]; activeId: string | null }> {
    const r = await req<{ sessions: SessionMeta[]; activeId: string | null }>(`/api/agent/sessions/${id}`, {
      method: 'PATCH', body: JSON.stringify({ title }),
    });
    return r;
  },
  async deleteAgentSession(id: string): Promise<{ sessions: SessionMeta[]; activeId: string | null }> {
    const r = await req<{ sessions: SessionMeta[]; activeId: string | null }>(`/api/agent/sessions/${id}`, {
      method: 'DELETE', body: JSON.stringify({}),
    });
    return r;
  },
```

`listChatHistory` 改签名（加 sessionId）：

```ts
  async listChatHistory(sessionId?: string | null): Promise<Array<{ who: 'user' | 'agent'; text: string; at: number }>> {
    const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
    const r = await req<{ messages: Array<{ who: 'user' | 'agent'; text: string; at: number }> }>(`/api/agent/history${q}`);
    return r.messages;
  },
```

`web/src/api/agent.ts` `agentChat` 加参（查看该文件现有签名后追加 `sessionId?: string | null`，body 带 `sessionId: sessionId ?? undefined`）。

`web/src/App.tsx` `handleAgentSend` 签名加可选第三参（与 AgentPanel 新 onSend 类型对齐）：

```tsx
  const handleAgentSend = (text: string, _chipRefs: string[], _sessionId?: string | null): ChatMsg[] => [
    { who: 'user', text },
    { who: 'agent', text: '（正在请求 pi…）' },
  ];
```

`web/src/App.tsx` `handleAgentStream` 透传：

```tsx
  const handleAgentStream = useCallback((text: string, chipRefs: string[], push: (chunk: string) => void, sessionId?: string | null) => {
    ...
    void agentChat(text, payload, push, agentModel || undefined, thinkingLevel || undefined, sessionId)
      .catch(() => push('\n（agent 连接失败）'));
  }, [agentModel, thinkingLevel]);
```

`web/src/panels/AgentPanel.tsx`：新增会话 state 与 UI。

(a) props 增加：`onSend` / `onStream` 签名加可选 `sessionId?: string | null`（App 侧已同步）。

```tsx
  onSend: (text: string, chips: string[], sessionId?: string | null) => ChatMsg[];
  onStream?: (text: string, chips: string[], push: (chunk: string) => void, sessionId?: string | null) => void;
```

(b) state 与加载：

```tsx
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pickOpen, setPickOpen] = useState(false);
```

historyKey effect 改为：清空 → `listAgentSessions()` → 无会话则 `createAgentSession()`（返回新列表）→ setSessions/setActiveId → `listChatHistory(activeId)` 加载消息。发送时若 activeId 为 null（加载失败兜底）→ 先 create。

(c) 会话条 JSX（放在消息区之上、模型栏之下，紧邻 msgs 上方）：

```tsx
      <div className="agent-sessions">
        <button
          type="button" className="btn-ghost agent-session-new" data-testid="agent-session-new"
          title="新建会话" onClick={() => { void newSession(); }}
        >＋ 新建</button>
        <div className="agent-session-pick">
          <button
            type="button" className="agent-session-current" data-testid="agent-session-current"
            onClick={() => setPickOpen((o) => !o)}
          >会话：{currentTitle}</button>
          {pickOpen && (
            <>
              <div className="agent-session-menu" data-testid="agent-session-menu">
                {sessions.map((s) => (
                  <div key={s.id} className={`agent-session-item${s.id === activeId ? ' active' : ''}`}>
                    <button type="button" className="agent-session-select" onClick={() => { selectSession(s.id); setPickOpen(false); }}>
                      <span className="agent-session-title">{s.title}</span>
                      <span className="agent-session-date">{fmtSessionDate(s.updatedAt)}</span>
                    </button>
                    <button type="button" className="agent-session-act" data-testid={`agent-session-rename-${s.id}`}
                      title="重命名" onClick={() => { void renameSession(s); }}>✎</button>
                    <button type="button" className="agent-session-act" data-testid={`agent-session-del-${s.id}`}
                      title="删除" onClick={() => { void deleteSession(s); }}>🗑</button>
                  </div>
                ))}
                {sessions.length === 0 && <div className="agent-session-empty">暂无会话</div>}
              </div>
              <div className="agent-session-mask" onClick={() => setPickOpen(false)} />
            </>
          )}
        </div>
      </div>
```

(d) 逻辑函数：

```tsx
  const currentTitle = sessions.find((s) => s.id === activeId)?.title ?? '新会话';

  const newSession = async () => {
    const r = await client.createAgentSession().catch(() => null);
    if (!r) return;
    setSessions(r.sessions);
    setActiveId(r.activeId);
    setPickOpen(false);
    dirtyRef.current = false;
    setMsgs([]);
  };

  const selectSession = (id: string) => {
    if (id === activeId) return;
    setActiveId(id);
    dirtyRef.current = false;
    setMsgs([]);
    void client.listChatHistory(id).then((history) => {
      setMsgs(history.map((h) => ({ who: h.who, text: h.text })));
    }).catch(() => {});
  };

  const renameSession = async (s: SessionMeta) => {
    const title = window.prompt('会话标题', s.title);
    if (!title || title.trim() === '' || title === s.title) return;
    const r = await client.renameAgentSession(s.id, title.trim()).catch(() => null);
    if (r) setSessions(r.sessions);
  };

  const deleteSession = async (s: SessionMeta) => {
    if (!window.confirm(`删除会话「${s.title}」？其消息将一并删除。`)) return;
    const r = await client.deleteAgentSession(s.id).catch(() => null);
    if (!r) return;
    setSessions(r.sessions);
    setActiveId(r.activeId);
    setPickOpen(false);
    dirtyRef.current = false;
    setMsgs([]);
    if (r.activeId) {
      void client.listChatHistory(r.activeId).then((history) => {
        setMsgs(history.map((h) => ({ who: h.who, text: h.text })));
      }).catch(() => {});
    }
  };
```

(e) 发送携带 sessionId：

```tsx
  const send = () => {
    ...
    setMsgs((m) => [...m, ...props.onSend(text, props.chips, activeId)]);
    props.onStream?.(text, props.chips, (chunk) => {...}, activeId);
  };
```

(f) historyKey effect 改写（加载会话 + 自动新建 + 加载消息）：

```tsx
  useEffect(() => {
    dirtyRef.current = false;
    setMsgs([]);
    setPickOpen(false);
    let disposed = false;
    const load = async () => {
      try {
        let r = await client.listAgentSessions();
        if (!r.activeId) r = await client.createAgentSession();
        if (disposed) return;
        setSessions(r.sessions);
        setActiveId(r.activeId);
        if (r.activeId) {
          const history = await client.listChatHistory(r.activeId);
          if (!disposed && !dirtyRef.current) {
            setMsgs(history.map((h) => ({ who: h.who, text: h.text })));
          }
        }
      } catch { /* 加载失败静默：发送时兜底自动建会话 */ }
    };
    void load();
    return () => { disposed = true; };
  }, [props.historyKey]);
```

`web/src/App.css` 追加：

```css
/* ===== AGENT 面板：会话条（多会话下拉） ===== */
.agent-sessions { display: flex; align-items: center; gap: 8px; padding: 0 9px; }
.agent-session-new { font-size: 12px; padding: 3px 10px; white-space: nowrap; }
.agent-session-pick { position: relative; flex: 1; min-width: 0; }
.agent-session-current {
  width: 100%; text-align: left; font-size: 12px; color: var(--text-dim);
  background: var(--panel-2); border: 1px solid var(--border-2); border-radius: 6px;
  padding: 4px 10px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.agent-session-current:hover { color: var(--text); border-color: var(--text-dim); }
.agent-session-menu {
  position: absolute; z-index: 20; top: calc(100% + 4px); left: 0; right: 0;
  background: var(--panel-2); border: 1px solid var(--border-2); border-radius: 8px;
  max-height: 240px; overflow: auto; padding: 4px; display: flex; flex-direction: column; gap: 2px;
}
.agent-session-item { display: flex; align-items: center; gap: 4px; border-radius: 6px; padding: 3px 6px; }
.agent-session-item:hover { background: var(--panel-3); }
.agent-session-item.active { background: var(--amber-dim); }
.agent-session-select { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 1px; background: none; border: none; cursor: pointer; text-align: left; }
.agent-session-title { font-size: 12px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.agent-session-date { font-family: var(--mono); font-size: 9px; color: var(--text-faint); }
.agent-session-act { background: none; border: none; cursor: pointer; font-size: 11px; color: var(--text-faint); padding: 2px 4px; }
.agent-session-act:hover { color: var(--amber); }
.agent-session-empty { font-size: 11px; color: var(--text-faint); padding: 8px; text-align: center; }
.agent-session-mask { position: fixed; inset: 0; z-index: 19; }
```

`fmtSessionDate` 工具（放 AgentPanel 文件内）：

```tsx
function fmtSessionDate(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/panels/agent.test.tsx`（工作目录 `web/`）
Expected: 全部 PASS（含既有 + 新 4 用例）。再 `pnpm exec vitest run`（`web/` 全量）+ `pnpm exec tsc -b`。

- [ ] **Step 5: 提交**

```bash
git add web/src/types.ts web/src/api/client.ts web/src/api/agent.ts web/src/App.tsx web/src/panels/AgentPanel.tsx web/src/panels/agent.test.tsx web/src/App.css
git commit -m "feat(web): AGENT 面板多会话（会话条下拉：新建/点选/重命名/删除）"
```

---

### Task 4: StoryChat 会话列表面板

**Files:**
- Modify: `web/src/api/client.ts`（story 会话方法 + getStoryChatHistory(sessionId) + storyChat 加 sessionId）、`web/src/views/StoryChat.tsx`、`web/src/views/StoryChat.test.tsx`、`web/src/App.css`

**Interfaces:**
- Consumes: Task 2 故事会话端点；Task 3 的 client 模式。
- Produces: `StoryChat` 左侧会话列表面板（新建/点选/重命名/删除）+ 全部请求携带 sessionId。

- [ ] **Step 1: 写失败测试**

`web/src/views/StoryChat.test.tsx`：改造 beforeEach mock 为 URL 感知（sessions/history 返回 JSON；story/chat POST 返回 SSE；注意 URL 匹配顺序：`/api/story/chat/sessions` 必须先于 `/api/story/chat/history` 与 `/api/story/chat`）并追加用例：

```tsx
let SESSIONS: Array<{ id: string; title: string; createdAt: number; updatedAt: number }> = [];
let ACTIVE: string | null = null;
let HISTORY: Array<{ who: string; text: string; at: number }> = [];
let CHAT_BODIES: Array<{ message: string; sessionId?: string }> = [];

beforeEach(() => {
  SESSIONS = []; ACTIVE = null; HISTORY = []; CHAT_BODIES = [];
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (u.includes('/api/story/chat/sessions')) {
      if (method === 'POST') {
        const id = `s${SESSIONS.length + 1}`;
        SESSIONS = [...SESSIONS, { id, title: '新会话', createdAt: 1, updatedAt: 1 }];
        ACTIVE = id; HISTORY = [];
      } else if (method === 'PATCH') {
        const id = u.split('/').pop();
        const body = JSON.parse(String(init?.body)) as { title: string };
        SESSIONS = SESSIONS.map((s) => (s.id === id ? { ...s, title: body.title } : s));
      } else if (method === 'DELETE') {
        const id = u.split('/').pop();
        SESSIONS = SESSIONS.filter((s) => s.id !== id);
        ACTIVE = SESSIONS[0]?.id ?? null; HISTORY = [];
      }
      return new Response(JSON.stringify({ sessions: SESSIONS, activeId: ACTIVE }), { status: 200 });
    }
    if (u.includes('/api/story/chat/history')) {
      return new Response(JSON.stringify({ messages: HISTORY }), { status: 200 });
    }
    if (u.includes('/api/story/chat')) {
      if (method === 'POST') {
        CHAT_BODIES = [...CHAT_BODIES, JSON.parse(String(init?.body)) as { message: string; sessionId?: string }];
        return new Response(
          'data: {"chunk":"精灵骑士"}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());
```

> 既有用例在新 mock 下行为等价：HISTORY 初始为空数组 → 原「加载历史并渲染消息」用例需把模块级 `HISTORY` 预置为该用例的历史内容（文件顶部旧的 `const HISTORY = { messages: [...] }` 与新的模块级 `let HISTORY` 命名冲突——删除旧常量，改在该用例内 `HISTORY = [...]` 后 render）。既有总结/回填用例断言不变（send 均走 POST）。

追加用例：

```tsx
  it('会话面板：无会话自动新建；列表显示会话标题', async () => {
    render(<StoryChat projectName="demo" onBackfill={() => {}} onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('session-item-s1')).toBeInTheDocument());
    expect(screen.getByTestId('session-item-s1')).toHaveTextContent('新会话');
  });

  it('点选历史会话：加载该会话消息', async () => {
    SESSIONS = [
      { id: 'sa', title: '会话甲', createdAt: 1, updatedAt: 2 },
      { id: 'sb', title: '会话乙', createdAt: 3, updatedAt: 4 },
    ];
    ACTIVE = 'sa';
    HISTORY = [{ who: 'agent', text: '甲的历史', at: 2 }];
    render(<StoryChat projectName="demo" onBackfill={() => {}} onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('甲的历史')).toBeInTheDocument());
    // 切到 sb
    SESSIONS = [
      { id: 'sa', title: '会话甲', createdAt: 1, updatedAt: 2 },
      { id: 'sb', title: '会话乙', createdAt: 3, updatedAt: 4 },
    ];
    ACTIVE = 'sb';
    HISTORY = [{ who: 'user', text: '乙的消息', at: 4 }];
    fireEvent.click(screen.getByText('会话乙'));
    await waitFor(() => expect(screen.getByText('乙的消息')).toBeInTheDocument());
    expect(screen.queryByText('甲的历史')).not.toBeInTheDocument();
  });

  it('发送/总结成稿携带当前 sessionId', async () => {
    SESSIONS = [{ id: 's9', title: '当前', createdAt: 1, updatedAt: 1 }];
    ACTIVE = 's9';
    render(<StoryChat projectName="demo" onBackfill={() => {}} onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('session-item-s9')).toBeInTheDocument());
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: '主角是谁？' } });
    fireEvent.click(screen.getByText('发送'));
    await waitFor(() => expect(CHAT_BODIES.length).toBeGreaterThan(0));
    expect(CHAT_BODIES[0]!.sessionId).toBe('s9');
    fireEvent.click(screen.getByText('✨ 总结成稿'));
    await waitFor(() => expect(CHAT_BODIES.length).toBeGreaterThan(1));
    expect(CHAT_BODIES.at(-1)!.sessionId).toBe('s9');
  });

  it('重命名/删除会话（确认后）', async () => {
    SESSIONS = [{ id: 's1', title: '旧名', createdAt: 1, updatedAt: 2 }];
    ACTIVE = 's1';
    vi.spyOn(window, 'prompt').mockReturnValue('新名字');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<StoryChat projectName="demo" onBackfill={() => {}} onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('旧名')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('session-rename-s1'));
    await waitFor(() => expect(screen.getByText('新名字')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('session-del-s1'));
    await waitFor(() => expect(screen.queryByText('新名字')).not.toBeInTheDocument());
    vi.restoreAllMocks();
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/views/StoryChat.test.tsx`（工作目录 `web/`）
Expected: 新用例 FAIL（无会话面板）。

- [ ] **Step 3: 实现**

`web/src/api/client.ts` 增加（story 会话方法 + 签名扩展）：

```ts
  // —— 故事对话式会话（多会话 CRUD）——
  async listStorySessions(): Promise<{ sessions: SessionMeta[]; activeId: string | null }> {
    const r = await req<{ sessions: SessionMeta[]; activeId: string | null }>('/api/story/chat/sessions');
    return r;
  },
  async createStorySession(): Promise<{ sessions: SessionMeta[]; activeId: string | null }> {
    const r = await req<{ sessions: SessionMeta[]; activeId: string | null }>('/api/story/chat/sessions', {
      method: 'POST', body: JSON.stringify({}),
    });
    return r;
  },
  async renameStorySession(id: string, title: string): Promise<{ sessions: SessionMeta[]; activeId: string | null }> {
    const r = await req<{ sessions: SessionMeta[]; activeId: string | null }>(`/api/story/chat/sessions/${id}`, {
      method: 'PATCH', body: JSON.stringify({ title }),
    });
    return r;
  },
  async deleteStorySession(id: string): Promise<{ sessions: SessionMeta[]; activeId: string | null }> {
    const r = await req<{ sessions: SessionMeta[]; activeId: string | null }>(`/api/story/chat/sessions/${id}`, {
      method: 'DELETE', body: JSON.stringify({}),
    });
    return r;
  },
```

`getStoryChatHistory` 加 sessionId；`storyChat` 加 sessionId（body 携带；现有第 5 参 persistAs 保持，sessionId 放第 6 参）：

```ts
  async getStoryChatHistory(sessionId?: string | null): Promise<Array<{ who: 'user' | 'agent'; text: string; at: number }>> {
    const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
    const r = await req<{ messages: Array<{ who: 'user' | 'agent'; text: string; at: number }> }>(`/api/story/chat/history${q}`);
    return r.messages;
  },

  async storyChat(
    message: string,
    onChunk: (chunk: string) => void,
    model?: string,
    thinking?: string,
    persistAs?: string,
    sessionId?: string | null,
  ): Promise<void> {
    const res = await fetch('/api/story/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, model, thinking, persistAs, sessionId: sessionId ?? undefined }),
    });
    ...（其余不变）
```

`web/src/views/StoryChat.tsx`：
- state：`sessions` / `activeId`；加载 effect 改造（list → 无则 create → load history）；`appendStream`/`send`/`runAction` 携带 activeId；新增面板 JSX 与 `newSession/selectSession/renameSession/deleteSession`（同 Task 3 模式，testid 用 `session-item-${id}` / `session-rename-${id}` / `session-del-${id}`）。
- 布局：`.chat-wrap` 内加左面板：

```tsx
  return (
    <div className="chat-wrap">
      <div className="session-panel" data-testid="session-panel">
        <button type="button" className="btn-ghost session-new" data-testid="session-new" onClick={() => { void newSession(); }}>＋ 新建会话</button>
        <div className="session-list">
          {sessions.map((s) => (
            <div key={s.id} className={`session-item${s.id === activeId ? ' active' : ''}`} data-testid={`session-item-${s.id}`}>
              <button type="button" className="session-select" onClick={() => selectSession(s.id)}>
                <span className="session-title">{s.title}</span>
                <span className="session-date">{fmtSessionDate(s.updatedAt)}</span>
              </button>
              <div className="session-acts">
                <button type="button" className="session-act" data-testid={`session-rename-${s.id}`} title="重命名"
                  onClick={() => { void renameSession(s); }}>✎</button>
                <button type="button" className="session-act" data-testid={`session-del-${s.id}`} title="删除"
                  onClick={() => { void deleteSession(s); }}>🗑</button>
              </div>
            </div>
          ))}
          {sessions.length === 0 && <div className="session-empty">暂无会话</div>}
        </div>
      </div>
      <div className="chat-main">
        {props.completedAt && (
          <div className="story-banner">✅ 已完成 · 已生成故事文档进素材库</div>
        )}
        <div className="chat-msgs">...</div>
        <div className="chat-input-row">...</div>
        <div className="chat-actions">...</div>
        {error && <ErrorBanner text={error} />}
      </div>
    </div>
  );
```

- busy 期间禁止切会话/新建（`if (busy) return;` 于 newSession/selectSession 开头）。
- `fmtSessionDate` 同 Task 3（放 StoryChat 文件内）。

`web/src/App.css` 追加：

```css
/* ===== 故事对话式：会话列表面板 ===== */
.chat-wrap { flex-direction: row; }  /* 覆盖原 column：左面板 + 聊天主区 */
.session-panel {
  flex: 0 0 150px; display: flex; flex-direction: column; gap: 8px; min-height: 0;
  background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 10px;
}
.session-new { font-size: 12px; }
.session-list { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 4px; }
.session-item { display: flex; align-items: center; gap: 4px; border-radius: 6px; padding: 5px 8px; cursor: pointer; }
.session-item:hover { background: var(--panel-3); }
.session-item.active { background: var(--amber-dim); border: 1px solid rgba(232, 163, 61, .35); }
.session-select { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 1px; background: none; border: none; cursor: pointer; text-align: left; }
.session-title { font-size: 12px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.session-date { font-family: var(--mono); font-size: 9px; color: var(--text-faint); }
.session-acts { display: none; gap: 2px; }
.session-item:hover .session-acts { display: flex; }
.session-act { background: none; border: none; cursor: pointer; font-size: 11px; color: var(--text-faint); padding: 2px 4px; }
.session-act:hover { color: var(--amber); }
.session-empty { font-size: 11px; color: var(--text-faint); text-align: center; padding: 10px 0; }
.chat-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 12px; min-height: 0; }
```

> 注意：`.chat-wrap` 原为 `flex-direction: column`（642 行），改为 row 后 StoryChat 全部内容包进 `.chat-main`（column）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/views/StoryChat.test.tsx`（工作目录 `web/`）
Expected: 全部 PASS。再全量：`pnpm exec vitest run`（`web/`）+ `pnpm exec tsc -b`（`web/`）+ `pnpm test`（仓库根）。

- [ ] **Step 5: 提交**

```bash
git add web/src/api/client.ts web/src/views/StoryChat.tsx web/src/views/StoryChat.test.tsx web/src/App.css
git commit -m "feat(web): 故事对话式多会话（左侧会话列表：新建/点选/重命名/删除）"
```

---

## 验收（对照 spec）

1. AGENT 面板与会话列表 / StoryChat 左侧列表 —— Task 3/4 用例。
2. 新建/点选查看并继续/重命名/删除（确认）—— Task 3/4 用例。
3. 按项目隔离、刷新重启不丢、旧单线迁移为「会话 1」—— Task 1 迁移用例 + Task 2 封装用例。
4. 发送落入当前会话；故事总结/回填上下文 = 当前会话—— Task 2 作用域用例 + Task 3/4 sessionId 用例。
5. 全量回归不破——各任务 Step 4。
