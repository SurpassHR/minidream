---
name: image_krea2_turbo_t2i
description: 文生图工作流
---

# image_krea2_turbo_t2i

## 用途

根据正面提示词生成图像，并通过负面提示词控制图像中不应出现的内容。

## 输入
- **Positive Prompt（text）**（id `input-text-555-text`；类型 文本）：正面提示词输入，使用自然语言描述期望生成的图像内容。
- **Negative Prompt（text）**（id `input-text-551-text`；类型 文本）：负面提示词输入，使用标签形式，例如 (anime:-1) 表示禁止产生动漫风格图像。禁止某个标签时必须使用 (<tag>:-1) 格式。
## 可控制参数
- **Width（value）**（id `value-582`；类型 整数）：图像宽度，步长为 1。
- **Height（value）**（id `value-583`；类型 整数）：图像高度，步长为 1。
## 输出
- **Preview Image**（id `images-578`；类型 图像）：生成的图像输出。
## 使用规则

- 正面提示词使用自然语言描述图像内容。
- 负面提示词必须使用 `(<tag>:-1)` 格式来禁止特定标签。
- 通过 Width 和 Height 参数控制输出图像的尺寸。
