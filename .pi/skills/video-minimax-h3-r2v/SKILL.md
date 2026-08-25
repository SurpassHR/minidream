---
name: video-minimax-h3-r2v
description: 工作流插件 video-minimax-h3-r2v
---

# video-minimax-h3-r2v

> 本文件由 server/src/workflow-skill.ts 自动生成，勿手工编辑；修改插件 manifest 或重新识别后会自动重新生成。

## 用途

工作流插件 video-minimax-h3-r2v

## 输入

- **参考图**（类型 图像；默认值非空（模板内置））
- **提示词**（类型 文本；默认值非空（模板内置））
- **参考图**（类型 图像；默认值非空（模板内置））

## 可控制参数

以下参数可由 LLM 通过 `generation.submit` 的 `params` 调整（键为参数 id）：

无（该工作流的 widget 由模板固定，不可由 LLM 调整）

## 输出

- **SaveVideo**（视频）

## 使用规则

- 按提示词直接生成即可，无额外素材要求。
