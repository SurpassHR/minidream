# 工作流插件 Skill 机制设计

## 目标

为每个工作流插件（内置 + 导入）自动生成一份独立的 SKILL.md，把插件的完整行为写进插件自身：用途、输入要求、可控制参数（哪些 widget 可调、默认值、范围、选项、联动）、输出类型与自动推导的使用规则。LLM 通过新增 MCP 工具 `workflow.skill` 按需获取对应插件的 skill，形成「先 `workflow.list` 精选 → 再 `workflow.skill` 详看」的两级知识结构，把插件使用方法从导演系统完全提取到插件本身，与全局 Agent 环境隔离。

## 已确认决策

- skill 内容**自动从 manifest/spec 生成**，不做手工维护；manifest 变更后自动重新生成，永不漂移。
- 通过**新增 MCP 工具 `workflow.skill` 按需获取**，不并入 `workflow.list`、不启动时全量注入。
- skill **落盘为 `.md` 文件**（`.pi/skills/<plugin-id>/SKILL.md`），并在插件管理界面提供 **Skill 预览**入口。
- 导演隔离增强：`runAgentStream` 补 `--no-context-files`，全局/项目 AGENTS.md、CLAUDE.md 不再注入导演 LLM。

## 背景审查：全局注入面

对全局层（`~/.pi/agent/`、`~/.agents/skills/`、`~/AGENTS.md`）的审查结论（2026-08-23 验证）：

- **全局 MCP**（`mcp.json`：codegraph、openreel-studio）与本项目插件无关；`--mcp-config` 临时文件会**替换** pi-global 源，其余候选路径（`~/.config/mcp/mcp.json`、`.agents/mcp.json`、项目 `.mcp.json`/`.pi/mcp.json`）均不存在，已隔离。
- **全局 skills**（`~/.pi/agent/skills/` → `~/.agents/skills/` 的 11 个 symlink）全是 Cloudflare/Web 平台技能；`~/.agents/skills/` 全量目录虽有 `comfyui-node-advanced`、`comfyui-node-datatypes`，但那是**编写 ComfyUI 自定义节点**的开发知识，不涉及本项目插件用法，且不在 pi 发现列表内，`--no-skills` 也禁止全部发现。
- **全局注入面中不存在直接点名本项目任何插件（krea2/seedvr2/minimax/h3 等）的内容**；插件知识完全来自项目自身 MCP 工具在运行时对 manifest 的内省。
- **`APPEND_SYSTEM.md` 意外已隔离**：pi 源码确认 `--append-system-prompt` 会替换自动发现的 APPEND_SYSTEM.md（resource-loader.js），bridge 每次传参，全局那份不会注入。
- **隔离缺口**：`--no-context-files` 未启用，`loadProjectContextFiles` 会把全局 `~/.pi/agent/AGENTS.md`（symlink 到 `~/AGENTS.md`）与项目根 `AGENTS.md` 作为上下文注入每次导演 LLM 调用。内容当前无插件指导、无冲突，但属于未受控注入面（引用 plan panel、git-commit-en 等导演没有的能力）。

## 架构

### Skill 生成器（新文件 `server/src/workflow-skill.ts`）

`generatePluginSkill(spec: WorkflowSpec): string` 从统一 WorkflowSpec 生成 markdown。spec 来源为 `buildSpecsCached()`，覆盖内置（无 manifest 时自动 introspection）与导入插件，因此**全部插件都能生成 skill**。

过滤口径与 `workflow.list` 一致：只纳入 `!hidden && llm !== false` 的输入/参数/输出。

生成的 SKILL.md 结构：

```markdown
---
name: <plugin-id>
description: <spec.description 或自动推导的一行用途>
---

# <name>

> 本文件由 server/src/workflow-skill.ts 自动生成，勿手工编辑；
> 修改插件 manifest 或重新识别后会自动重新生成。

## 用途
<spec.description>

## 输入
- 文本输入：label、是否 primary（提示词占位节点）、默认值摘要
- 图像/视频输入：label、数量、必传性（required / 无默认值）

## 可控制参数
对每个 llm !== false 且未隐藏的参数：
- id、label、类型（INT/FLOAT/BOOLEAN/STRING/combo）
- 默认值、min/max/step、combo 有限选项（前 32 个）
- multiple/strengthable（多选 LoRA 等）
- applyTo 联动（"同时作用于节点 X/Y，如分阶段采样链"）
- description（用户为 LLM 填写的用途说明）

## 输出
- kind（image/video/text）、label

## 使用规则（自动推导）
- 无文本输入 → "本工作流不接受提示词，仅用于图像放大/增强，必须传入参考图"
- 有必传图像/视频输入 → "必须按顺序传入 N 张/个参考素材"
- 参考图 + 放大意图会被后端确定性路由到本工作流（如 seedvr2）
```

### 存储与生命周期

- 落盘位置：`.pi/skills/<plugin-id>/SKILL.md`（与 `director-copilot` 平级）。头部带自动生成标记。bridge 已用 `--no-skills` 隔离全部技能发现，这些文件**不会被 pi 自动加载**，只经 MCP 工具按需取用。
- 原子写入：沿用 tmp + rename 方案。
- 生成时机：
  - 启动时对每个有效 spec 幂等补齐（缺失才生成，不覆盖已有手工痕迹——虽然当前是纯自动，保留幂等语义防误删恢复）；
  - 插件导入（`POST /api/plugins/import`）成功后生成；
  - 保存 manifest（`PUT /api/plugins/:id`）后重新生成；
  - 删除插件（`DELETE /api/plugins/:id`）时删除对应 skill 文件。

### MCP 新工具 `workflow.skill`

- 入参：`workflowId: string`（必填）。
- 返回：该插件的完整 skill markdown 文本（`content: [{ type: 'text', text }]`）。
- 错误：插件不存在、未启用（`isWorkflowEnabled` 返回 false）时返回可读错误。
- `workflow.list` 保持精简摘要不变，`workflow.skill` 作为详细层，形成两级结构。
- 工具列表（`tools/list`）在 `isStatusPollingEnabled` 过滤逻辑之外保持全量。

### HTTP API 与 UI 预览

- `GET /api/plugins/:id/skill`：返回该插件的 skill markdown（`text/markdown` 或 JSON 包装），不存在且插件有效时即时生成返回。
- `POST /api/plugins/:id/skill/regenerate`：强制重新生成落盘文件（供 UI 手动触发）。
- 前端：`WorkflowMappingModal` 增加「Skill 预览」入口，弹窗展示 markdown（只读）。

## 导演隔离增强

`server/src/agent/bridge.ts` 的 `runAgentStream` 参数追加 `--no-context-files`：

- 禁用 `AGENTS.md`/`CLAUDE.md`/`AGENTS.override.md` 的自动发现与加载（全局 `~/.pi/agent/AGENTS.md` 与项目根 `AGENTS.md` 都不再注入）。
- 导演 Agent 知识来源收敛为：`--skill director-copilot` + `--append-system-prompt`（agentSystemPrompt）+ MCP 工具（`workflow.list` / `workflow.skill` / `generation.*`）。
- 标题生成调用（`generateConversationTitle`）保持轻量，不加此参数（无副作用，但也不强制）。

## 协议同步（AGENTS.md 强制要求）

- `.pi/skills/director-copilot/SKILL.md` 的「MCP 工具」与「工作流选择」章节补充：选定工作流后如需了解该插件的完整可控制参数与输入输出要求，调用 `workflow.skill` 获取详细 skill；`workflow.list` 只做精选。
- `server/src/index.ts` 的 `agentSystemPrompt` 补充同一条规则（运行时行为，与 skill 不重复堆叠）。
- `AGENTS.md` 开发备忘补充：插件 skill 自动生成机制、`--no-context-files` 隔离策略、以及"内部协议变更必须同步 director-copilot skill"中新增 `workflow.skill` 的契约说明。

## 数据流

```text
插件导入 / manifest 保存 / 启动
  -> workflow-skill.ts 从统一 spec 生成 markdown
  -> 落盘 .pi/skills/<plugin-id>/SKILL.md

对话中：
用户指令
  -> 导演 Agent
  -> workflow.list（精简摘要，选定插件）
  -> workflow.skill（详细 skill：可控制参数/输入要求/使用规则）
  -> generation.submit（workflowId + prompt + images + params）
  -> TaskQueue 入队 -> buildPrompt 按 nodeId + field 注入 -> ComfyUI
```

## 错误处理与生命周期

- 插件不存在/未启用：`workflow.skill` 与 `GET /api/plugins/:id/skill` 返回可读错误。
- 生成失败（spec 缺失等）：返回错误，不影响插件其余功能。
- skill 文件写入失败：记录但不阻断插件导入/保存主流程（skill 是增强性知识，非生成必需）。
- 删除插件：连带删除 skill 文件；内置插件删 manifest 恢复自动识别时同样重建 skill。

## 测试策略

后端：

- 生成器单测（`workflow-skill.test.ts`）：
  - 参数过滤：`hidden`/`llm === false` 不出现；
  - 类型/默认值/范围/选项标注正确；
  - applyTo 联动描述、multiple/strengthable（多选 LoRA）呈现；
  - 自动推导规则：无文本输入（seedvr2）、必传参考图（h3-i2v/r2v、seedvr2）、放大路由提示；
  - 内置插件（无 manifest）与导入插件都能生成。
- MCP 契约（`mcp/server.test.ts` 增补）：`workflow.skill` 返回 markdown；未启用/不存在返回错误。
- HTTP API：`GET /api/plugins/:id/skill`、`POST /api/plugins/:id/skill/regenerate`；导入/保存/删除时 skill 文件同步。
- bridge：`runAgentStream` 参数包含 `--no-context-files`。

验证命令沿用项目现有脚本：

```bash
cd server && pnpm exec tsc --noEmit
cd server && pnpm exec vitest run
cd web && pnpm exec tsc --noEmit && pnpm run build
```

## 范围外

- 不做手工编辑 skill（纯自动生成，头部标记勿改）；
- 不把插件 skill 注入 pi 的技能发现（保持 `--no-skills` 隔离，仅 MCP 按需取用）；
- 不改变 `workflow.list` 的精简摘要结构；
- 不改变 generation.submit 路由与构建链路。
