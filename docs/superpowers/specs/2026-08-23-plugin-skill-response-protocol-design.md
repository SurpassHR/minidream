# 插件 Skill 回复协议设计

## 目标

让使用某个工作流插件的对话由该插件 Skill 管理完整的用户可见回复格式，收束当前通用的“思维链 -> 提示词 -> 路由 -> 无意义生成状态句 -> 气泡外产物”混杂输出。

## 已确认决策

- 插件 Skill 完全接管选定插件的回复协议。
- 图像、视频和其他生成产物继续由工作台作为气泡外媒体展示，不由 Agent 正文描述或伪造。
- 通用导演协议只保留 MCP 工具使用、内部信息脱敏、一次提交和运行时安全约束；不再规定统一的 prompt/route/状态文字顺序。
- 旧版或缺少机器可读配置的 Skill 使用兼容默认值。

## 回复协议

插件 Skill frontmatter 增加受限的 `response` 配置：

```yaml
response:
  thinking: collapsed
  prompt: visible
  route: visible
  result: outside-bubble
```

字段允许值：

- `thinking`: `hidden`、`collapsed`、`visible`。`collapsed` 表示保留现有可折叠思维链；`hidden` 表示不向客户端转发思维链。
- `prompt`: `hidden`、`visible`。控制结构化 prompt 预览区，不影响 `generation.submit` 的实际参数。
- `route`: `hidden`、`visible`。控制结构化路由摘要区。
- `result`: 当前固定为 `outside-bubble`，表示任务产物在气泡外展示；该字段用于明确协议，不开放其他布局，避免 Skill 破坏工作台媒体边界。

未声明或解析失败时使用兼容默认值：`thinking: collapsed`、`prompt: visible`、`route: visible`、`result: outside-bubble`。

## 数据流

1. Agent 通过 `workflow.list` 选择插件，再通过 `workflow.skill` 获取插件 Skill。
2. Agent 遵循 Skill 的“回复协议”章节生成正文并提交一次 `generation.submit`。
3. 后端收到工具调用时记录提交插件 ID；读取该插件当前 Skill 的 frontmatter response 配置。
4. 后端继续转发安全允许的工具和任务事件，但按 response 配置过滤：思维链、prompt、route 分别独立处理。
5. 任务产物始终作为任务媒体事件发送，前端在气泡外渲染。
6. 会话落库只保存实际被展示的 thinking/prompt/route，刷新后的历史与实时显示一致。

## 覆盖优先级

- `.pi/skills/<plugin-id>/SKILL.md` 当前内容优先于自动生成内容。
- 自定义 Skill 的 response 配置优先于自动默认值；字段缺失逐字段回退默认值。
- 若自定义 Skill 配置非法，不阻断生成；非法字段按字段回退，非法 `result` 回退 `outside-bubble`。

## 自动生成与 LLM 生成

自动生成版 Skill 必须包含上述 frontmatter response 默认配置和 `## 回复协议` 章节。

`plugin-skill-creator` 必须输出该 frontmatter 和章节，但只能使用受限枚举，不得生成自定义布局或新字段。

## 错误处理

- 无法读取 Skill、Skill 缺失或 frontmatter 无法解析：使用兼容默认值并继续生成。
- 读取 Skill 发生 IO 错误：记录诊断信息，不阻断 Agent 对话。
- 插件被后端确定性路由到另一个插件时，使用最终提交插件的 Skill 协议；路由摘要本身是否展示仍由最终插件决定。

## 测试策略

- Skill 生成器输出默认 response 配置和回复协议章节。
- response 解析支持完整配置、部分配置、非法值和无 frontmatter 回退。
- 自定义 Skill 优先于自动版，且修改后立即生效。
- Agent 事件过滤：hidden 不转发对应事件，collapsed/visible 按默认 UI 协议转发。
- 后端类型检查、MCP/bridge/相关 API 测试与前端构建全部通过。

## Skill 对话调整

Skill 视图在编辑器下方提供对话调整区，调用 `POST /api/plugins/:id/skill/chat`。服务端向无工具 Skill Agent 传入当前插件的可控 widget 契约、当前完整 Skill 和最近对话历史；Agent 返回 `{ reply, skill }`，其中 `skill` 必须通过完整 SKILL.md 结构校验。新内容只回填前端编辑器预览，用户点击现有保存按钮后才写入自定义 Skill 文件。

## 范围外

- 不改变 MCP 工具入参/返回结构。
- 不把任务产物放入聊天气泡。
- 不允许插件 Skill 通过自然语言修改后端安全边界、任务队列或文件脱敏规则。
- 不增加自由格式的 UI 布局 DSL。
