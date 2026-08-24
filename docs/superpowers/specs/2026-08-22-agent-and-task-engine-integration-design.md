# Minidream Agent & Task Engine Integration Spec

> **Date:** 2026-08-22  
> **Status:** Approved / Ready for Implementation  
> **Scope:** Architectural (Pi Agent Bridge, MCP Server, TaskQueue Engine, Frontend Stream UX)

---

## 1. 架构总览 (System Architecture)

系统由 **Pi Agent 决策大脑**、**Director MCP Server 执行层**、**全局统一任务队列 TaskQueue** 以及 **Web 前端流式交互界面** 组成，实现从自然语言/多模态输入到图像与视频生成的端到端闭环。

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Web 前端交互层                                  │
│   (ChatView 统一流式对话 / 思考链折叠 / 渲染进度条 / 动作卡片 / 媒体呈现)   │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ HTTP POST /api/chat (SSE 流式长连接)
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      Server 编排层 (Express + SSE)                       │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ Agent Bridge (Pi CLI 子进程调度器)                                  │  │
│  │  - 会话多轮历史管理 (session history)                              │  │
│  │  - Pi 子进程管理 (spawn pi --mode json --mcp-config ...)          │  │
│  │  - NDJSON 输出解析并转换为 SSE 事件分发                            │  │
│  └──────────────────┬─────────────────────────────▲──────────────────┘  │
│                     │                             │ MCP Tool Call        │
│                     ▼                             │ (HTTP / JSON-RPC)    │
│  ┌────────────────────────────────────────────────┴──────────────────┐  │
│  │ Director MCP Server (工作台专用执行端点)                           │  │
│  │  - workflow.list       -> 自省模板 (Krea2 / MiniMax H3)           │  │
│  │  - generation.submit   -> 创建生成 Task (排队入队)                │  │
│  │  - generation.status   -> 查询 Task 状态与产出                     │  │
│  │  - generation.cancel   -> 取消任务并释放显存                      │  │
│  └──────────────────┬────────────────────────────────────────────────┘  │
│                     │ 调度与事件监听                                     │
│                     ▼                                                   │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ TaskQueue & ComfyUI Introspection Engine (统一任务管理引擎)       │  │
│  │  - 串行排队 (Concurrency = 1, 本地 GPU 显存保护)                  │  │
│  │  - 任务原子持久化 (tasks.json) 与服务重启中断恢复                   │  │
│  │  - ComfyUI 自省、Prompt 动态组装与全局配置注入                     │  │
│  │  - WebSocket 进度桥接与事件广播 (TaskStage 追踪)                  │  │
│  └──────────────────┬────────────────────────────────────────────────┘  │
└─────────────────────┼───────────────────────────────────────────────────┘
                      │ ComfyUI HTTP API & WebSocket
                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           ComfyUI 本地后端                              │
│       (Krea2 Turbo T2I / INT8 风格参考生图 / MiniMax H3 T2V/I2V/R2V)     │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 统一任务管理引擎规范 (TaskQueue Engine)

### 2.1 数据模型定义 (`server/src/tasks/types.ts`)

```ts
export type TaskType = 'image_generation' | 'video_generation';
export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled' | 'interrupted';

export interface TaskStage {
  id: string;
  name: string;        // 'Introspecting' | 'Uploading Assets' | 'ComfyUI Queue' | 'Sampling' | 'Output Export'
  status: 'pending' | 'active' | 'completed' | 'failed';
  progress?: number;   // 0 - 100
  step?: number;       // 当前采样步数
  totalSteps?: number; // 总步数
  logs: string[];
}

export interface TaskOutput {
  kind: 'image' | 'video';
  url: string;
  filename: string;
}

export interface TaskItem {
  id: string;
  type: TaskType;
  status: TaskStatus;
  workflowId: string;
  prompt: string;
  images?: string[];     // 风格图/参考图路径或 URL
  params?: Record<string, unknown>; // 覆盖参数 (可选，默认走全局 Settings)
  sessionId?: string;    // 关联的会话 ID
  stages: TaskStage[];
  outputs?: TaskOutput[];
  error?: string;
  createdAt: number;
  updatedAt: number;
}
```

### 2.2 调度策略与持久化机制 (`server/src/tasks/queue.ts`)
1. **显存保护与串行调度**：
   - 调度器并发量限制为 `1`。每次仅允许一个生图或生视频任务处于 `running` 状态，其他任务在 `queued` 状态等待。
2. **任务持久化**：
   - 每次任务状态变更时，异步原子写入 `server/data/tasks.json`（tmp + rename 模式）。
3. **重启恢复机制**：
   - 服务启动时加载 `tasks.json`，若发现处于 `running` 状态的任务，自动重置其状态为 `interrupted`，并在前端提供一键重试。

---

## 3. Director MCP Server 协议规范 (`server/src/mcp/server.ts`)

MCP Server 作为独立轻量 HTTP 服务运行在本地专用端口，向 Pi Agent 暴露以下 4 个核心 Tool：

### 3.1 `workflow.list`
- **入参**：无
- **出参**：可用的工作流列表元数据（ID、名称、描述、支持的输入类型与输出类型）。

### 3.2 `generation.submit`
- **入参**：
  - `workflowId`: string（必填，工作流模板 ID）
  - `prompt`: string（必填，英文提示词）
  - `images`: string[]（可选，参考图或风格图）
  - `params`: object（可选，微调覆盖参数）
  - `sessionId`: string（可选，会话 ID）
- **出参**：`{ taskId: string, status: "queued", position: number }`

### 3.3 `generation.status`
- **入参**：`{ taskId: string }`
- **出参**：任务完整对象（包含 status, stages, outputs, error）。

### 3.4 `generation.cancel`
- **入参**：`{ taskId: string }`
- **出参**：`{ success: boolean, message: string }`

---

## 4. 导演大脑 Skill 规范 (`.pi/skills/director-copilot/SKILL.md`)

注入 Pi Agent 的核心导演认知规则：
1. **语法结构增强**：
   - Krea2 图像：自动补齐摄影机位、光线与胶片质感（`anamorphic lens, cinematic lighting, 8k, photorealistic`）。
   - MiniMax H3 视频：严格遵循 `[Camera Movement] + [Subject Action] + [Environment & Lighting] + [Atmosphere]` 结构化提示词。
2. **交互意图分流**：
   - **直接生成指令** $\to$ 自动补全提示词，立即调用 `generation.submit`，并向用户简述构思。
   - **开放式分镜构思** $\to$ 输出分镜剧本设计 Markdown，并附带结构化动作卡片供用户点击触发生成。

---

## 5. 前后端 SSE 通信协议 (`/api/chat`)

前端通过 HTTP POST `/api/chat` 发起对话，后端以 `text/event-stream` 格式持续推送事件：

| Event Name | 数据载荷 (JSON) | 语义说明 |
| :--- | :--- | :--- |
| `agent:thinking` | `{ delta: string }` | 思维链内容增量（流式打字与折叠展示） |
| `agent:text` | `{ delta: string }` | 正文 Markdown 内容增量 |
| `agent:action_card` | `{ title, workflowId, prompt, images, params }` | 建议卡片（支持点击确认生成） |
| `tool:call` | `{ name: string, args: object }` | MCP 工具调用通知 |
| `tool:result` | `{ name: string, result: object }` | MCP 工具执行结果 |
| `task:queued` | `{ taskId: string, position: number }` | 任务创建成功并已排队 |
| `task:progress` | `{ taskId: string, stage: string, step: number, total: number, percent: number }` | 任务实时采样进度条同步 |
| `task:artifact` | `{ taskId: string, kind: 'image' \| 'video', url: string }` | 任务成果输出与多模态渲染 |
| `agent:end` | `{ sessionId: string, title?: string }` | 当前对话轮次结束 |

---

## 6. 前端流式界面交互设计 (`web/src/components/ChatView.tsx`)

1. **单消息气泡聚合渲染**：
   - 顶部：可折叠展开的 `Deep Thinking` 思考链；
   - 中部：格式化的导演阐述与分镜建议（Markdown + 代码块高亮）；
   - 底部：动态任务卡片（排队提示 / 实时采样进度条 / 取消按钮 / 高清大图预览与视频播放器）。
2. **操作卡片（Action Card）一键触发**：
   - 点击半自动模式下的「立即生成」按钮，前端直接调用 `/api/tasks/submit` 将该分镜提交至统一队列，并直接挂载进度卡片。
3. **随时取消与终止**：
   - 支持正在思考时点击「停止响应」；
   - 支持正在渲染时点击「取消任务」释放 GPU 资源。

---

## 7. 质量保证与测试策略

1. **TaskQueue 单测**：测试单 worker 串行排队、任务去重、异常中断与 JSON 持久化恢复。
2. **MCP Server 单测**：测试 `workflow.list`、`generation.submit`、`generation.status` 的 JSON-RPC 请求与响应契约。
3. **Agent Bridge 单测**：测试子进程 spawn、流式 NDJSON 消息解析与异常退出处理。
4. **端到端集成测试**：验证从 `/api/chat` 发起对话，经 Pi Agent $\to$ MCP $\to$ TaskQueue $\to$ ComfyUI $\to$ 前端 SSE 事件流的完整通路。
