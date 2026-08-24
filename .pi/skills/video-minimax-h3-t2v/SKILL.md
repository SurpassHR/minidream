---
name: video-minimax-h3-t2v
description: 本地运行：MiniMax H3 文本生成视频（t2v，含原生音频）。需 comfyui-minimax-h3 节点与 H3 模型权重。
response:
  thinking: collapsed
  prompt: visible
  route: visible
  result: outside-bubble
---

# MiniMax H3 文生视频

> 本文件由 server/src/workflow-skill.ts 自动生成，勿手工编辑；修改插件 manifest 或重新识别后会自动重新生成。

## 用途

本地运行：MiniMax H3 文本生成视频（t2v，含原生音频）。需 comfyui-minimax-h3 节点与 H3 模型权重。

## 输入

- **提示词**（类型 文本；默认值非空（模板内置））

## 可控制参数

以下参数可由 LLM 通过 `generation.submit` 的 `params` 调整（键为参数 id）：

- **VAE · 节点 140_sg119**（id `vae_name-140_sg119`；类型 文本；默认 minimax_h3_video_vae_fp16.safetensors）
- **VAE · 节点 140_sg120**（id `vae_name-140_sg120`；类型 文本；默认 minimax_h3_audio_vae_fp32.safetensors）
- **扩散模型 (Diffusion Model)**（id `unet_name-140_sg127`；类型 文本；默认 minimax_h3_fl2va_pruned_int8_convrot.safetensors）
- **CLIP**（id `clip_name-140_sg128`；类型 文本；默认 qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors）
- **LoRA**（id `lora_name-140_sg134`；类型 文本；默认 minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors）

## 输出

- **SaveVideo**（视频）

## 回复协议

- 用户可在回复协议编辑器中配置思维链、widget 值、提示词、路由和结果摘要的显示方式；不要自行重复结构化展示内容。
- 回复协议支持普通文本、可折叠容器、Markdown 和代码块组合；不输出无意义的生成状态句，生成的视频始终在对话气泡外展示。

## 使用规则

- 按提示词直接生成即可，无额外素材要求。
