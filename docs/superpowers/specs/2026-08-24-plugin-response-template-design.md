# Plugin Response Template Design

## Goal

将插件回复协议从 Skill 正文和固定的 `thinking/prompt/route` 展示字段中抽离为可手工编辑的结构化配置。用户可以选择插件输入值、生成上下文和有限的 Agent 正文，并按自定义顺序组成普通文本、可折叠块或代码内容；生成产物仍固定在聊天气泡外展示。

## Design Decisions

### 1. 独立机器协议

每个插件使用独立文件：

```text
.pi/skills/<plugin-id>/SKILL.md
.pi/skills/<plugin-id>/response.json
```

`SKILL.md` 只负责 Agent 理解插件用途、输入、参数、MCP 调用规则和回复协议说明。`response.json` 是后端和前端唯一读取的机器协议，由 Skill 面板旁的回复协议编辑器保存。

旧版只有 `SKILL.md` frontmatter `response` 的插件继续可用：后端把旧字段转换为兼容协议；首次保存新协议时写入 `response.json`，不改写 Skill 正文。

### 2. 协议结构

```ts
interface PluginResponseProtocol {
  version: 1;
  thinking: {
    enabled: boolean;
    container: 'text' | 'collapsible';
    format: 'plain' | 'markdown' | 'code';
    defaultOpen?: boolean;
    language?: string;
  };
  blocks: PluginResponseBlock[];
  result: {
    display: 'outside-bubble';
  };
}

interface PluginResponseBlock {
  id: string;
  type: 'field' | 'template' | 'assistant-reply';
  source?: ResponseSource;
  template?: string;
  label?: string;
  container: 'text' | 'collapsible';
  format: 'plain' | 'markdown' | 'code';
  defaultOpen?: boolean;
  language?: string;
  timing: 'submit' | 'complete' | 'always';
  visibleWhen?: {
    source: ResponseSource;
    operator: 'exists' | 'not-empty';
  };
}
```

`container` 和 `format` 是两个独立维度，因此支持普通文本、可折叠文本、代码块和可折叠代码块。`result.display` 固定为 `outside-bubble`，第一版不允许把媒体产物塞进聊天气泡。

### 3. 占位符来源

第一版只允许以下来源，后端使用白名单解析，不允许任意对象路径、表达式或 JavaScript：

```text
plugin.name
plugin.description
input.<visible-input-id>
param.<visible-param-id>
generation.prompt
generation.negativePrompt
generation.workflowName
generation.intent
route.requestedWorkflow
route.finalWorkflow
route.reason
result.count
result.types
result.status
assistant.reply
```

`input.*` 只来自 `!hidden` 输入，`param.*` 只来自 `!hidden && llm !== false` 参数。参数值使用任务最终生效值；如果字段未参与本次任务，解析为空。`generation.negativePrompt` 只在可识别的负面提示词参数存在时提供，不能通过 label 猜测任意内部字段。

第一版模板语法只支持变量占位符和有限默认值：

```text
{{param.text-551}}
{{param.text-551 | default:"未设置"}}
```

不支持条件表达式、循环、函数调用、原始任务对象或 MCP 工具结果。空字段通过 `visibleWhen` 控制块是否渲染。

### 4. 渲染时机

- `always`：Agent 正文 `assistant.reply` 和插件元信息，可在 Agent 回复流中更新。
- `submit`：正面/反面提示词、widget 参数、工作流和路由，在 `generation.submit` 结果确认后生成。
- `complete`：结果数量、输出类型和完成状态，在任务完成/失败/取消事件到达后生成。

后端根据协议生成结构化 `agent:response_block` 事件，前端不从 `toolCalls`、MCP 原始返回或任务对象猜测字段。

### 5. 与现有协议兼容

旧版 `response.thinking` 映射到 `thinking`：

- `hidden` -> `enabled: false`
- `collapsed` -> `enabled: true, container: collapsible, defaultOpen: false`
- `visible` -> `enabled: true, container: collapsible, defaultOpen: true`

旧版 `prompt: visible`、`route: visible` 生成对应默认 `submit` field block；`hidden` 不生成对应 block。`result` 始终保持气泡外。

新协议存在时，旧 frontmatter `response` 不再控制结构化事件，避免双重配置。

### 6. 编辑器边界

回复协议编辑器与 Skill tab 平级，提供：

- 可拖拽或上移/下移的回复块列表；
- 添加字段、模板、Agent 正文三类块；
- 字段来源下拉框，按插件输入、widget 参数、生成上下文、路由、结果和 Agent 正文分组；
- 容器选择：普通文本/可折叠；
- 内容格式选择：纯文本/Markdown/代码；
- 可折叠块的默认展开状态；
- 代码块语言；
- 提交时机；
- 可选的非空显示条件；
- 占位符预览和非法来源错误提示。

协议保存采用预览后手动保存，与当前 Skill 编辑器一致。回复协议保存和 Skill 保存分别写入各自文件。

## Security And Validation

- 只接受 `version: 1`。
- block 数量、字符串长度、模板长度、语言字段和占位符数量设置上限。
- source 必须匹配当前插件 manifest 的可见输入/参数或固定系统白名单。
- 禁止 `tool.*`、`mcp.*`、`task.*`、`node.*`、文件路径、URL、任务 ID、session ID 和原始 workflow JSON。
- 模板渲染结果作为文本或受控 Markdown 进入前端；代码格式永远使用文本节点，不执行内容。
- 非法协议回退旧 frontmatter 兼容协议；若旧协议也不存在，使用当前默认展示策略。

## Success Criteria

- 用户可以在插件面板编辑并保存独立回复协议。
- `{{param.<id>}}` 能显示本次任务的最终 widget 值，包括反面提示词、宽度和高度。
- 一个块可同时配置为可折叠容器和代码格式。
- 前端只渲染后端验证后的 `agent:response_block`，不再从工具调用旁路推断显示内容。
- 旧版 Skill 和现有会话仍保持可用。
- 生成媒体始终位于聊天气泡外。
