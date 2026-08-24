---
name: video-minimax-h3-r2v
description: 本地运行：MiniMax H3 参考图/参考视频生成（r2v，含原生音频）。需 comfyui-minimax-h3 节点与 H3 模型权重。
response:
  thinking: collapsed
  prompt: visible
  route: visible
  result: outside-bubble
---

# MiniMax H3 参考图生视频

> 本文件由 server/src/workflow-skill.ts 自动生成，勿手工编辑；修改插件 manifest 或重新识别后会自动重新生成。

## 用途

本地运行：MiniMax H3 参考图/参考视频生成（r2v，含原生音频）。需 comfyui-minimax-h3 节点与 H3 模型权重。

## 输入

- **参考图**（类型 图像；必传）
- **提示词**（类型 文本）
- **参考图**（类型 图像；必传）

## 可控制参数

以下参数可由 LLM 通过 `generation.submit` 的 `params` 调整（键为参数 id）：

无（该工作流的 widget 由模板固定，不可由 LLM 调整）

## 输出

- **SaveVideo**（视频）

## 回复协议

- 用户可在回复协议编辑器中配置思维链、widget 值、提示词、路由和结果摘要的显示方式；不要自行重复结构化展示内容。
- 回复协议支持普通文本、可折叠容器、Markdown 和代码块组合；不输出无意义的生成状态句，生成的视频始终在对话气泡外展示。

## 使用规则

- 必须按顺序传入 2 张参考图（`generation.submit` 的 `images` 参数）。
