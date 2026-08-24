# 插件 Skill 回复协议 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 让每个工作流插件的 Skill 完全管理该插件生成请求的用户可见回复协议，并按受限 response 配置过滤思维链、prompt 与路由事件，同时保持产物在气泡外展示。

**Architecture:** 在 `server/src/workflow-skill.ts` 中定义受限 `PluginResponsePolicy` 和 frontmatter 解析器；自动生成与 LLM 生成的 Skill 都声明同一组 response 默认值。`server/src/index.ts` 在 generation.submit 工具调用到达前后按最终 workflowId 读取当前 Skill 并过滤事件，前端继续使用现有结构化渲染与气泡外任务媒体区。

**Tech Stack:** TypeScript / Node ESM / Vitest / Express / React

**Spec:** `docs/superpowers/specs/2026-08-23-plugin-skill-response-protocol-design.md`

## Global Constraints

- 默认值固定为 `thinking: collapsed`、`prompt: visible`、`route: visible`、`result: outside-bubble`。
- 只允许受限枚举，不允许 Skill 修改工具安全边界、任务队列或产物布局。
- 自定义 Skill 优先；字段缺失或非法时逐字段回退默认值。
- response 配置变化无需手工同步自动版以外的协议代码；MCP 工具契约变化仍需同步 director-copilot skill。
- 产物永远通过任务事件在气泡外展示。

---

### Task 1: 回复协议解析与自动 Skill 输出

**Files:**
- Modify: `server/src/workflow-skill.ts`
- Test: `server/src/workflow-skill.test.ts`

**Interfaces:**
- `PluginResponsePolicy`
- `DEFAULT_PLUGIN_RESPONSE_POLICY`
- `parsePluginResponsePolicy(content: string | null | undefined): PluginResponsePolicy`
- `generatePluginSkill(spec)` 输出带 `response` frontmatter 和 `## 回复协议`

- [x] 写测试覆盖完整、部分、非法 frontmatter，以及自动生成内容。
- [x] 运行 `cd server && pnpm exec vitest run src/workflow-skill.test.ts` 确认测试因接口/输出缺失失败。
- [x] 实现无依赖的 frontmatter response 解析和自动生成。
- [x] 重跑测试确认通过。

### Task 2: plugin-skill-creator 生成约束

**Files:**
- Modify: `.pi/skills/plugin-skill-creator/SKILL.md`
- Modify: `server/src/agent/bridge.ts`
- Test: `server/src/agent/bridge.test.ts`

**Interfaces:**
- `serializeSpecForSkillCreator` 输入结构增加 response policy 约束说明，不把运行时内部字段暴露给模型。
- `PLUGIN_SKILL_CREATOR_SYSTEM_PROMPT` 要求输出 response frontmatter 和回复协议章节。

- [x] 先增加生成输出包含 response 配置的测试并确认失败。
- [x] 更新 creator skill、序列化输入说明和格式验证。
- [x] 重跑 bridge 测试。

### Task 3: 运行时按最终插件过滤 Agent 事件

**Files:**
- Modify: `server/src/index.ts`
- Modify: `server/src/workflow-skill.ts`
- Test: `server/src/index.test.ts` 或现有 Agent API 测试

**Interfaces:**
- `readPluginResponsePolicy(workflowId, skillsDir?)` 使用当前 Skill 文件并回退默认值。
- generation.submit 工具调用识别 requested workflow；工具结果 route 中的 `finalWorkflowId` 成为实际策略来源。
- `agent:thinking`、`agent:prompt`、`agent:route` 按策略过滤；`agent:text` 不过滤，只由 Skill 自然语言约束。

- [x] 增加 policy 过滤纯函数测试，覆盖 hidden 与最终路由插件。
- [x] 实现工具调用期间的策略状态管理；generation.submit 之前的 thinking 暂存，提交成功后按最终插件策略发出或丢弃。
- [x] 保证任务订阅、`agent:reply_done`、`agent:end` 与气泡外 artifact 行为不变。
- [x] 运行相关后端测试。

### Task 4: 同步通用协议与项目备忘

**Files:**
- Modify: `.pi/skills/director-copilot/SKILL.md`
- Modify: `server/src/index.ts`
- Modify: `AGENTS.md`

- [x] 删除通用的固定回复顺序与 prompt/route 强制展示规则。
- [x] 保留 MCP、脱敏、一次提交、产物气泡外等运行时硬约束。
- [x] 记录 response 协议、默认值、覆盖优先级和同步要求。

### Task 5: 全量验证

- [x] `cd server && pnpm exec tsc --noEmit`
- [x] `cd server && pnpm exec vitest run`
- [x] `cd web && pnpm exec tsc --noEmit && pnpm run build`
- [x] 检查 git diff，确认只包含本需求相关文件。

---

## 后续扩展：Skill 对话调整

- [x] 新增无工具 `runPluginSkillChat`，传入 widget 契约、当前 Skill 与最近历史。
- [x] 新增 `POST /api/plugins/:id/skill/chat`，返回 `{ reply, skill }` 且不自动写盘。
- [x] 在 Skill 编辑器下方增加对话消息、输入和发送交互；结果只更新预览。
- [x] 更新 `AGENTS.md` 与本设计文档记录对话上下文及手动保存边界。
- [x] 运行 Skill 对话相关后端全量测试、类型检查和前端构建。
