---
name: image_seedvr2_upscale
description: 本地运行：SeedVR2 扩散模型图像高清放大（4K 级）。需安装 numz/ComfyUI-SeedVR2_VideoUpscaler 与 TTPlanetPig/Comfyui_TTP_Tools
---

# SeedVR2 图像放大

> 本文件由 server/src/workflow-skill.ts 自动生成，勿手工编辑；修改插件 manifest 或重新识别后会自动重新生成。

## 用途

本地运行：SeedVR2 扩散模型图像高清放大（4K 级）。需安装 numz/ComfyUI-SeedVR2_VideoUpscaler 与 TTPlanetPig/Comfyui_TTP_Toolset 自定义节点，模型权重首次使用自动下载到 models/SEEDVR2。

## 输入

- **参考图**（类型 图像；默认值非空（模板内置））

## 可控制参数

以下参数可由 LLM 通过 `generation.submit` 的 `params` 调整（键为参数 id）：

- **随机种子**（id `seed-14`；类型 整数；默认 42）

## 输出

- **Preview Image**（图像）

## 使用规则

- 本工作流不接受提示词，仅用于图像放大/增强等处理任务；必须通过 `images` 传入参考素材。
