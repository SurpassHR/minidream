# 工作流插件与 Schema 映射设计

## 目标

将 ComfyUI 工作流标准化为可配置的后端插件：用户通过界面导入任意 API/UI 格式工作流，使用表单式编辑器手动配置输入、参数和输出映射，为每个映射填写面向 LLM 的 description。新增工作流只需要导入和配置，不需要为每个工作流编写新的后端代码。

## 已确认决策

- 采用表单式映射编辑器，不实现完整节点图编辑器。
- 导入入口为前端上传 JSON 文件。
- 自动 introspection 只负责生成初始映射；用户可以全量覆盖映射。
- 内置工作流和导入工作流统一纳入可编辑清单体系。
- 采用每个插件一个完整清单文件的方案，清单是最终 spec 的事实来源。
- 启用/停用继续使用现有 `settings.plugins.disabled`，不移动到清单文件。

## 架构

### 工作流来源

插件分为两类：

- 内置插件：原始工作流仍位于 `server/workflows/`。没有清单时维持当前自动 introspection 行为；首次编辑后生成清单，之后清单覆盖自动识别结果。
- 导入插件：原始工作流 JSON 保存到 `server/data/workflow-plugins/workflows/<id>.json`，对应清单保存到 `server/data/workflow-plugins/<id>.json`。

原始工作流图和映射清单分离。编辑器只修改清单，不修改原始工作流 JSON。

### 完整插件清单

清单包含完整的 `WorkflowSpec` 以及来源信息：

```jsonc
{
  "id": "my_workflow",
  "name": "我的工作流",
  "description": "面向 LLM 的工作流用途描述",
  "source": {
    "type": "imported",
    "workflowFile": "workflows/my_workflow.json"
  },
  "inputs": [
    {
      "id": "text-6",
      "kind": "text",
      "label": "提示词",
      "description": "画面主体描述，支持自然语言",
      "nodeId": "6",
      "field": "text",
      "required": true,
      "hidden": false,
      "defaultValue": "a cat"
    }
  ],
  "params": [
    {
      "id": "steps-3",
      "label": "采样步数",
      "description": "采样步数，越大细节越多但更慢",
      "nodeId": "3",
      "field": "steps",
      "type": "INT",
      "default": 20,
      "min": 1,
      "max": 150,
      "step": 1,
      "options": [],
      "multiple": false,
      "strengthable": false,
      "applyTo": []
    }
  ],
  "outputs": [
    {
      "id": "images-9",
      "kind": "image",
      "label": "最终图片",
      "description": "工作流生成的最终图像结果",
      "nodeId": "9",
      "classType": "SaveImage"
    }
  ]
}
```

`WorkflowInput`、`WorkflowParam`、`WorkflowOutput` 增加可选 `description` 字段。映射保存已有的 `nodeId`、`field`、类型、范围、选项、`applyTo`、多选等能力。`hidden` 项仍参与运行时注入，但不显示在普通参数面板，也不暴露给 LLM。

### Spec 读取规则

- 导入插件必须从清单读取 spec。
- 内置插件无清单时从现有 `introspectWorkflow()` 生成 spec。
- 内置插件有清单时使用清单作为最终 spec。
- 编辑内置插件时，后端以当前自动 introspection 结果创建初始清单。
- 清单写入后清理现有 spec 缓存。
- 清单损坏时，内置插件回退到自动 introspection 并在管理界面标记异常；导入插件保留原始文件并标记不可用。

### 重新识别

「重新识别」会基于当前原始工作流重新运行 introspection，并与现有清单合并：

- 仍匹配的 `nodeId + field` 保留用户已有的 `description`、`label`、`required` 等手动字段；
- 新识别的映射加入结果；
- 已失效的映射从候选结果中移除；
- 合并结果先返回前端，不自动落盘，用户确认后通过保存操作写入。

## 后端 API

新增接口：

| 路由 | 行为 |
|---|---|
| `POST /api/plugins/import` | 接收 `{ name?, filename?, workflow, overwrite? }`。校验 API/UI 格式，必要时转换 UI 格式，自动 introspection，保存工作流和初始清单。重复 ID 未显式覆盖时返回 409。 |
| `GET /api/plugins` | 返回内置与导入插件的 spec、`source`、`hasManifest`、`enabled`。 |
| `GET /api/plugins/:id/nodes` | 返回编辑器节点/字段候选：节点 ID、class type、标题和字段类型。ComfyUI 不可用时从工作流 JSON 推断。 |
| `PUT /api/plugins/:id` | 校验并原子保存完整清单，清理 spec 缓存。 |
| `POST /api/plugins/:id/redetect` | 重新识别并返回合并后的清单，不自动保存。 |
| `DELETE /api/plugins/:id` | 导入插件删除原始工作流和清单；内置插件只删除清单，恢复自动识别。 |

现有 `GET /api/workflows` 保留，并为每个输入、参数、输出增加 `description`，同时返回 `source`、`hasManifest`、`editable` 等插件元信息。

保存校验至少包括：

- 映射引用的 `nodeId` 存在于工作流；
- 映射引用的 `field` 存在或能由当前节点/object_info 合法解析；
- 输入 kind、参数 type、输出 kind 合法；
- 各分组内映射 ID 唯一；
- 必须保留至少一个可用输出映射；
- 不能保存指向已删除节点的映射。

导入错误使用可读的 400 响应；ID 冲突使用 409；清单校验错误指出具体分组、映射 ID 和原因。

## 前端界面

在现有 `SettingsModal` 插件卡片中增加：

- `导入工作流`：选择 `.json` 文件并上传；成功后自动打开映射编辑器；
- `编辑映射`：打开已有插件的映射编辑器。

新增 `WorkflowMappingModal`，使用三段式表单：

### 输入

可编辑类型（文本/图片/视频）、外部字段名、description、`nodeId + field`、必填开关、隐藏开关，并支持新增、删除。

### 参数

可编辑类型（INT/FLOAT/BOOLEAN/STRING/combo）、外部字段名、description、默认值、范围、步长、选项、`nodeId + field`、隐藏开关，并支持新增、删除。

### 输出

可编辑类型（图片/视频/文本）、外部字段名、description、`nodeId`，并支持隐藏、新增、删除。

节点和字段通过下拉选择，不要求用户盲填 ID。每个节点显示 `nodeId / classType / title`，字段显示字段名和推断类型。

编辑器操作：

- 保存：`PUT /api/plugins/:id`；
- 重新识别：加载 `POST /api/plugins/:id/redetect` 返回结果，用户确认后再保存；
- 取消：丢弃当前编辑内容；
- 前端先校验，后端执行完整校验；
- description 可以为空，不因空值阻止保存。

## LLM 契约

MCP `workflow.list` 使用与 `/api/workflows` 相同的最终 spec，但只暴露面向 LLM 的字段：

- 工作流 `id`、`name`、用途 `description`；
- 非隐藏输入的 `kind`、`label`、`description`、`required`；
- 非隐藏参数的 `id`、`label`、`type`、`description`、必要的默认值/范围/有限选项；
- 非隐藏输出的 `kind`、`label`、`description`。

不向 LLM 暴露底层 `nodeId`、`field`、本地文件路径或内部存储信息。`options` 需限制数量，避免模型列表造成不必要的上下文膨胀。

`generation.submit` 的调用方式保持不变。LLM 先调用 `workflow.list`，再根据描述选择 `workflowId` 和参数；后端仍通过最终 spec 的 `nodeId + field` 完成注入。

## 运行时数据流

```text
上传 JSON
  -> 导入接口校验 API/UI 格式
  -> UI 格式转 API 格式
  -> 自动 introspection 生成初始清单
  -> 保存 workflow JSON + manifest
  -> 前端打开编辑器
  -> 用户修改映射与 description
  -> PUT 保存 manifest
  -> 清理 spec 缓存
  -> /api/workflows 与 MCP workflow.list 读取同一份最终 spec
  -> generation.submit 入队
  -> buildPrompt 按 nodeId + field 注入
  -> ComfyUI 执行并返回产物
```

现有 `buildPrompt()`、TaskQueue、ComfyUI 提交/监听/产物处理链路保持复用，不为具体工作流增加新的代码分支。

## 错误处理与生命周期

- 无效 JSON、非 API/UI 工作流、UI 转换失败：返回 400 和具体原因。
- 重复插件 ID：返回 409；用户确认覆盖后才允许覆盖。
- 指向不存在节点或字段的映射：保存拒绝，并指出具体映射。
- 内置插件删除：只移除清单，原始工作流不变。
- 导入插件清单损坏：保留原始工作流，插件标记不可用，不静默删除。
- ComfyUI 不可用：已保存清单仍可读取和编辑；节点候选从工作流 JSON 兜底。
- 导入和清单保存使用临时文件加 rename 的原子写入方式。

## 测试策略

后端：

- 清单读写、原子保存、损坏清单处理；
- API/UI 两种工作流导入；
- ID 冲突和显式覆盖；
- nodeId/field、类型、唯一 ID 和输出存在性校验；
- 重新识别保留已有手动 description/label/required；
- 内置无清单、内置有清单、导入插件三种 spec 读取路径；
- `workflow.list` 暴露 description/params 并过滤 hidden 项；
- `buildPrompt()`、任务队列和现有生成链路回归测试。

前端：

- 导入成功、冲突确认、错误提示；
- 编辑器加载、增删改映射和取消回滚；
- 节点/字段选择；
- 重新识别结果加载与保存；
- hidden 项不出现在普通参数面板。

验证命令沿用项目现有脚本：

```bash
cd server && pnpm exec tsc --noEmit
cd server && pnpm exec vitest run
cd web && pnpm exec tsc --noEmit && pnpm run build
```

## 范围外

- 不实现完整 ComfyUI 节点图编辑器；
- 不修改原始工作流节点图；
- 不为每个插件新增专用后端代码；
- 不改变现有任务队列和 ComfyUI 状态监听协议；
- 不把启用/停用配置从 `settings.plugins.disabled` 迁移到清单文件。
