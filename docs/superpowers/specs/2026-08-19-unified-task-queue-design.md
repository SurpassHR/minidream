# Ollama 与 ComfyUI 统一任务队列设计

## 状态

已由用户批准设计，待规格审阅后进入实施计划。

## 背景与现状

当前项目已有 `src/generation/queue.ts`，但它是面向画布 `generation` 节点的 ComfyUI 专用内存队列：

- `/api/generation/submit` 提交后写入 `Map<string, GenTask>`，以 generation node id 去重；
- worker 串行执行 ComfyUI workflow、等待历史完成、下载结果并写回图；
- WebSocket 只广播 `generation` 事件；
- 队列状态不落盘，服务重启或项目切换重建 `GenerationQueue` 后，排队/运行状态消失；
- 物体设计器的参考图生成直接等待 ComfyUI，不经过该队列；
- Ollama 图像转提示词、图片 caption、RAG embedding 都在请求处理函数中直接调用，没有统一调度；
- 前端已有底部 `GenQueue`，但只展示 ComfyUI 生成任务，没有顶栏中与素材库并列的任务入口。

因此，现状并不是“只有 Ollama 任务能进队列”，而是相反：目前只有部分 ComfyUI 画布生成任务能进队列，Ollama 与设计器 ComfyUI 任务都可能并发执行并造成资源争抢。

## 目标

建立一个全局、串行、持久化的任务调度器，第一版统一管理 Ollama 与 ComfyUI 的重型任务；服务重启不丢排队任务，运行中任务不被静默重复执行；前端提供与素材库并列的任务队列抽屉，并通过统一 REST/WS 状态呈现。

## 非目标

- 第一版不把 Agent/pi 对话纳入队列。Agent 对话仍保持当前 SSE 实时流式体验。
- 不把 Ollama `/api/tags` 模型列表、Ollama health、ComfyUI health 这类短探针纳入队列。
- 不实现多 worker、优先级调度、定时任务、跨进程分布式锁或任务依赖图。
- 不改变素材库的存储模型。

## 任务范围

统一队列接受以下任务类型：

| kind | 来源 | 执行内容 | 结果 |
|---|---|---|---|
| `comfy-generation` | 画布 `/api/generation/submit` | generation 节点 workflow 提交、等待、下载、图回填 | 视频与末帧路径或生成任务状态 |
| `comfy-design` | 物体设计器 `/api/designs/:id/generate` | 设计对象参考图 workflow 提交、等待、下载、素材入库、设计状态回填 | 设计对象与素材记录 |
| `ollama-vision` | `/api/ollama/image-to-prompt`、`/api/assets/:id/caption`、视觉降级 | Ollama 图片理解 | prompt/caption 文本 |
| `ollama-embedding` | Story Board RAG 检索 | Ollama 文本向量计算 | embedding 向量，供当前 RAG 请求继续检索 |

任务的业务接口在入队后仍等待任务结果并返回原有业务响应，避免一次性破坏现有前端协议；队列只负责调度和状态可见性，不把业务结果改成未知的异步协议。请求等待期间不会同步阻塞 Node.js event loop，后续任务会在同一个 worker 中排队执行。

## 任务生命周期

```text
queued -> running -> success
queued -> cancelled
running -> failed
running -> interrupted  (服务启动恢复时)
interrupted -> queued     (用户点击重试)
failed -> queued           (用户点击重试)
```

约束：

- `queued` 任务可取消；`running` 不承诺强制中止外部 Ollama/ComfyUI 请求，取消按钮不对运行中任务显示为可用。
- `interrupted` 表示服务重启时原任务可能已向外部服务提交，系统不自动重试，避免生成副作用重复；用户显式重试后才重新执行。
- `failed` 保留错误文本和失败时间，可手动重试。
- 终态任务保留在历史列表中，前端默认按最近更新时间倒序展示；后续可再增加清理策略，本版不自动删除。

## 持久化与恢复

任务记录保存到用户级 `~/.director/task-queue.json`，因为任务队列与全局素材库、设置相同，且需要跨项目切换显示。写入使用 `tmp` 文件再 `rename` 的原子模式，确保进程退出时不会留下半个 JSON。

任务记录至少包含：

```ts
interface TaskRecord {
  id: string;
  kind: 'comfy-generation' | 'comfy-design' | 'ollama-vision' | 'ollama-embedding';
  label: string;
  status: 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'interrupted';
  projectDir?: string;
  progress: number;
  createdAt: number;
  startedAt?: number;
  updatedAt: number;
  finishedAt?: number;
  error?: string;
  payload: Record<string, unknown>;
  result?: Record<string, unknown>;
}
```

- `payload` 只保存可序列化的业务定位信息（例如 projectDir + nodeId、assetId、designId、RAG board/query），不保存 Promise、文件句柄或图片二进制。
- 队列构造时读取记录；所有原为 `running` 的记录先改成 `interrupted` 并原子写回；原为 `queued` 的记录保留并自动开始排空。
- 任务执行器在运行时重新加载项目图、素材和当前配置；如果资源已不存在，任务进入 `failed` 并保留明确错误。
- 任务列表是全局的，但任务携带 `projectDir`，所以切换项目不会删除或重建队列。

## 调度器边界

新增通用 `TaskQueue`（具体文件名以实施计划为准）负责：

1. `submit(kind, label, payload, executor)`：先持久化 queued 记录，再返回记录与可等待的完成 Promise；
2. 单 worker 排空，保证全局同时最多一个任务；
3. 任务状态变更的原子持久化与 listener 广播；
4. `cancel(id)`、`retry(id)`、`list()`、`get(id)`；
5. 启动恢复与 `interrupted` 处理。

业务执行器负责具体动作：

- Comfy generation 复用当前 workflow、下载、末帧和图回填逻辑；
- Comfy design 把现有设计器路由中的提交/等待/下载/素材入库逻辑移入执行器，路由只做校验、创建任务并等待结果；
- Ollama vision 把当前 `imageToPrompt` 调用包在队列任务中，caption 任务在执行器完成后执行 `upsertAssetText` 与 `setAssetCaption`；
- Ollama embedding 为 RAG 请求创建任务并等待向量，保留现有 RAG 排序与返回格式。

现有 `GenerationQueue` 不再作为第二个 worker。实现应保留 `/api/generation/status`、`/api/generation/queue`、`/api/generation/cancel` 的兼容行为，内部从统一任务记录映射出旧 `GenTask` 结构，避免画布和既有测试一次性迁移。

## API 与事件

新增：

- `GET /api/tasks`：返回全局任务列表；
- `POST /api/tasks/:id/cancel`：取消 queued 任务；
- `POST /api/tasks/:id/retry`：仅允许 `failed` 或 `interrupted`，重新排队并返回任务；
- 统一 WebSocket 事件 `{ type: 'task', task: TaskRecord }`。

现有 generation API 保持路径和主要返回结构。内部通过任务映射兼容旧 `GenTask`，旧接口不暴露 queue 的全部字段。

## 前端交互

- 顶栏在“素材库”旁增加“任务队列”按钮，点击打开同样的非模态抽屉；两个抽屉互斥打开，避免同时占用右侧空间。
- 抽屉显示摘要计数：排队、运行、失败/中断；每条显示类型、业务名称、所属项目、状态、错误和进度。
- `queued` 显示取消按钮；`failed/interrupted` 显示重试按钮；其他状态只读。
- App 启动先 `GET /api/tasks`，WS 收到 `task` 事件后 upsert；断线重连后再次全量同步，防止事件丢失。
- 底部现有生成队列改为使用统一任务数据的兼容摘要，避免出现两套任务状态；不再单独请求或维护 ComfyUI 队列。
- 图像转提示词、caption、设计生成完成后继续按原接口更新各自页面；抽屉提供跨页面的统一可见性。

## 错误与边界行为

- 队列 JSON 损坏时安全回退为空队列并记录错误，不阻止服务器启动；本版不覆盖损坏文件。
- 同一业务对象的重复提交应复用尚未完成的任务：generation 按 `projectDir + nodeId`，design 按 `projectDir + designId`，vision/caption 按业务 asset 与操作类型。embedding 以请求为单位，不做跨请求去重。
- 队列状态落盘失败时不应返回“已提交”；提交 API 返回错误，避免用户以为任务已可靠保存。
- executor 失败必须将任务写为 `failed`，同时让等待该任务的业务请求收到同一错误；worker 继续处理后续 queued 任务。
- 切换项目不会中断全局 worker；正在执行的任务使用提交时保存的 projectDir/payload，不引用后来切换的 `ctx.projectDir`。
- 服务关闭时不主动把 running 标为 success；下次启动统一转换为 interrupted。

## 测试策略

后端：

- TaskQueue 单测：提交先持久化、全局串行、重复提交复用、queued 取消、failed/interrupted 重试、启动恢复、原子文件读写和 worker 继续处理后续任务；
- API 单测：统一任务列表/取消/重试/WS 事件，旧 generation API 结构兼容；
- Ollama 单测：多个 vision/caption/embedding 请求按顺序执行，业务结果保持旧格式；
- Comfy/design 单测：画布生成和设计参考图都进入统一队列，项目切换不丢任务；
- 既有 API、generation、Ollama、design 测试全部回归。

前端：

- `TaskQueue` 组件测试覆盖空态、状态文案、取消/重试按钮和任务类型；
- App 测试覆盖顶栏按钮、抽屉开关互斥、初始任务加载、WS task 更新；
- 保留并调整原 `GenQueue` 测试，验证兼容摘要仍能渲染。

验证命令：

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm --dir web exec tsc --noEmit
```
