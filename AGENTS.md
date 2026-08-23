# AGENTS.md — 开发备忘

## ComfyUI 配置持久化

- 配置文件：`server/data/settings.json`（结构 `{ comfyui: { baseUrl: string } }`）
- 持久化模块：`server/src/settings.ts`，照搬 v1 会话存储的原子写方案（tmp + rename）
- 启动时从文件恢复 `COMFYUI_BASE_URL`，环境变量仍可覆盖
- `POST /api/settings/comfyui` 同时写文件 + 更新内存 + 清缓存 + 健康检查
- 不要使用 localhost 作为存储配置的手段

## Director-Copilot Skill 维护

- 项目专属 Agent 约束文件：`.pi/skills/director-copilot/SKILL.md`，由 `server/src/agent/bridge.ts` 通过 `--skill` 注入每次对话
- 它约束 Agent 的意图判断、工作流选择、参数回答、MCP 工具用法与回复规范，是工作台对外的“行为协议”
- **内部协议变更时必须即时同步该 skill**，包括但不限于：
  - MCP 工具增减或入参/返回值结构变化（`workflow.list`、`generation.submit` 等）
  - 工作流插件/映射契约变化（params/inputs/outputs、`llm` 字段、combo 配置归属等）
  - 路由规则变化（如参考图 + 放大意图确定性路由到 SeedVR2）
  - 提示词注入/对话历史机制变化（虚构历史、参考图片命名、prompt 代码块要求等）
- 系统提示词（`server/src/index.ts` 的 `agentSystemPrompt`）只保留无法归入 skill 的运行时行为，并引用 skill；不要在两侧重复堆叠同一规则

## 工作流插件 Skill 自动生成

- 每个工作流插件（内置+导入）自动生成 `.pi/skills/<plugin-id>/SKILL.md`（`server/src/workflow-skill.ts`），内容为可控制参数（默认值/范围/选项/applyTo 联动）、输入输出与使用规则，过滤口径与 `workflow.list` 一致（`!hidden && llm !== false`）。
- 生成时机：启动幂等补齐、插件导入/保存 manifest 时重新生成、删除插件时删除；`GET /api/plugins/:id/skill` 预览、`POST /api/plugins/:id/skill/regenerate` 强制重写。
- MCP `workflow.skill` 按需返回某插件的详细 skill，`workflow.list` 保持精简摘要（两级结构）。
- 导演 Agent 启动参数含 `--no-context-files`：全局/项目 AGENTS.md 不再注入，知识来源仅 director-copilot skill + `--append-system-prompt` + MCP 工具。
- 插件参数契约变更（params/inputs/llm 标记等）会经生成器自动反映到 skill，无需手工同步；但 MCP 工具契约变化仍须按上节同步 director-copilot skill。
- Skill 视图（映射弹窗第三个 tab）可编辑保存（`PUT /api/plugins/:id/skill`）、用 `plugin-skill-creator` 重新生成（`POST /api/plugins/:id/skill/generate`）、或回退自动版（`POST .../skill/regenerate`）。
- LLM 生成/手工编辑的 skill 属于自定义版本：导入与 manifest 保存只做 `syncPluginSkill`（缺失或自动版才重写），不会覆盖自定义内容。
- `plugin-skill-creator`（`.pi/skills/plugin-skill-creator/SKILL.md`）是项目级 skill：由 `runPluginSkillCreator`（`server/src/agent/bridge.ts`）以无工具 pi 子进程加载，接收插件 manifest JSON 产出 SKILL.md；它约束生成内容只含 `!hidden && llm !== false` 参数并保留用户 description。修改它的生成规则时同步更新 `serializeSpecForSkillCreator` 的入参结构。
