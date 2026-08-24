---
name: video-minimax-h3-r2v
description: 本地运行：MiniMax H3 参考图/参考视频生成（r2v，含原生音频）。需 comfyui-minimax-h3 节点与 H3 模型权重。
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

## 使用规则

- 必须按顺序传入 2 张参考图（`generation.submit` 的 `images` 参数）。
