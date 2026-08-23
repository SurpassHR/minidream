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

- **text**（id `text-551`；类型 文本；默认 (illustration:-1), (anime:-1), (pubic hair:-1), (water drop:-1), (fluid on body:-1), (extra hands:-1), (ribs:-1), (ass:-1), (on stomach:-1), ）
  - 负面提示词，tag，例如: (anime:-1)，表示禁止产生动漫风格图像
- **text**（id `text-555`；类型 文本；默认 Environment: An American tour bus; outside, crowds are celebrating and parading.

Foreground: The side of the bus, with the word "TOUR" written on it.

Middle ground: A woman's upper body is leaning out of the window; she is wearing a mini-bikini and has large, soft, and bouncy breasts.

Character: The woman is cheering with one hand extended outside, her face beaming with excitement and a wide smile; her mouth is open as if shouting "woo," and she is looking down at the crowd, preparing to high-five them.

Composition: A side-view perspective; on the left, male onlookers outside are cheering with their hands raised high; on the right, the camera angle is close to the bus body, capturing the woman leaning out of the window.）
  - 正面提示词，自然语言
- **value**（id `value-582`；类型 整数；默认 1024）
  - 图像宽度
- **value**（id `value-583`；类型 整数；默认 1536）
  - 图像高度

## 输出

- **Preview Image**（图像）

## 使用规则

- 按提示词直接生成即可，无额外素材要求。
