---
name: video-minimax-h3-r2v
description: 参考图生成视频工作流
---

# video-minimax-h3-r2v

## 用途
使用 Minimax H3 模型配合参考图生成创意视频。工作流支持两路参考图输入，结合文本提示词，生成符合参考图风格与内容要求的视频片段。适合漫画风格动画、角色动作演绎、场景转场等创意视频制作。

## 输入
- **参考图 1**：作为第一路参考帧输入，控制视频主体形象与风格走向。
- **提示词**：文本描述视频内容、运镜、转场及画面细节。
- **参考图 2**：作为第二路参考帧输入，与参考图 1 共同约束画面元素。

## 可控制参数
| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| unet_name | combo | MINIMAX/H3/minimax_h3_ref2va_pruned_int8_convrot.safetensors | 使用的生成模型文件，支持 MINIMAX/H3、FLUX/KLEIN、IDEOGRAM4、KREA2、QWEN、SEEDVR2、Z、ANIMA 系列模型 |
| aspect_ratio | combo | 16:9 (Widescreen) | 视频纵横比：1:1、2:3、3:2、3:4、4:3、9:16、16:9、21:9 |
| megapixels | FLOAT | 0.4 | 视频分辨率（百万像素），范围 0.1~16，步长 0.1 |
| noise_seed | INT | 261662374822964 | 随机种子，控制生成随机性 |
| value (Duration) | FLOAT | 5 | 视频时长（秒），步长 0.1 |
| value (Prompt) | STRING | 默认漫画风示例 | 视频内容详细提示词，支持多镜头切换与镜头运动描述 |
| image (LoadImage) | combo | mecha_dragon_lightning.png | 从预设图片池中选择第二路参考图 |
| strength_model | FLOAT | 1 | 模型强度，范围 -100~100，步长 0.01 |
| bypass-115 | BOOLEAN | false | 跳过分辨率选择节点 |
| bypass-129 | BOOLEAN | false | 跳过随机噪声节点 |
| bypass-132 | BOOLEAN | false | 跳过多 Float 节点（时长） |
| bypass-138 | BOOLEAN | false | 跳过提示词文本节点 |
| bypass-139 | BOOLEAN | false | 跳过图片加载节点 |
| bypass-145 | BOOLEAN | false | 跳过 LoRA 模型加载节点 |

## 输出
- **SaveVideo**：生成的视频文件，包含参考图形象驱动的动态画面。

## 使用规则
1. 所有输入与参数均可在调用时覆盖默认值，未提供的参数使用默认配置。
2. 两路参考图（参考图 1 与参考图 2）分别对应提示词中的 `<Picture 1>` 与 `<Picture 2>` 占位符，用于指定画面参考帧。
3. 提示词支持多镜头（CUT）与转场（TRANSITION）描述，可使用 `<Audio 1>` 占位符引用音频。
4. 模型选择（unet_name）需保持默认值或从选项列表中选取，任选其一生效。
5. 纵横比（aspect_ratio）与百万像素（megapixels）共同决定最终视频尺寸。
6. 视频时长由 value (Duration) 控制，范围无硬性限制，但建议设定合理秒数。
7. 图片参考参数（image）应从 options 列表中选取，默认为 `mecha_dragon_lightning.png`。
8. 所有 bypass 参数默认关闭（false），设为 true 时对应节点及其失效分支不参与生成。
9. 输出为单个视频文件，需提供保存路径或文件名。
