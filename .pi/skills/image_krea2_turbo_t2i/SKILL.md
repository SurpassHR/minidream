---
name: image_krea2_turbo_t2i
description: 文生图工作流
---

# image_krea2_turbo_t2i

> 本文件由 server/src/workflow-skill.ts 自动生成，勿手工编辑；修改插件 manifest 或重新识别后会自动重新生成。

## 用途

文生图工作流

## 输入

- **提示词**（类型 文本）
- **提示词**（类型 文本；提示词占位节点（primary，注入主提示词）；默认值非空（模板内置））

## 可控制参数

以下参数可由 LLM 通过 `generation.submit` 的 `params` 调整（键为参数 id）：

- **text**（id `text-551`；类型 文本）
  - 负面提示词，tag，例如: (anime:-1)，表示禁止产生动漫风格图像
- **text**（id `text-555`；类型 文本）
  - 正面提示词，自然语言
- **value**（id `value-582`；类型 整数；默认 1024）
  - 图像宽度
- **value**（id `value-583`；类型 整数；默认 1536）
  - 图像高度

## 输出

- **Preview Image**（图像）

## 使用规则

- 按提示词直接生成即可，无额外素材要求。
