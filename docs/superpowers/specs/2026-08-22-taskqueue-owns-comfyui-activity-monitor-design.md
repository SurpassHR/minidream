# TaskQueue 接管 ComfyUI 与活动监控设计

## 目标

将项目内的 `TaskQueue` 作为生成任务唯一事实源，直接负责 ComfyUI 的提交、排队、进度、取消与结果收集；同时提供正在进行的会话与生成任务监控，并允许用户终止未完成的会话和任务。

## 已确认决策

- 项目 `TaskQueue` 是唯一任务管理器。
- ComfyUI 只作为底层执行后端；其原生队列不作为第二套业务任务列表暴露给前端。
- 终止会话时同时终止 Agent 对话流，并取消该会话关联的所有未完成生成任务。
- 现有旧 `jobs.ts` API 保留兼容，但降级为 `TaskQueue` 的适配层，不再独立执行任务。
- 不引入数据库或第三方依赖。
- 现有 `tasks.json` 和 `sessions.json` 继续使用 `.tmp + renameSync` 原子写入。

## 现状与问题

目前项目同时存在两条生成路径：

1. `TaskQueue`：通过 MCP `generation.submit` 创建任务，并在队列内部调用 ComfyUI、监听 WebSocket、轮询 `/history`、处理取消。
2. `jobs.ts`：旧的 `generateReply()` 直接调用 ComfyUI `/prompt`，再通过独立的 job Map 和 WebSocket/SSE 跟踪任务。

这会造成重复排队、重复状态、取消语义不一致和监控无法统一。`/api/chat` 的 Agent 子进程也未登记为活动会话，客户端断开时不会主动终止后台 Agent。

## 目标架构

### TaskQueue

`TaskQueue` 对外继续提供现有任务接口，并补充：

- 任务执行上下文支持输入素材（data URL 或已上传文件名）以及 `sessionId`；
- 任务提交后由队列 worker 完成素材上传、workflow prompt 构建、ComfyUI `/prompt` 提交、WebSocket 进度监听、历史结果获取；
- 排队和运行任务都可取消；运行任务通过 `AbortController` 和 ComfyUI `/interrupt` 双重终止；
- 取消后的 executor 即使稍后返回，也不得将任务改写为 completed；
- 支持按 `sessionId` 批量取消未完成任务；
- `task:change` 和 `task:progress` 都能被订阅者收到，并在任务状态变化时持久化。

任务状态仍使用：`queued`、`running`、`completed`、`failed`、`canceled`、`interrupted`。服务重启时原 `running` 任务转为 `interrupted`，不自动重新执行。

### Agent 会话

新增内存中的活动会话注册表：

- Agent 流启动后登记 `sessionId`、用户指令摘要、开始时间、AbortController 和关联任务 ID；
- MCP 任务返回后由聊天请求将任务绑定到当前 `sessionId`；
- Agent 结束、出错、取消或请求断开时注销；
- 会话终止会 abort Agent，并调用 `TaskQueue.cancelBySession(sessionId)`；
- 已写入的助手消息以“已终止”状态落库，不能伪装为正常完成。

活动会话不跨服务重启恢复；活动任务沿用已有 `interrupted` 恢复规则。

### 兼容旧 jobs API

`jobs.ts` 不再直接创建独立执行任务。旧 `/api/generate/:jobId` 快照、事件流和取消接口通过兼容映射访问 TaskQueue 任务，或在普通非流式旧调用中改为提交 TaskQueue 后返回兼容 jobId。前端新路径和 MCP 路径均直接使用 TaskQueue。

## HTTP 与 SSE

新增：

- `GET /api/activity`：返回活动会话和未完成任务的快照；只包含运行中/排队中项目，必要时附带已中断任务用于说明。
- `GET /api/activity/events`：SSE 推送活动新增、进度、完成、失败、取消和会话状态变化。
- `POST /api/sessions/:id/cancel`：幂等终止会话，并联动取消其未完成任务。

保留并统一现有：

- `GET /api/tasks`、`GET /api/tasks/:id`、`POST /api/tasks/:id/cancel`；
- `GET /api/tasks/:id/events`；
- 旧 job 查询/取消接口。

所有活动事件由服务端内存状态和 `TaskQueue` 事件转换而来，不重复读取 ComfyUI 原生业务队列作为第二个来源。

## 前端监控

在主区域增加“运行中”入口和活动面板：

- 显示活动会话数和任务数；
- 会话列表显示指令摘要、运行时长、关联任务数和“终止会话”；
- 任务列表显示类型、工作流、阶段、进度和“取消任务”；
- 面板通过活动 SSE 实时更新，刷新和切换会话后仍可恢复；
- 当前聊天气泡中的任务取消按钮与 Agent 停止按钮复用同一套接口；
- 终止后的状态显示为“已终止/已取消”，并保留消息记录。

## 错误处理

- 未找到任务或会话返回 404。
- 已完成、失败、取消或中断的项目重复终止返回成功但不重复执行副作用，保证幂等。
- ComfyUI 取消调用失败时，若本地任务仍可安全终止，仍将本地状态标记为 canceled，并记录取消失败日志；不允许继续被标记为 completed。
- Agent abort 后只发送一次终止/结束事件；SSE 客户端断开不得导致未捕获异常。

## 测试验收

服务端测试覆盖：

1. TaskQueue 运行中任务可通过 AbortSignal 终止，executor 延迟返回也不会覆盖 canceled 状态；
2. TaskQueue 可按 sessionId 批量取消排队和运行任务；
3. TaskQueue 的进度事件能被独立订阅者收到；
4. Agent Bridge abort 子进程并只发出一次 end；
5. 活动快照、活动 SSE 和会话终止 API 的联动行为；
6. 旧任务取消接口仍可用。

前端验收：

- TypeScript 检查通过；
- Vite build 通过；
- 活动面板能显示并操作会话和任务状态。
