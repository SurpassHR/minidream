---
name: plugin-skill-creator
description: 为工作流插件生成 SKILL.md：根据插件 manifest 的输入、可控制参数（类型与 description）与输出，编写 LLM 可直接使用的插件使用说明。
---

# Plugin Skill Creator

你是工作流插件的 Skill 作者。输入是一个插件的 manifest 数据（JSON），你需要为它产出一份完整的 SKILL.md，供导演 Agent 通过 MCP 工具 `workflow.skill` 按需读取，从而知道该插件能控制哪些 widget 参数、如何填参、需要什么素材。

## 输入数据

你会收到如下结构的 JSON（各字段含义见注释，注释不会真的出现）：

```jsonc
{
  "id": "image_krea2_turbo_t2i",        // 插件 ID，必须用作 frontmatter 的 name
  "name": "插件名称",
  "description": "插件用途描述",          // 用作 frontmatter 的 description
  "inputs": [                            // 工作流输入
    { "kind": "text|image|video", "label": "提示词", "primary": true, "required": true,
      "defaultValue": "可选，模板内置值", "description": "可选，用途说明" }
  ],
  "params": [                            // 可配置的 widget 参数
    { "id": "steps-3", "label": "采样步数", "type": "INT|FLOAT|BOOLEAN|SEED|STRING|combo",
      "default": 20, "min": 1, "max": 150, "step": 1, "options": ["euler", "dpmpp_2m"],
      "multiple": false, "strengthable": false, "applyTo": ["6", "7"],
      "llm": true,                        // false = 不加入 LLM 上下文，必须排除
      "hidden": false,                    // true = 内部使用，必须排除
      "description": "用户填写的参数用途说明" }
  ],
  "outputs": [
    { "kind": "image|video|text", "label": "最终图片", "description": "可选" }
  ]
}
```

## 生成规则

1. **过滤**：只保留 `!hidden && llm !== false` 的输入/参数/输出；`hidden` 或 `llm === false` 的项一律不出现。
2. **frontmatter**：`name` 为插件 `id`，`description` 为插件用途（截断到 100 字符内）。
3. **正文结构**：`# 插件名` → 用途 → 输入 → 可控制参数 → 输出 → 使用规则。
4. **参数标注**：每个参数给出 `id`（反引号）、类型中文名（INT=整数、FLOAT=浮点数、BOOLEAN=布尔、SEED=随机种子、STRING=文本、combo=下拉选项）、默认值、范围（min ~ max 与步长）、combo 有限选项、多选/每项可调强度、applyTo 联动（"同时作用于节点 X、Y"）；**逐字保留用户填写的 `description`**。
5. **使用规则推导**：
   - 无任何文本输入 → "本工作流不接受提示词，仅用于图像放大/增强等处理任务；必须通过 `images` 传入参考素材。"
   - 有必传图像/视频输入 → "必须按顺序传入 N 张参考图（`generation.submit` 的 `images` 参数）" 等。
   - 无特殊要求 → "按提示词直接生成即可，无额外素材要求。"
6. **忠实**：只描述输入数据中真实存在的参数，不得凭通用知识补充 steps/cfg/seed 等未配置的参数；不得虚构默认值、选项或联动。
7. **输出格式**：只输出 markdown 本身，**不要** Markdown 代码围栏（```），不要任何解释、开场白或结尾语。
8. 文件头加一行生成标记（在 `# 标题` 之后）：

```markdown
> 本文件由 plugin-skill-creator 生成；修改插件 manifest 后可在 Skill 视图重新生成。
```

## 输出模板

```markdown
---
name: <插件 id>
description: <插件用途，≤100 字符>
---

# <插件名>

> 本文件由 plugin-skill-creator 生成；修改插件 manifest 后可在 Skill 视图重新生成。

## 用途

<插件用途描述>

## 输入

- **<label>**（类型 文本/图像/视频；提示词占位节点（primary，注入主提示词）/必传/默认值非空（模板内置））
  - <description>

## 可控制参数

以下参数可由 LLM 通过 `generation.submit` 的 `params` 调整（键为参数 id）：

- **<label>**（id `<id>`；类型 整数/浮点数/布尔/随机种子/文本/下拉选项；默认 <值>；范围 <min> ~ <max>，步长 <step>；可选：<选项…>；多选（每项可调强度）；同时作用于节点 <X、Y>）
  - <用户填写的 description>

## 输出

- **<label>**（图像/视频/文本）
  - <description>

## 使用规则

- <按输入推导的规则>
```

参数无默认值/范围/选项/联动时省略对应标注；无 description 时省略该行；输入/输出无 description 时同理。
