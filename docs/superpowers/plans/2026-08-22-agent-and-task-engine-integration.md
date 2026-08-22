# Pi Agent & TaskQueue Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Pi Agent 深度接入工作台对话流，作为多模态导演大脑；基于全局统一任务队列（TaskQueue）与专用 Director MCP Server 实现全自动与半自动的生图/生视频调度与 ChatGPT 级流式回显。

**Architecture:** 
1. **统一任务队列层 (`TaskQueue`)**：负责任务单 worker 串行调度、显存保护、原子文件持久化 (`tasks.json`) 与 ComfyUI WS 事件转换。
2. **Director MCP Server (`server/src/mcp/`)**：通过 JSON-RPC 暴露 `workflow.list`、`generation.submit`、`generation.status`、`generation.cancel` 4 个核心工具。
3. **Agent Bridge (`server/src/agent/bridge.ts`)**：管理 Pi CLI 子进程与 NDJSON 流式解析，将 Thought、Tool Call 与生成进度无缝拼装为 SSE 帧。
4. **前端流式界面 (`web/src/components/ChatView.tsx`)**：呈现思维链折叠、正文打字机、实时渲染进度条与多模态产物卡片。

**Tech Stack:** Node.js, Express, TypeScript, Vitest, Pi Agent CLI, Model Context Protocol (MCP), React, SSE (Server-Sent Events), ComfyUI API & WebSocket.

**Spec:** `docs/superpowers/specs/2026-08-22-agent-and-task-engine-integration-design.md`

## Global Constraints

- **Language:** All user-facing text, prompt explanations, UI labels, and comments MUST be in Simplified Chinese (简体中文).
- **Concurrency:** GPU task queue concurrency MUST be strictly 1 to avoid VRAM OOM.
- **Persistence:** Task queue and session history MUST use atomic write (`.tmp` + `renameSync`).
- **Compatibility:** Keep existing settings persistence (`server/data/settings.json`) intact.

---

### Task 1: 建立全局统一任务管理引擎 (TaskQueue)

**Files:**
- Create: `server/src/tasks/types.ts`
- Create: `server/src/tasks/queue.ts`
- Test: `server/src/tasks/queue.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class TaskQueue {
    constructor(dataFile: string);
    submit(item: Omit<TaskItem, 'id' | 'status' | 'stages' | 'createdAt' | 'updatedAt'>): TaskItem;
    get(id: string): TaskItem | undefined;
    list(): TaskItem[];
    cancel(id: string): boolean;
    on(event: 'task:change' | 'task:progress', listener: (task: TaskItem) => void): this;
  }
  ```

- [ ] **Step 1: 编写 TaskQueue 的失败测试**
  在 `server/src/tasks/queue.test.ts` 中测试任务提交、串行排队调度、任务取消与 `tasks.json` 原子落盘。

- [ ] **Step 2: 运行测试验证失败**
  `pnpm --filter server exec vitest run src/tasks/queue.test.ts`
  预期：FAIL（找不到模块）。

- [ ] **Step 3: 实现 Task 数据类型与 TaskQueue 调度器**
  创建 `server/src/tasks/types.ts` 与 `server/src/tasks/queue.ts`，实现单 worker 串行执行、ComfyUI 自省与 Prompt 组装对接、WebSocket 采样进度追踪与持久化恢复。

- [ ] **Step 4: 运行测试验证通过**
  `pnpm --filter server exec vitest run src/tasks/queue.test.ts`
  预期：PASS。

- [ ] **Step 5: Commit**
  `git commit -m "feat(tasks): 实现全局统一任务队列 TaskQueue 与串行调度"`

---

### Task 2: 实现 Director MCP Server 协议端点

**Files:**
- Create: `server/src/mcp/types.ts`
- Create: `server/src/mcp/server.ts`
- Test: `server/src/mcp/server.test.ts`

**Interfaces:**
- Consumes: `TaskQueue` from `server/src/tasks/queue.ts`, `buildSpecsCached` from `server/src/workflow.ts`
- Produces:
  ```ts
  export interface McpServerOptions {
    port?: number;
    taskQueue: TaskQueue;
  }
  export function createMcpServer(options: McpServerOptions): {
    start(): Promise<{ port: number; url: string }>;
    close(): Promise<void>;
  };
  ```

- [ ] **Step 1: 编写 MCP Server 的失败测试**
  在 `server/src/mcp/server.test.ts` 中测试通过 JSON-RPC 调用 `workflow.list`、`generation.submit`、`generation.status` 和 `generation.cancel` 工具。

- [ ] **Step 2: 运行测试验证失败**
  `pnpm --filter server exec vitest run src/mcp/server.test.ts`
  预期：FAIL。

- [ ] **Step 3: 实现 Director MCP Server**
  在 `server/src/mcp/server.ts` 中搭建轻量 HTTP JSON-RPC 服务，注册 4 个核心 MCP 工具，与 `TaskQueue` 及工作流模板对接。

- [ ] **Step 4: 运行测试验证通过**
  `pnpm --filter server exec vitest run src/mcp/server.test.ts`
  预期：PASS。

- [ ] **Step 5: Commit**
  `git commit -m "feat(mcp): 实现 Director 专用 MCP Server 核心工具集"`

---

### Task 3: 实现 Pi Agent 子进程调度与流式 Bridge

**Files:**
- Create: `server/src/agent/types.ts`
- Create: `server/src/agent/bridge.ts`
- Create: `.pi/skills/director-copilot/SKILL.md`
- Test: `server/src/agent/bridge.test.ts`

**Interfaces:**
- Consumes: `createMcpServer` from `server/src/mcp/server.ts`
- Produces:
  ```ts
  export interface AgentStreamEvent {
    type: 'thinking' | 'text' | 'tool_call' | 'tool_result' | 'action_card' | 'task_queued' | 'task_progress' | 'task_artifact' | 'end' | 'error';
    payload: Record<string, unknown>;
  }
  export function streamAgentChat(
    message: string,
    options: {
      sessionId: string;
      images?: string[];
      mcpUrl: string;
      onEvent: (event: AgentStreamEvent) => void;
    }
  ): Promise<void>;
  ```

- [ ] **Step 1: 编写导演 Skill 规则文件**
  创建 `.pi/skills/director-copilot/SKILL.md`，注入 Krea2 / MiniMax H3 专业提示词结构化生成法则与意图分流（全自动生图 / 分镜策划卡片）。

- [ ] **Step 2: 编写 Agent Bridge 失败测试**
  在 `server/src/agent/bridge.test.ts` 中使用 mock Pi CLI 测试 spawn 流程、多轮上下文维护以及 NDJSON 流转换为 SSE Event 的过程。

- [ ] **Step 3: 实现 Agent Bridge**
  在 `server/src/agent/bridge.ts` 中实现子进程管理、参数拼装（`--mode json`、`--mcp-config`）、JSON 解析与流式事件发射。

- [ ] **Step 4: 运行测试验证通过**
  `pnpm --filter server exec vitest run src/agent/bridge.test.ts`
  预期：PASS。

- [ ] **Step 5: Commit**
  `git commit -m "feat(agent): 实现 Pi Agent 调度 Bridge 与导演 Skill 知识库"`

---

### Task 4: 服务端 HTTP & SSE 路由整合 (`/api/chat` & `/api/tasks`)

**Files:**
- Modify: `server/src/index.ts`
- Test: `server/src/index.test.ts`

**Interfaces:**
- Consumes: `streamAgentChat` from `server/src/agent/bridge.ts`, `TaskQueue` from `server/src/tasks/queue.ts`
- Produces:
  - `POST /api/chat` (SSE 流式输出)
  - `POST /api/tasks/submit` (手动触发 Action Card 任务)
  - `GET /api/tasks/:id` (查询任务)
  - `POST /api/tasks/:id/cancel` (取消任务)

- [ ] **Step 1: 编写 `/api/chat` 与 `/api/tasks` 路由集成测试**
  测试客户端发起 POST 请求后，服务端以 `text/event-stream` 持续输出完整事件序列。

- [ ] **Step 2: 运行测试验证失败**
  `pnpm --filter server exec vitest run src/index.test.ts`
  预期：FAIL。

- [ ] **Step 3: 改造 `server/src/index.ts`**
  启动内置 MCP Server，将 `/api/chat` 接入 `streamAgentChat`，并提供任务查询与手动触发端点。

- [ ] **Step 4: 运行全量服务端单测**
  `pnpm --filter server test`
  预期：PASS。

- [ ] **Step 5: Commit**
  `git commit -m "feat(server): 接入 Agent SSE 对话端点与统一任务 API"`

---

### Task 5: 前端流式体验与任务状态卡片升级

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/components/ChatView.tsx`
- Modify: `web/src/components/Composer.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.css`

**Interfaces:**
- Consumes: `/api/chat` SSE 端点、`/api/tasks/submit` 端点
- Produces: 交互式打字机、思考链折叠、动态任务排队与采样进度条、多模态产物卡片与一键生成 Action Card。

- [ ] **Step 1: 更新前端 API 层 (`web/src/api.ts`)**
  封装 `sendAgentChatStream(message, opts, onEvent)`，支持解析 SSE 流事件（`agent:thinking`、`agent:text`、`task:progress` 等）。

- [ ] **Step 2: 升级 `ChatView.tsx` 渲染组件**
  - 在消息中聚合渲染：折叠的思考过程 + 渐进打字正文 + 实时任务进度条（带步数百分比与取消按钮） + 产物预览卡片。
  - 渲染「建议分镜 / 立即生成」Action Card，用户点击直接触发提交。

- [ ] **Step 3: 优化输入与终止控制 (`Composer.tsx` & `App.tsx`)**
  支持 Agent 回复中随时「停止生成」，保持工作流选择面板轻量纯净。

- [ ] **Step 4: 运行前端类型检查与打包**
  `pnpm --filter web build`
  预期：PASS。

- [ ] **Step 5: Commit**
  `git commit -m "feat(web): 升级流式聊天界面，支持思考链、实时进度条与动作卡片"`

---

### Task 6: 端到端联调与系统闭环测试

**Files:**
- Test: `server/src/e2e.test.ts`

- [ ] **Step 1: 编写全链路端到端模拟测试**
  模拟用户输入「帮我构思一个赛博朋克雨夜发光鹿的镜头并生成」，验证：
  1. Pi Agent 识别并增强提示词；
  2. MCP Server 被调用并向 TaskQueue 提交任务；
  3. TaskQueue 串行调度并在 WebSocket/SSE 广播进度；
  4. 最终输出产物卡片与结束事件。

- [ ] **Step 2: 运行全量测试套件与构建**
  `pnpm --filter server test && pnpm --filter web build`
  预期：PASS。

- [ ] **Step 3: Commit**
  `git commit -m "test: 完成 Pi Agent 与 TaskQueue 端到端流式生成闭环测试"`
