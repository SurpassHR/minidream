---
name: image_seedvr2_upscale
description: 工作流插件 image_seedvr2_upscale
---

# image_seedvr2_upscale

> 本文件由 server/src/workflow-skill.ts 自动生成，勿手工编辑；修改插件 manifest 或重新识别后会自动重新生成。

## 用途

工作流插件 image_seedvr2_upscale

## 输入

- **参考图**（类型 图像；默认值非空（模板内置））

## 可控制参数

以下参数可由 LLM 通过 `generation.submit` 的 `params` 调整（键为参数 id）：

- **image**（id `image-17`；类型 下拉选项；默认 pasted/image (237).png；可选：0.png、01.png、02.png、03.png、04.png、05.png、06.png、07.png…）

## 输出

- **Preview Image**（图像）

## 使用规则

- 本工作流不接受提示词，仅用于图像放大/增强等处理任务；必须通过 `images` 传入参考素材。
