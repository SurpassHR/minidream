# Project Skill Routing Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Pi 只加载项目级 Skill，并在对话中展示工作流意图识别、参考图绑定、最终工作流和路由原因。

**Architecture:** `bridge.ts` 显式使用 `--no-skills` 后通过 `--skill` 加载项目 Skill。MCP `generation.submit` 返回结构化 route 元数据，并通过带 `sessionId` 的回调发布 `agent:route` SSE 事件；服务器将其保存到当前助手消息，前端渲染为路由摘要。

**Tech Stack:** TypeScript, Vitest, Express SSE, React.

**Spec:** 用户已确认的项目级 Skill 隔离与路由可观测设计。

## Global Constraints

- 不加载 `~/.pi/agent/skills/*` 或 `~/.agents/skills/*`。
- 只加载仓库内 `.pi/skills/director-copilot/SKILL.md`。
- 不展示 Agent 内部完整思考，只展示结构化路由摘要。
- 保留现有 MCP、任务队列和会话 SSE 链路。

---

### Task 1: 固定 Skill 隔离与路由元数据契约

**Files:**
- Modify: `server/src/agent/bridge.test.ts`
- Modify: `server/src/mcp/server.test.ts`

- [ ] **Step 1: 写失败测试**：断言 Agent 启动参数包含 `--no-skills`、项目 `director-copilot/SKILL.md`，且 MCP 放大提交返回 `route` 元数据并触发结构化回调。
- [ ] **Step 2: 运行定向测试确认失败**：`cd server && pnpm exec vitest run src/agent/bridge.test.ts src/mcp/server.test.ts`。

### Task 2: 实现 Skill 隔离

**Files:**
- Modify: `server/src/agent/bridge.ts`

- [ ] **Step 1: 增加项目 Skill 路径解析**：从模块位置解析仓库根目录，检查 `SKILL.md` 是否存在。
- [ ] **Step 2: 在 Agent 运行参数中加入 `--no-skills` 和项目 `--skill`**。
- [ ] **Step 3: 标题生成也禁用全局 Skill，避免后台标题进程加载用户 Skill**。
- [ ] **Step 4: 运行 Bridge 测试确认通过**。

### Task 3: 实现结构化路由事件

**Files:**
- Modify: `server/src/mcp/server.ts`
- Modify: `server/src/index.ts`
- Modify: `server/src/sessions.ts`
- Modify: `server/src/agent/bridge.test.ts`
- Modify: `server/src/mcp/server.test.ts`

- [ ] **Step 1: 定义 route 数据结构**：包含 requested workflow、final workflow、intent、reference image count、route reason 和 forced 标记。
- [ ] **Step 2: `generation.submit` 返回 route 并通过 `onActivity` 发布 `agent:route`，使用 `sessionId` 关联会话。
- [ ] **Step 3: 聊天 SSE 转发 `agent:route`，并在助手消息落库时保存 route。
- [ ] **Step 4: 运行后端定向测试。

### Task 4: 前端展示路由分析

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/ChatView.tsx`
- Modify: `web/src/App.css`

- [ ] **Step 1: 增加 `StreamChatEvent`、`ChatMessage` 和工具调用结果的 route 类型。
- [ ] **Step 2: 合并 `agent:route` 到当前助手消息，并在更新消息时保留它。
- [ ] **Step 3: 在助手气泡中渲染路由摘要，显示意图、参考图、最终工作流和原因。
- [ ] **Step 4: 调整 generation.submit 工具标签，使用最终 route 而不是只依据请求 workflowId 判断。

### Task 5: 验证

- [ ] **Step 1: `cd server && pnpm exec tsc --noEmit`。
- [ ] **Step 2: `cd server && pnpm exec vitest run`。
- [ ] **Step 3: `cd web && pnpm exec tsc --noEmit && pnpm run build`。
