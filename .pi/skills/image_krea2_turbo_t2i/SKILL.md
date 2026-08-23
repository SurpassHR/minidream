---
name: image_krea2_turbo_t2i
description: 文生图工作流，将自然语言提示词转换为图像。支持设置正面提示词、负面提示词以及图像尺寸。
metadata:
  plugin_id: image_krea2_turbo_t2i
  plugin_name: image_krea2_turbo_t2i
  plugin_description: 文生图工作流
input_fields:
  - name: 提示词
    type: text
    required: false
    description: 图像生成的主提示词（自然语言描述）。如果为空，将使用默认提示词。
  - name: 提示词（primary）
    type: text
    required: true
    description: 主要的图像生成提示词，描述场景、角色、构图等细节。默认提供了一段示例提示词。
workflow_params:
  - name: 负面提示词
    type: string
    required: false
    description: 负面提示词，使用 tag 格式。例如 (anime:-1) 表示禁止产生动漫风格图像。
  - name: 正面提示词
    type: string
    required: false
    description: 正面提示词，使用自然语言。
  - name: 图像宽度
    type: integer
    default: 1024
    description: 生成图像的宽度（像素）。
  - name: 图像高度
    type: integer
    default: 1536
    description: 生成图像的高度（像素）。
output_fields:
  - name: Preview Image
    type: image
    description: 生成的图像预览。
usage_guide: |
  ## 工作流说明

  这是一个文生图工作流，根据输入的提示词生成对应的图像。

  ## 输入说明

  1. **提示词**：提供生成图像的文本描述。建议使用结构化描述，包含环境（Environment）、前景（Foreground）、中景（Middle ground）、角色（Character）、构图（Composition）等维度。
  2. **提示词（primary）**：主要的提示词输入（必填）。如果"提示词"字段为空，则使用此字段的值。

  ## 参数说明

  - **负面提示词**：用于排除不想要的元素或风格。使用 tag 格式，例如：
    - `(anime:-1)` - 禁止动漫风格
    - `(watermark:-1)` - 禁止水印
    - `(lowres:-1)` - 禁止低分辨率
  - **正面提示词**：额外的正面描述，会与主提示词结合使用。
  - **图像宽度/高度**：控制生成图像的分辨率，单位为像素。

  ## 输出说明

  工作流输出一张生成的图像（Preview Image）。

  ## 使用建议

  1. 提示词越详细，生成效果越符合预期。建议包含场景、主体、动作、视角、氛围等描述。
  2. 若想控制风格，可通过负面提示词排除不想要的风格。
  3. 根据实际需求调整图像宽高比，避免生成后再次裁剪。
---
