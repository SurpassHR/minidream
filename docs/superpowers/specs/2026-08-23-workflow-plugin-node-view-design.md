# 工作流插件节点视图与参数勾选设计

日期：2026-08-23

## 目标

在现有工作流插件映射编辑器中增加节点视图和表单视图。节点视图解析真实 ComfyUI 工作流，展示节点、字段和连接关系；用户可以勾选普通 widget 参数，让它们进入参数清单。表单视图只展示已勾选的参数，用于填写面向用户和 LLM 的描述及参数配置。

本功能参考 `mmh3-blueprint-demo` 的节点卡片、端口连接线、节点选中和画布缩放交互，但不复用其固定节点定义。节点数据必须由当前 workflow JSON 和 ComfyUI `object_info` 动态生成，以支持任意工作流。

## 已确认的交互规则

- 映射编辑器提供“节点视图”和“表单视图”两个视图。
- 节点视图使用画布 + 节点内字段勾选布局。
- 节点图只读：不支持修改节点、连接关系或保存节点位置。
- 支持画布拖拽平移和滚轮缩放，连接线使用只读 SVG 绘制。
- 输入和输出映射数量及节点结构保持固定，不能通过节点视图新增、删除或改绑。
- 任意节点的普通 widget 字段都可以被勾选。
- 连接到其他节点的字段只显示连接关系，不允许勾选。
- 勾选字段生成一个 `params` 映射；取消勾选后从参数表单和 LLM 契约中移除。
- 现有插件首次进入节点视图时，只恢复当前 manifest 中已有的参数勾选状态，其他字段默认不勾选。
- 取消已配置参数时必须弹出确认，确认后丢弃该参数的 description 和配置值。
- 重新勾选已取消的参数时视为新参数，接受从当前 workflow 字段推导出的默认配置，不恢复历史 description 和参数值。
- 节点视图和表单视图共享同一个本地 draft，切换视图不丢失修改。
- 未勾选参数不出现在表单视图，也不出现在 MCP `workflow.list`。

## 架构方案

采用“后端解析 graph DTO，前端 React/CSS/SVG 展示”的方案。

后端负责复用已有的 UI→API 转换、子图展开、Set/Get 解析和 `object_info` 推断，避免前端重复实现 workflow 语义。前端只消费图 DTO，管理视图状态和清单 draft；最终仍通过现有 `PUT /api/plugins/:id` 保存完整 manifest。

不采用前端直接解析原始 workflow，也不嵌入参考项目 iframe。这样可以保证节点视图看到的字段与实际 `buildPrompt()` 注入字段一致，并让 API/UI 两种 workflow 格式共享同一套解析规则。

## 图数据模型

新增编辑器专用 graph DTO：

```ts
interface WorkflowGraph {
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
}

interface WorkflowGraphNode {
  nodeId: string;
  classType: string;
  title: string;
  x: number;
  y: number;
  fields: WorkflowGraphField[];
}

interface WorkflowGraphField {
  field: string;
  type: string;
  value?: unknown;
  connected: boolean;
  selectable: boolean;
  selected: boolean;
  paramId?: string;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
}

interface WorkflowGraphEdge {
  sourceNode: string;
  sourceField: string;
  targetNode: string;
  targetField: string;
  type?: string;
}
```

解析规则：

- UI 格式先调用现有 `convertUiToApi()` 获取实际执行节点，同时保留原始 `pos` 作为节点位置来源。
- UI `links` 转换为 `sourceNode/sourceField/targetNode/targetField`。
- API 格式直接读取节点输入中的 `[sourceNodeId, sourceSlot]` 连接值。
- API 格式没有坐标时，根据连接关系做确定性的左到右拓扑布局；同层节点按 nodeId 稳定排序。
- 字段集合合并 API 节点已有 `inputs` 和 `object_info` 定义。没有实际值且无法从定义判断为可注入 widget 的字段不作为可选参数。
- `connected: true` 的字段设置 `selectable: false`，只显示连接端口和连接目标。
- 普通 INT、FLOAT、BOOLEAN、STRING、SEED、COMBO widget 设置 `selectable: true`。
- `selected` 按当前 manifest `params` 的 `nodeId + field` 匹配。
- 共享参数（现有采样参数去重并带 `applyTo`）以一个参数项呈现；相关节点字段同步显示为已选，取消时整体取消。
- 未知自定义节点仍显示。ComfyUI 断开时使用 workflow JSON 中的实际值推断基本类型；无法确认是 widget 的字段只读展示。

## 参数选择与清单保存

### 勾选

首次勾选字段时，后端或前端根据 graph field 和 `object_info` 生成完整 `WorkflowParam`：

- `id`：遵循现有 `${field}-${nodeId}` 约定；共享采样参数遵循现有 dedupe 规则。
- `nodeId`、`field`、`type`：由真实字段生成，不由用户填写。
- `default`、`min`、`max`、`step`、`options`：从节点当前值和 `object_info` 推断。
- `label`：使用现有字段标签推断。
- `description`：初始为空。
- `applyTo`：保持现有自动识别语义，由后端生成。

节点视图的勾选只更新本地 draft，不立即写入文件。

### 取消

如果字段对应的参数已经存在，取消勾选前显示确认对话框，内容包含参数 label 和 description。取消操作保持原状态；确认后从 draft.params 删除该参数。删除后该参数的 description、默认值、范围、步长和选项都视为丢弃。

之后再次勾选同一字段时重新生成参数默认配置，不恢复历史编辑内容。

### 保存校验

`PUT /api/plugins/:id` 继续保存完整 manifest，但后端在保存前根据原始 workflow 重新解析 graph，不信任前端传来的结构字段：

- inputs 数量及 `id/kind/nodeId/field/classType` 不可变。
- outputs 数量及 `id/kind/nodeId/classType` 不可变。
- params 可以新增或删除。
- 每个 params 必须对应真实存在且未连接的普通 widget 字段。
- params 的 `id/nodeId/field/type/applyTo` 必须与后端解析结果一致。
- 同一 `nodeId + field` 不得重复。
- 用户可编辑字段仍为 `label/description/hidden/default/min/max/step/options`，并执行现有类型和范围校验。
- 保存基于最新 manifest 校验；结构冲突返回 400，并提示刷新，不能静默覆盖其他窗口的新参数选择。

manifest.params 是唯一的参数勾选状态来源，不额外保存 selection 列表。

## 后端接口

新增：

```text
GET /api/plugins/:id/graph
```

返回：

```json
{
  "graph": {
    "nodes": [],
    "edges": []
  }
}
```

接口行为：

- 使用当前 workflow 原始 JSON、`object_info` 和当前 manifest 生成 graph DTO。
- 内置插件无 manifest 时使用自动识别结果计算当前 selected 状态。
- 导入插件清单损坏时仍允许读取 workflow JSON 并返回未选中参数的图，同时保留错误信息供 UI 展示。
- ComfyUI 不可用时返回 JSON 字段和值推断结果；不能推断的字段标记为不可选。
- 找不到插件返回 404，解析失败返回 400，并携带可读原因。

现有 `GET /api/plugins/:id/nodes` 可以保留兼容，但编辑器节点视图以 `/graph` 为主；不再通过节点下拉框改变映射目标。

## 前端交互

`WorkflowMappingModal` 增加视图切换控件：

### 节点视图

- 节点卡片显示 nodeId、标题和 classType。
- 节点字段显示名称、类型、当前值和状态。
- 可选 widget 显示 checkbox；已选字段显示对应参数标记。
- 连接字段显示端口、连接方向和目标节点，不显示 checkbox。
- 输入/输出字段显示固定映射标记，不允许结构编辑。
- 画布支持拖拽平移和滚轮缩放，SVG 连线随节点布局绘制。
- graph 请求失败时保留表单视图，节点视图显示错误和“重试”按钮。
- 节点较多时先显示节点内容，再绘制连线，不阻塞整个 modal。

### 表单视图

- 输入和输出继续渲染现有固定映射表单。
- 参数列表只遍历当前 `draft.params`，未勾选字段不会出现。
- 参数结构字段 `id/type/nodeId/field/applyTo` 只读。
- 参数配置字段 `label/description/hidden/default/min/max/step/options` 继续可编辑。
- 节点视图勾选和表单视图编辑共享同一个 draft。
- 保存、取消、重新识别沿用现有 modal 生命周期。

## 重新识别

重新识别重新解析 workflow graph 和自动识别结果，但不自动扩大参数选择集合：

- 当前仍匹配的输入、输出映射保留用户描述配置。
- 当前仍匹配的 params 保留用户描述和参数配置。
- 新发现的普通 widget 默认不勾选，不进入 params。
- 已不存在的 params 不自动删除，保存时由结构校验明确提示；用户需要在节点视图中处理对应状态。
- 重新识别结果只更新本地 draft，用户确认保存后才落盘。

## 错误处理

- 无效 workflow、无法转换 UI workflow 或 graph 解析失败返回可读错误。
- `/object_info` 断开不阻止读取和编辑已有清单；字段类型使用 JSON 值兜底。
- 连接字段被前端或客户端伪造为 params 时，后端保存返回 400。
- 伪造节点、字段、类型或 `applyTo` 返回具体参数错误。
- graph 加载失败不影响已有表单编辑和取消操作。
- 关闭 modal 不保存任何 draft。

## 测试范围

后端单元和 API 测试覆盖：

- API/UI workflow 生成 graph DTO。
- UI 节点坐标和连接解析。
- API 无坐标时的稳定拓扑布局。
- widget 字段、连接字段和未知节点的识别。
- 当前 manifest 参数 selected 状态恢复。
- graph 路由及 ComfyUI 断开兜底。
- 勾选字段生成正确默认类型和值。
- 参数取消后保存结果不再包含该参数。
- 取消后重新勾选不会恢复旧 description 和参数值。
- 输入/输出结构锁定仍然有效。
- 参数伪造节点、字段、类型、连接关系和 `applyTo` 被拒绝。
- MCP `workflow.list` 只暴露当前 params 中未 hidden 的参数。

前端测试或类型构建验证覆盖：

- 节点/表单视图切换保留 draft。
- 已有 params 显示为已勾选。
- 取消已配置参数必须确认。
- 用户拒绝确认时参数保持不变。
- 确认后参数从表单消失。
- 重新勾选后参数使用新默认配置。
- graph 加载失败时表单仍可编辑。

## 非目标

- 不修改原始 workflow JSON 的节点或连接。
- 不支持在节点视图中移动节点并保存位置。
- 不支持修改连接、创建节点或删除节点。
- 不允许通过节点视图新增输入或输出映射。
- 不把节点视图扩展为完整 ComfyUI 编辑器。
