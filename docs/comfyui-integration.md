# ComfyUI 对接说明（通用 workflow 运行器）

> 更新：2026-08-22
> 结论：**直连本地/远程 ComfyUI 原生 HTTP + WebSocket API，不引入任何第三方 SDK**，
> 并实现「通用 workflow 运行器」——任意 `workflow_api.json` 的输入（图像/视频/文字）
> 与输出（图像/视频/文本）由前后端自动适配，无需写死任何工作流结构。
>
> **真实 ComfyUI（0.33.0 @ 127.0.0.1:55554）已跑通**：SDXL 文生图真实出图（1024×1024 PNG），
> 进度实时推送、完成态渲染、`/comfyui/view` 代理加载均正常。

## 为什么不用 comfyui-sdk / @comfyorg/sdk

| 方案 | 问题 |
|---|---|
| `comfyui-sdk`（zandko，npm） | 个人维护，v0.0.5 **一年未更新**；依赖里拖着腾讯云 COS SDK、lodash、p-queue；进度靠**轮询** `/history`，没有实时流，且不支持取消。功能过剩（连接池/负载均衡/S3 上传） |
| `@comfyorg/sdk`（官方 v2） | 面向 Comfy Cloud / serverless；**本地自托管必须额外跑 `comfy-api-proxy`**（8189 端口）；Comfy Cloud 需要 API key；要求 Node ≥ 22。对本地单机工具过重 |
| **直连原生 API**（本方案） | 零新增依赖（Node 24 内置 WebSocket）；`/prompt` + `/ws` 实时进度 + `/queue` 取消 + `/history` 取结果 + `/view` 取文件，全部原生支持；本地 `127.0.0.1:8188` 或远程服务器都只需改一个环境变量 |

## 自动适配机制（可行性核心）

ComfyUI 的 `/object_info` 返回**每个节点类型的输入定义与类型**。据此做
introspection（`server/src/workflow.ts`），支持两种 workflow 格式：

- **API 格式**（`workflow_api.json`）：节点形如 `{ class_type, inputs }`
- **UI 格式**（LiteGraph，**官方 workflow_templates 仓库**即此格式）：
  `{ nodes: [{ id, type, widgets_values, inputs: [{name, link}] }], links }`，
  运行时用 `/object_info` 转成 API 格式——widget 值按节点输入定义顺序（required+optional）
  映射到字段，link 输入按 `inputs[name] = [originId, slot]`，额外 UI widget
  （如 control_after_generate 的 randomize）不在 schema 里自动剔除。

### 输入识别（前端收集什么，后端往哪里注入）

| 节点类 | 识别为 | 前端表现 | 注入目标 |
|---|---|---|---|
| `CLIPTextEncode` 系列 | 文字 | 用户消息即提示词 | 注入到「正向」节点（标题含 positive/正向/prompt 或占位文本较长者，负向节点跳过） |
| 自定义节点上的 prompt 类 STRING 字段 | 文字 | 同上 | 注入到该节点的 prompt 字段 |
| `LoadImage` / `LoadImageMask` | 图像 | 上传按钮 → 附件 chip | 上传到 `/upload/image`，把返回文件名写进 `inputs.image` |
| `LoadVideo` / `VHS_VideoUpload` | 视频 | 上传按钮（视频文件） | 上传到 `/upload/video`，写进 `inputs.video` |

> **必传探测**：`LoadImage` 的占位文件名在用户机器上不存在——spec 构建时探测
> `/view?type=input`，缺失则标记「必传」，前端显示 `输入·图片·必传` badge 并强制用户上传。

### 参数识别（前端动态生成控件）

白名单字段（`KSampler` 的 seed/steps/cfg/denoise/sampler_name/scheduler、
`EmptyLatentImage` 的 width/height/batch_size 等）+ 任意 `SEED` 类型字段。
类型取自 object_info（INT/FLOAT/BOOLEAN/combo）；object_info 不可用时从值推断
（非整数 number → FLOAT、sampler_name/scheduler → combo 兜底选项）。
`ckpt_name` 等文件名类 combo 不作为参数暴露；`ckpt_name` 为空时自动选第一个已安装 checkpoint。

### 输出识别（结果怎么渲染）

| 节点类 | 识别为 | 渲染 |
|---|---|---|
| `SaveImage` / `PreviewImage` / `SaveAnimatedPNG/WEBP` | 图片 | 图片墙（grid） |
| `VHS_VideoCombine` / `SaveVideo` | 视频 | `<video controls>` |
| `ShowText` / `SaveText` | 文本 | `<pre>` 代码块 |

结果提取以 `/history` 的输出键（`images` / `gifs` / `videos` / `text`）为准，
WS `executed` 事件增量累积，执行结束（`executing node=null`）后用 `/history` 兜底去重。
因此**任意第三方节点**只要走这些输出键就能被识别，无需维护节点清单。

## 架构

```
浏览器 (5173) ──/api/chat──▶ Express (4777)
     │  ▲                     │  1. uploadFile → 上传素材到 ComfyUI
     │  │ SSE                 │  2. buildPrompt → 注入文字/文件名/参数
     └──┴─/api/generate/:id/events  3. submitPrompt → POST /prompt
                                  4. startJob → WS /ws?clientId= 监听实时事件
                                  5. 事件缓冲，SSE 推送（可回放）
图片显示 ──/comfyui/view──▶ 代理 ComfyUI /view（本地/远程均无 CORS）
取消 ──/api/generate/:id/cancel──▶ POST /queue {delete} + /interrupt
```

- **POST /api/chat**：同步完成上传 + 提交，立即返回 `{ stages, jobId, promptId }`。
  stages 结构沿用原中间态（thinking 日志 → task 卡 0/1 → done）。
- **SSE**：`progress`（steps 实时进度）、`queue`（排队数）、`done`（输出列表）、
  `cancelled`、`error`。迟到订阅自动回放已缓冲事件。
- **无真实 WebSocket 时的兜底**：WS 连不上/断开 → 轮询 `/history` 判定完成
  （finalize 带 15 次重试，覆盖快速任务与 history 写入延迟）。

## 新增/改动文件

```
server/src/comfyui.ts       ComfyUI 原生 API 客户端（REST + WS，零依赖）
server/src/workflow.ts      工作流 introspection + UI/API 格式转换 + prompt 构建（自动适配核心）
server/src/jobs.ts          任务管理：事件缓冲、WS→SSE、取消、history 兜底
server/src/index.ts         新路由：/api/workflows、/api/comfyui/status、
                            /api/chat（对接真实生成）、/api/generate/:id/events、
                            /api/generate/:id/cancel、/comfyui/view 代理
server/workflows/txt2img.json       示例：文生图（文字输入 → 图片输出）
server/workflows/img2img.json       示例：图生图（图像输入 → 图片输出）
server/workflows/video-minimax-h3-t2v.json  本地：MiniMax H3 文生视频（t2v，子图模板）
server/workflows/video-minimax-h3-i2v.json  本地：MiniMax H3 图生视频（i2v，子图模板）
server/workflows/video-minimax-h3-r2v.json  本地：MiniMax H3 参考图生视频（r2v，非子图）
server/workflows/image_seedvr2_upscale.json  本地：SeedVR2 图像放大（numz 官方节点 + TTP 分块）
web/src/api.ts              类型与接口（WorkflowSpec / JobEvent / cancel / SSE）
web/src/components/Composer.tsx  工作流选择、动态参数控件、上传附件、必传 badge
web/src/components/ChatView.tsx  实时模式 + 结果渲染（图片墙/视频/文本）
web/src/App.tsx             SSE 事件合并进消息 stages、取消
web/vite.config.ts          proxy 增加 /comfyui
```

## 配置与运行

```bash
# ComfyUI 地址：本地默认 127.0.0.1:8188；远程服务器可指向任意 http(s) 地址
COMFYUI_BASE_URL=http://127.0.0.1:8188 pnpm dev
```

> 本项目**仅使用本地 ComfyUI**，不依赖 Comfy 云端账号（不注入 `COMFY_API_KEY` /
> `COMFY_AUTH_TOKEN` 等云端凭证）。

- 任意 workflow：把 `workflow_api.json` 放进 `server/workflows/`（30s 内自动生效），
  界面的「自动 → 生成偏好」面板会自动列出它的输入/输出 badge 与参数控件。
- 新式官方模板（`templates/` 下）使用 `definitions.subgraphs` 子图：转换时自动展开
  （子图输入按名称解析为外链/实例 widget 值，输出重定向到内部产出节点），
  `PrimitiveString(Multiline)` 承载的提示词同样识别为文字输入。
- MiniMax H3 本地模板需本地安装 `comfyui-minimax-h3` 节点并下载 H3 模型权重
  （diffusion model / qwen3vl text encoder / 视频+音频 VAE / 可选 turbo LoRA，见模板内 Model Links）。
- SeedVR2 图像放大模板需安装 `numz/ComfyUI-SeedVR2_VideoUpscaler` 与
  `TTPlanetPig/Comfyui_TTP_Toolset` 自定义节点，模型权重首次使用自动下载到 `models/SEEDVR2`。
- 图片经 `/comfyui/view` 由服务端代理返回，远程 ComfyUI 也不存在 CORS 问题。
- 视频 workflow（Wan/Hunyuan 等）同样支持：识别 `VHS_VideoCombine` 输出即可，
  只需你有对应的 workflow 文件与模型。

## 测试

```bash
cd server && pnpm test     # workflow 引擎单测（9 个：API/UI 格式转换、introspection、探测、注入）
cd web && pnpm build       # 前端 tsc + vite 构建
```

端到端已用 mock ComfyUI 验证：本地工作流（txt2img 出图 / img2img 参考图必传）
提交 → 实时进度 → done 输出 → /view 取图/取视频 → 取消。

**真实 ComfyUI 验证（2026-08-22，0.33.0 @ 55554）**：
- SDXL 文生图真实出图：`director_workbench_00001.png`（1024×1024），SSE 进度 5%→100%，
  done 事件带图片输出，浏览器 `<figure><img>` 经 `/comfyui/view` 正常加载；
