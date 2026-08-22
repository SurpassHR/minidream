# TaskQueue 接管 ComfyUI 与活动监控 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让项目 `TaskQueue` 成为唯一生成任务管理器，并提供跨会话的活动监控与终止能力。

**Architecture:** `TaskQueue` 负责所有 ComfyUI 执行生命周期，包含上传、提交、进度、取消和结果收集。新增内存活动会话注册表管理 Agent 子进程，任务通过 `sessionId` 关联；旧 `jobs.ts` 仅保留兼容映射，不再启动独立执行。

**Tech Stack:** Node.js, Express, TypeScript, Vitest, React, Vite, SSE, ComfyUI HTTP/WebSocket API。

**Spec:** `docs/superpowers/specs/2026-08-22-taskqueue-owns-comfyui-activity-monitor-design.md`

## Global Constraints

- `TaskQueue` 是生成任务唯一事实源；ComfyUI 仅作为执行后端。
- GPU 任务并发严格为 1。
- 任务和会话文件持久化必须使用 `.tmp + renameSync` 原子写入。
- 服务端和前端用户可见文案使用简体中文。
- 终止会话必须同时终止 Agent 与该会话未完成的生成任务。
- 不引入数据库或第三方依赖。

---

### Task 1: 强化 TaskQueue 的统一执行与取消能力

**Files:**
- Modify: `server/src/tasks/types.ts`
- Modify: `server/src/tasks/queue.ts`
- Test: `server/src/tasks/queue.test.ts`

**Interfaces:**
- `TaskSubmitInput` 支持 `sessionId?: string` 与 `images?: string[]`，保留现有字段。
- `TaskQueue.cancelBySession(sessionId: string): TaskItem[]` 取消该会话全部 `queued/running` 任务。
- `TaskQueue.subscribeTask` 同时接收 `task:change` 和 `task:progress`。

- [ ] **Step 1: 写运行中取消、批量取消和进度订阅失败测试**

```ts
it('运行中任务被取消后 executor 返回也不会恢复为 completed', async () => {
  let release!: () => void;
  const executorStarted = new Promise<void>(resolve => {
    // executor 内 resolve started，再等待 release
  });
  // submit sessionId 任务，等待 running，调用 cancel，release，断言最终 canceled
});

it('按 sessionId 批量取消排队和运行任务', () => {
  const canceled = queue.cancelBySession('session-1');
  expect(canceled.every(t => t.status === 'canceled')).toBe(true);
});

it('subscribeTask 能收到进度更新', () => {
  // executor 调用 onProgress，断言订阅回调收到 updated 事件
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter server exec vitest run src/tasks/queue.test.ts`

Expected: 新增断言因 `cancelBySession` 或进度监听缺失而失败。

- [ ] **Step 3: 实现最小 TaskQueue 改动**

在 `queue.ts` 中：

1. 将 `cancel()` 的终止状态更新集中到 `cancelTaskInternal()`，确保 queued/running 都只发出一次 `canceled` 事件；
2. 让 `subscribeTask()` 同时监听 `task:change` 和 `task:progress`，并在取消后移除对应监听；
3. 增加 `cancelBySession()`，按任务快照依次取消；
4. 在 `finally` 清理当前 abort controller 和 ComfyUI prompt id；
5. executor 返回后继续检查任务是否已 canceled，禁止完成覆盖取消。

- [ ] **Step 4: 运行 TaskQueue 测试**

Run: `pnpm --filter server exec vitest run src/tasks/queue.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/src/tasks/types.ts server/src/tasks/queue.ts server/src/tasks/queue.test.ts
git commit -m "feat(tasks): 统一任务取消与会话关联"
```

---

### Task 2: Agent Bridge 与活动会话注册表

**Files:**
- Modify: `server/src/agent/bridge.ts`
- Create: `server/src/activity.ts`
- Test: `server/src/agent/bridge.test.ts`
- Create: `server/src/activity.test.ts`

**Interfaces:**

```ts
export interface ActiveSession {
  sessionId: string;
  message: string;
  startedAt: number;
  taskIds: string[];
  status: 'running' | 'canceled' | 'completed' | 'failed';
}

export interface ActivityRegistry {
  startSession(sessionId: string, message: string, controller: AbortController): ActiveSession;
  attachTask(sessionId: string, taskId: string): void;
  finishSession(sessionId: string, status: ActiveSession['status']): void;
  getSnapshot(): { sessions: ActiveSession[]; tasks: TaskItem[] };
  subscribe(listener: (event: ActivityEvent) => void): () => void;
}
```

- [ ] **Step 1: 写 Agent abort 与活动注册失败测试**

使用可注入 `spawn` 或最小子进程 fixture 验证 `AbortSignal` 调用后子进程收到 `SIGTERM`，`end` 事件只发一次；验证 registry 能登记、绑定任务、结束会话并广播。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter server exec vitest run src/agent/bridge.test.ts src/activity.test.ts`

Expected: 新增 API 尚未实现而失败。

- [ ] **Step 3: 实现最小代码**

在 bridge 中统一处理 abort、close、error 的一次性 finalize，并清理临时 MCP 配置文件；新增 `activity.ts` 管理内存活动会话、事件订阅和 TaskQueue 快照过滤。

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter server exec vitest run src/agent/bridge.test.ts src/activity.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/src/agent/bridge.ts server/src/activity.ts server/src/agent/bridge.test.ts server/src/activity.test.ts
git commit -m "feat(activity): 登记活动会话并支持 Agent 终止"
```

---

### Task 3: 将 API、MCP 和聊天流统一接入 TaskQueue

**Files:**
- Modify: `server/src/mcp/server.ts`
- Modify: `server/src/index.ts`
- Modify: `server/src/jobs.ts`
- Test: `server/src/api.test.ts`
- Test: `server/src/mcp/server.test.ts`

**Interfaces:**

```ts
GET  /api/activity
GET  /api/activity/events
POST /api/sessions/:id/cancel
```

- [ ] **Step 1: 写 API 失败测试**

测试活动快照包含关联的 active session 和 queued/running tasks；测试会话终止返回成功并将关联任务变为 `canceled`；测试活动 SSE 收到终止事件。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter server exec vitest run src/api.test.ts src/mcp/server.test.ts`

Expected: 新端点返回 404 或断言失败。

- [ ] **Step 3: 实现 API 与聊天接线**

1. 创建全局 `ActivityRegistry` 并将 `TaskQueue` 注入；
2. `/api/chat` 流式分支登记会话，创建 `AbortController` 传给 `runAgentStream`；
3. 从 `generation.submit` 结果解析 `taskId` 后调用 `attachTask(sid, taskId)`；
4. 请求 close 仅在客户端确实断开且 Agent 仍运行时 abort，并取消关联 TaskQueue 任务；
5. `cleanupAndEnd()` 保存带 `stages: [{ type: 'error', logs: ['对话已终止'] }]` 的助手消息，并只发送一次 `agent:end`；
6. 新增活动快照和 SSE 端点；SSE 事件由 Registry 与 TaskQueue 事件桥接产生；
7. `jobs.ts` 改为任务适配或让旧接口直接操作 TaskQueue，禁止再调用独立 `startJob()` 执行。

- [ ] **Step 4: 运行服务端测试**

Run: `pnpm --filter server test`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/src/index.ts server/src/mcp/server.ts server/src/jobs.ts server/src/api.test.ts server/src/mcp/server.test.ts
 git commit -m "feat(server): 将聊天生成与活动监控统一到 TaskQueue"
```

---

### Task 4: 前端活动面板与终止控制

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/Rail.tsx`
- Create: `web/src/components/ActivityPanel.tsx`
- Modify: `web/src/App.css`

**Interfaces:**

```ts
interface ActivitySnapshot {
  sessions: ActiveSession[];
  tasks: TaskItem[];
}

fetchActivity(): Promise<ActivitySnapshot>;
streamActivity(onEvent): () => void;
cancelSession(id: string): Promise<void>;
```

- [ ] **Step 1: 写前端类型与控制接线**

增加活动类型、快照接口、SSE 解析和终止 API；面板支持 session/task 两类列表与按钮状态。

- [ ] **Step 2: 实现面板**

在 `ActivityPanel.tsx` 使用现有按钮和 CSS 变量，展示运行中会话、任务状态、进度和终止按钮；不新增依赖。

- [ ] **Step 3: 接入 App**

顶部显示“运行中”数量；打开面板时加载快照并建立 SSE，关闭时释放连接；终止会话后刷新当前消息和列表。

- [ ] **Step 4: 运行前端构建**

Run: `pnpm --filter web build`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add web/src/api.ts web/src/App.tsx web/src/components/Rail.tsx web/src/components/ActivityPanel.tsx web/src/App.css
git commit -m "feat(web): 增加运行中会话与任务监控"
```

---

### Task 5: 全量验证与回归修复

**Files:**
- Modify: files identified by failing tests only.

- [ ] **Step 1: 运行服务端完整测试**

Run: `pnpm --filter server test`

- [ ] **Step 2: 运行前端类型检查和构建**

Run: `pnpm --filter web build`

- [ ] **Step 3: 检查任务单一来源**

Run: `rg "startJob|submitPrompt\(" server/src/index.ts server/src/jobs.ts server/src/tasks`

Expected: 普通生成路径只由 `TaskQueue` 调用 `submitPrompt`；旧 jobs 模块不再创建第二份任务状态。

- [ ] **Step 4: 修复失败并重复验证**

仅修改与本功能直接相关的文件，保持 `server/data/settings.json` 配置恢复和原子写入行为不变。

- [ ] **Step 5: Commit**

```bash
git add server/src web/src docs/superpowers/specs docs/superpowers/plans
git commit -m "test: 验证统一任务队列与活动终止闭环"
```
