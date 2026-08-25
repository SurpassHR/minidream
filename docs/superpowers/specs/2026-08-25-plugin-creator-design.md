# Plugin Creator 统一插件配置设计

## 目标

将现有 `plugin-skill-creator` 升级并更名为 `plugin-creator`。它先读取并理解 ComfyUI 工作流，在现有 workflow normalizer、graph builder 和校验器之上分析插件用途、输入节点、输出节点及 widget 暴露建议，然后生成待确认的完整配置建议。只有用户确认后，后端才保存 manifest、SKILL.md 和 response.json。

## 核心原则

- LLM 负责语义分析和建议，不直接写入插件文件。
- 后端负责 nodeId、field、type、默认值、范围、options、applyTo 等结构事实和安全校验。
- 用户确认是唯一落盘门槛。
- 未确认的建议只存在请求响应或前端状态中，不改变现有插件行为。
- 已有用户自定义 SKILL.md 和 response.json 不被自动覆盖；确认保存时提供显式覆盖选择或保留原内容。
- 兼容 API/UI 两种 ComfyUI workflow 格式，复用现有转换逻辑。

## 现有基础设施复用

- `server/src/workflow.ts`：UI/API 格式转换、子图展开、Set/Get 解析、死节点裁剪、输入/参数/输出识别。
- `server/src/workflow-graph.ts`：节点图、边、widget 字段、可选状态、位置和 applyTo 计算。
- `server/src/workflow-plugin-api.ts`：插件导入、manifest 校验、节点图 API、Skill/response 生命周期。
- `server/src/workflow-skill.ts`：SKILL.md 生成、读写、自定义版本保护。
- `server/src/workflow-response.ts`：response.json 默认协议、占位符白名单、协议校验和渲染。

## 统一分析模型

新增内部 `PluginAnalysis` 数据结构，区分事实、建议和置信度：

```ts
interface PluginAnalysis {
  workflow: {
    format: 'api' | 'ui';
    nodeCount: number;
    sourceFingerprint: string;
  };
  purpose: {
    name: string;
    description: string;
    capabilities: string[];
  };
  inputs: Array<{
    candidate: WorkflowInput;
    confidence: number;
    reason: string;
    recommended: boolean;
  }>;
  outputs: Array<{
    candidate: WorkflowOutput;
    confidence: number;
    reason: string;
    recommended: boolean;
  }>;
  widgets: Array<{
    field: WorkflowGraphField;
    exposure: 'llm' | 'fixed' | 'hidden' | 'review';
    reason: string;
    confidence: number;
  }>;
  response: {
    recommendedPromptVisibility: boolean;
    blocks: Array<{
      source: string;
      timing: 'submit' | 'complete' | 'always';
      format: 'plain' | 'markdown' | 'code';
    }>;
  };
}
```

实际保存前由后端将已确认的候选转换为合法 `WorkflowSpec`，再次执行现有 manifest 和 response 校验。

## 生成流程

```text
原始 workflow
  → 现有 normalize/introspect/graph
  → PluginAnalysis
  → plugin-creator LLM 语义建议
  → 前端差异预览
  → 用户确认
  → 后端组装并校验 manifest
  → 生成/保留 SKILL.md
  → 生成/保留 response.json
  → 原子保存并刷新缓存
```

## API 方向

新增建议接口：

```http
POST /api/plugins/:id/analyze
```

返回未落盘的 `PluginAnalysis` 或可确认的配置草案。

新增确认接口或扩展保存接口：

```http
POST /api/plugins/:id/configure
```

请求包含用户确认后的配置草案及明确的 Skill/response 覆盖策略。后端执行：

1. 校验 workflow 来源仍存在。
2. 校验所有 nodeId、field、type、applyTo、输入输出映射。
3. 生成 manifest。
4. 生成或保留 SKILL.md。
5. 生成或保留 response.json。
6. 所有校验通过后原子写入；失败时不写入任何目标文件。

现有 `PUT /api/plugins/:id`、Skill API 和 response API 保持兼容。

## LLM 输入边界

`plugin-creator` 接收：

- 原始 workflow 的安全摘要或归一化节点图，而不是无上限原始 JSON。
- 当前 manifest（若存在）。
- 节点 graph 和 object_info 字段定义。
- 输入/输出候选及其结构事实。

LLM 可以建议：

- 插件名称和描述。
- 输入/输出语义和用途。
- 哪些 widget 暴露给 LLM。
- 哪些 widget 固定或隐藏。
- 回复协议展示来源和时机。

LLM 不可改变：

- 不存在的 nodeId/field。
- 连接字段的可编辑性。
- 字段原始类型。
- applyTo 的图结构约束。
- response 占位符安全白名单。
- 产物必须在气泡外展示的约束。

## 兼容和覆盖策略

- 第一期重命名后保留现有 `runPluginSkillCreator` 行为，避免影响已有插件。
- 分析建议默认只生成预览，不修改任何文件。
- 已有自定义 Skill/response 默认保留。
- 用户必须明确选择“覆盖自定义 Skill/response”后才能覆盖。
- imported plugin 没有有效 manifest 时继续遵循当前不可用规则，直到用户确认配置。
- 重识别仍不自动写入，分析结果也不自动写入。

## 错误处理

- workflow 无效、ComfyUI object_info 不可用或节点无法转换：返回可读诊断，不生成保存请求。
- LLM 返回非法结构：丢弃建议并保留当前配置。
- 用户确认后的结构校验失败：返回字段级错误，不写入 manifest、Skill 或 response。
- 多文件保存失败：采用临时文件和 rename；保存流程需要在写入前完成全部校验。

## 测试边界

必须覆盖：

- API/UI workflow 都能生成分析输入。
- 子图、Set/Get 和死节点处理结果与现有 normalizer 一致。
- connected widget 不会被建议为可暴露参数。
- `llm:false` 参数不进入 Skill 或 response 来源。
- 非法 nodeId/field/type/applyTo 被拒绝。
- 建议接口不会写入 manifest、Skill 或 response。
- 确认保存成功后生成完整配置。
- 任意一步校验失败时目标文件保持原样。
- 自定义 Skill/response 默认不被覆盖。
- plugin-creator 重命名后的路径、提示词和错误信息一致。
