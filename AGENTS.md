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
