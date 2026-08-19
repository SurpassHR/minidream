# Ollama 与 ComfyUI 统一任务队列 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans (inline execution is acceptable when the user chooses it). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用一个全局串行、持久化的任务调度器统一承载 Ollama 视觉/Embedding 与 ComfyUI 生成，并在前端提供与素材库并列的任务队列抽屉。

**Architecture:** `TaskQueue` 负责用户级 JSON 持久化、状态机、单 worker、恢复和事件；任务执行器按 `kind` 注册，业务路由只负责校验、提交任务并等待结果。旧 generation API 保留，通过适配器将统一任务映射为原有 `GenTask`；前端用 `/api/tasks` 全量同步、WebSocket `task` 事件增量同步，任务抽屉与素材库抽屉互斥打开。

**Tech Stack:** TypeScript、Node.js `fs` 原子写入、Fastify、WebSocket、React、Zustand、Vitest、Testing Library；不新增依赖。

**Spec:** `docs/superpowers/specs/2026-08-19-unified-task-queue-design.md`

## Global Constraints

- 第一版只纳入 Ollama 与 ComfyUI，Agent/pi 对话保持 SSE 实时流式。
- 全局并发为 1；同一时刻最多执行一个重型任务。
- `queued` 自动恢复；启动时原 `running` 必须转为 `interrupted`，不自动重试。
- 任务记录保存到用户级 `~/.director/task-queue.json`，采用临时文件 + rename 原子写入。
- 旧 `/api/generation/*` API 和画布生成行为保持兼容。
- 不新增 npm 依赖，不提交用户未要求的 git commit。

---

## 文件地图

### 新建

- `src/tasks/queue.ts`：通用任务记录、状态机、持久化、单 worker、恢复和等待 Promise。
- `src/tasks/queue.test.ts`：任务队列纯行为测试，使用注入的临时 JSON 路径。
- `src/tasks/handlers.ts`：按任务 kind 注册 ComfyUI、Ollama vision、Ollama embedding 执行器。
- `src/tasks/handlers.test.ts`：执行器输入/输出与业务副作用测试。
- `src/design/runner.ts`：从设计器路由抽取的 ComfyUI 参考图生成执行逻辑。
- `web/src/panels/TaskQueue.tsx`：任务队列抽屉内容和任务状态操作。
- `web/src/panels/task-queue.test.tsx`：任务抽屉组件测试。

### 修改

- `src/types.ts`：加入后端 `TaskKind`、`TaskStatus`、`TaskRecord`。
- `src/index.ts`：创建一次全局 `TaskQueue`，注册 handler，启动恢复；项目切换不重建队列。
- `src/api/routes.ts`：ProjectContext 改为持有统一队列；新增任务 API；改造 generation/design/Ollama/RAG 调用；保留兼容接口。
- `src/api/ws.ts`：订阅队列实例并广播统一 `task` 事件。
- `src/generation/queue.ts`：提取/保留 generation 业务执行器与旧 `GenTask` 适配，不再创建独立 worker。
- `src/generation/queue.test.ts`：改用统一队列注入，保留生成回填、失败和串行行为断言。
- `src/story/rag.ts`：允许 embedding 调用由队列提交器提供，保持现有检索返回结构。
- `src/mcp/server.ts`、`src/mcp/server.test.ts`：生成 MCP 工具改用 ProjectContext 的统一 generation 适配方法。
- `src/api/api.test.ts`、`src/api/ollama-api.test.ts`、`src/api/design-api.test.ts`：补充统一任务 API、任务入队和旧协议回归断言。
- `web/src/types.ts`：镜像任务类型和 WS `task` 事件。
- `web/src/api/client.ts`：新增任务列表、取消、重试客户端方法。
- `web/src/store/graph.ts`：增加全局任务 Map 和 `replaceTasks/upsertTask`；保留 generation 兼容状态供底部摘要使用。
- `web/src/api/ws.ts`：转发 `task` 事件和断线重连后的同步回调。
- `web/src/App.tsx`、`web/src/App.css`：顶栏任务队列按钮、抽屉互斥、初始加载、底部摘要复用统一任务。
- `web/src/App.test.tsx`、`web/src/panels/bottom.test.tsx`：布局与兼容摘要测试。

---

## Task 1: 建立持久化串行 TaskQueue 核心

**Files:**
- Create: `src/tasks/queue.ts`
- Create: `src/tasks/queue.test.ts`
- Modify: `src/types.ts`

**Interfaces:**

```ts
export type TaskKind = 'comfy-generation' | 'comfy-design' | 'ollama-vision' | 'ollama-embedding';
export type TaskStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'interrupted';
export interface TaskRecord {
  id: string;
  kind: TaskKind;
  label: string;
  status: TaskStatus;
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
export type TaskHandler = (task: TaskRecord) => Promise<Record<string, unknown> | undefined>;
```

`TaskQueue` 必须提供：

```ts
constructor(opts?: { filePath?: string; autoStart?: boolean });
register(kind: TaskKind, handler: TaskHandler): void;
start(): void;
submit(input: {
  kind: TaskKind; label: string; projectDir?: string;
  payload: Record<string, unknown>; dedupeKey?: string;
}): { task: TaskRecord; completion: Promise<TaskRecord> };
list(): TaskRecord[];
get(id: string): TaskRecord | null;
wait(id: string): Promise<TaskRecord>;
cancel(id: string): boolean;
retry(id: string): { task: TaskRecord; completion: Promise<TaskRecord> } | null;
subscribe(fn: (task: TaskRecord) => void): () => void;
```

- [ ] **Step 1: 写失败测试，证明提交先落盘、单 worker 串行、重复提交复用。**

```ts
it('submit 先持久化 queued，且同 dedupeKey 不重复创建任务', () => {
  const q = new TaskQueue({ filePath });
  q.register('ollama-vision', async () => ({ prompt: 'ok' }));
  const first = q.submit({ kind: 'ollama-vision', label: '图像转描述', payload: { assetId: 'a1' }, dedupeKey: 'vision:a1' });
  expect(JSON.parse(readFileSync(filePath, 'utf8')).tasks[0].status).toBe('queued');
  const second = q.submit({ kind: 'ollama-vision', label: '图像转描述', payload: { assetId: 'a1' }, dedupeKey: 'vision:a1' });
  expect(second.task.id).toBe(first.task.id);
});

it('全局只运行一个 handler，前一个结束后才运行下一个', async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const q = new TaskQueue({ filePath });
  q.register('ollama-vision', async (task) => {
    order.push(String(task.payload.name));
    if (task.payload.name === 'one') await gate;
    return {};
  });
  const one = q.submit({ kind: 'ollama-vision', label: 'one', payload: { name: 'one' } });
  const two = q.submit({ kind: 'ollama-vision', label: 'two', payload: { name: 'two' } });
  await Promise.resolve();
  expect(order).toEqual(['one']);
  release();
  await Promise.all([one.completion, two.completion]);
  expect(order).toEqual(['one', 'two']);
});
```

- [ ] **Step 2: 运行测试确认按预期失败。**

Run: `pnpm exec vitest run src/tasks/queue.test.ts`
Expected: FAIL because `src/tasks/queue.ts` and task types do not yet exist.

- [ ] **Step 3: 实现最小核心。**

实现要点：

1. 使用 `~/.director/task-queue.json` 作为默认路径；测试可注入 `filePath`。
2. 文件结构为 `{ version: 1, tasks: TaskRecord[] }`，读取失败返回空队列并 `console.error`，不覆盖损坏文件。
3. 每次状态变更先通过 `${filePath}.tmp` 写完整 JSON，再 `renameSync`。
4. `submit` 先创建 queued 记录、写文件、广播，再用 microtask 启动 `drain`。
5. `drain` 用 `drainPromise` 去重；从最早 queued 任务开始，状态改 running 后执行 handler，成功/失败都写回并继续下一个。
6. handler 缺失时任务变为 failed，错误为 `未注册任务执行器: <kind>`。
7. 构造读取旧记录：running 改 interrupted 并立即保存；queued 保留。`start()` 只允许调用一次，注册 handler 后开始 drain。
8. `wait` 以每个任务 id 的 deferred Promise 返回最终记录；重试创建新的 deferred，并清空旧 error/finishedAt。
9. `cancel` 只接受 queued；`retry` 只接受 failed/interrupted；所有非法状态返回 false/null，不抛异常。

- [ ] **Step 4: 运行核心测试确认通过。**

Run: `pnpm exec vitest run src/tasks/queue.test.ts`
Expected: PASS.

- [ ] **Step 5: 补充恢复、取消、重试、失败后继续和运行中断测试。**

```ts
it('启动时 running 变 interrupted，queued 自动保留', () => {
  writeFileSync(filePath, JSON.stringify({ version: 1, tasks: [
    { id: 'r', kind: 'ollama-vision', label: '运行中', status: 'running', progress: 20, createdAt: 1, startedAt: 2, updatedAt: 2, payload: {} },
    { id: 'q', kind: 'ollama-vision', label: '排队中', status: 'queued', progress: 0, createdAt: 3, updatedAt: 3, payload: {} },
  ] }));
  const q = new TaskQueue({ filePath });
  expect(q.get('r')?.status).toBe('interrupted');
  expect(q.get('q')?.status).toBe('queued');
});

it('失败任务不阻塞后续任务，重试会清除旧错误', async () => {
  const q = new TaskQueue({ filePath });
  let calls = 0;
  q.register('ollama-vision', async (t) => {
    if (t.payload.fail && calls++ === 0) throw new Error('一次失败');
    return {};
  });
  const failed = q.submit({ kind: 'ollama-vision', label: '失败', payload: { fail: true } });
  const next = q.submit({ kind: 'ollama-vision', label: '后续', payload: {} });
  expect((await failed.completion).status).toBe('failed');
  expect((await next.completion).status).toBe('success');
  const retried = q.retry(failed.task.id)!;
  expect((await retried.completion).status).toBe('success');
});
```

- [ ] **Step 6: 运行全部核心测试。**

Run: `pnpm exec vitest run src/tasks/queue.test.ts`
Expected: PASS with persistence/recovery/serialization coverage.

---

## Task 2: 接入 ComfyUI generation 并移除第二个 worker

**Files:**
- Modify: `src/generation/queue.ts`
- Modify: `src/generation/queue.test.ts`
- Modify: `src/index.ts`
- Modify: `src/api/routes.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/mcp/server.test.ts`

**Interfaces:**

- `TaskQueue` produces `TaskRecord` for `comfy-generation` with payload `{ nodeId }` and `projectDir`.
- `GenerationQueue` no longer owns a `Map` or drain loop; retain exported `runGenerationTask(projectDir, nodeId, comfy): Promise<Record<string, unknown>>` and `toGenTask(task): GenTask` compatibility helpers.
- `ProjectContext.queue` becomes `TaskQueue`; `ProjectContext.comfy` remains the current-project health/config client.

- [ ] **Step 1: 写失败测试，证明 generation 通过统一队列且项目切换不重建队列。**

```ts
it('generation 提交产生统一 comfy-generation 任务并保留旧 GenTask 形状', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/generation/submit', payload: { nodeId: genId, confirm: true } });
  expect(res.statusCode).toBe(202);
  expect(res.json().task).toMatchObject({ id: genId, status: 'queued', progress: 0 });
  expect((await app.inject({ method: 'GET', url: '/api/tasks' })).json().tasks[0].kind).toBe('comfy-generation');
});

it('切换项目后全局任务列表仍保留原项目任务', async () => {
  await submitGenerationFromProjectA();
  await switchToProjectB();
  const tasks = (await app.inject({ method: 'GET', url: '/api/tasks' })).json().tasks;
  expect(tasks.some((t: { projectDir: string }) => t.projectDir === projectA)).toBe(true);
});
```

- [ ] **Step 2: 运行测试确认失败。**

Run: `pnpm exec vitest run src/api/api.test.ts src/generation/queue.test.ts`
Expected: FAIL because routes still instantiate/use `GenerationQueue` and `/api/tasks` is absent.

- [ ] **Step 3: 抽取 generation executor 并改造 ProjectContext。**

将现有 `GenerationQueue.runOne` 的 workflow、ComfyUI 等待、下载、末帧、图回填逻辑抽成 `runGenerationTask`；执行器使用 task.payload.nodeId 和 task.projectDir，不读取切换后的 `ctx.projectDir`。`TaskQueue.register('comfy-generation', ...)` 调用该函数并返回 `{ promptId, videoPath, lastFramePath }`。

`buildApp` 只创建一次 `TaskQueue`；`/api/project/switch` 与删除当前项目时只替换 `ctx.projectDir/ctx.comfy`，不替换 `ctx.queue`。旧 generation 路由按 `projectDir + nodeId` 生成 dedupe key，并从统一记录映射 `GenTask`。

MCP 的 `generation.submit/status/cancel` 调用新增的统一 generation 适配函数（提交 payload 中使用当前 `ctx.projectDir`），不再依赖旧队列实例。

- [ ] **Step 4: 运行 generation 与 MCP 回归测试。**

Run: `pnpm exec vitest run src/generation/queue.test.ts src/api/api.test.ts src/mcp/server.test.ts`
Expected: PASS；旧任务状态接口仍返回 `queued/running/success/failed/cancelled`。

---

## Task 3: 接入设计器 ComfyUI 与 Ollama 执行器

**Files:**
- Create: `src/design/runner.ts`
- Create: `src/tasks/handlers.ts`
- Create: `src/tasks/handlers.test.ts`
- Modify: `src/api/routes.ts`
- Modify: `src/story/rag.ts`
- Modify: `src/index.ts`

**Interfaces:**

```ts
export async function runDesignGenerationTask(
  projectDir: string,
  designId: string,
  comfy: ComfyUIClient,
): Promise<Record<string, unknown>>;

export function registerTaskHandlers(queue: TaskQueue): void;
export function submitVisionTask(queue: TaskQueue, input: {
  operation: 'image-to-prompt' | 'caption';
  assetId: string;
  instruction?: string;
}): { task: TaskRecord; completion: Promise<TaskRecord> };
export function submitEmbeddingTask(queue: TaskQueue, input: {
  projectDir: string; model: string; texts: string[];
}): { task: TaskRecord; completion: Promise<TaskRecord> };
```

- [ ] **Step 1: 写失败测试，覆盖四类 executor 及业务副作用。**

```ts
it('ollama vision handler 返回 prompt，caption handler 写入 caption 与 txt 素材', async () => {
  const vision = submitVisionTask(queue, { operation: 'image-to-prompt', assetId: imageId });
  expect((await vision.completion).result?.prompt).toContain('银发精灵骑士');
  const caption = submitVisionTask(queue, { operation: 'caption', assetId: imageId });
  const done = await caption.completion;
  expect(done.result?.caption).toContain('银发精灵骑士');
  expect(listAssets().find((a) => a.id === imageId)?.caption).toContain('银发精灵骑士');
});

it('设计器生成并发提交只创建一个 comfy-design 任务', async () => {
  const firstRequest = a.inject({ method: 'POST', url: `/api/designs/${designId}/generate`, payload: {} });
  const secondRequest = a.inject({ method: 'POST', url: `/api/designs/${designId}/generate`, payload: {} });
  const [first, second] = await Promise.all([firstRequest, secondRequest]);
  expect([first.statusCode, second.statusCode]).toEqual(expect.arrayContaining([200, 200]));
  const tasks = (await a.inject({ method: 'GET', url: '/api/tasks' })).json().tasks as Array<{ id: string; kind: string; payload: { designId?: string } }>;
  expect(tasks.filter((task) => task.kind === 'comfy-design' && task.payload.designId === designId)).toHaveLength(1);
});

it('RAG embedding 通过队列执行但仍返回原有 hits/status', async () => {
  const res = await app.inject({ method: 'POST', url: `/api/story/boards/${boardId}/rag/search`, payload: { query: '北境', topK: 3 } });
  expect(res.json().status).toBe('ok');
  expect(res.json().hits[0].text).toContain('北境');
});
```

- [ ] **Step 2: 运行测试确认失败。**

Run: `pnpm exec vitest run src/tasks/handlers.test.ts src/api/design-api.test.ts src/api/ollama-api.test.ts src/api/story-api.test.ts`
Expected: FAIL because the handler registry and design runner do not exist and routes still call clients directly.

- [ ] **Step 3: 实现 design runner 和 handler registry。**

1. 从 `/api/designs/:id/generate` 抽出模板读取/变量校验之外的提交、等待、下载、素材入库、`updateDesign` 状态回填到 `runDesignGenerationTask`；路由保留输入校验和 ComfyUI health 检查。
2. `comfy-design` handler 使用 `new ComfyUIClient(resolveComfyUrl(task.projectDir!))`，执行 payload.designId。
3. `ollama-vision` handler 读取当前 settings，调用 `OllamaClient.imageToPrompt`；`caption` 操作完成后执行 `upsertAssetText` 和 `setAssetCaption`，返回 caption/prompt。
4. `ollama-embedding` handler 使用 payload 中的 model/texts 调用 `OllamaClient.embed`，返回 `{ embeddings }`。
5. 所有 handler 都只使用 task payload 的项目/资产定位信息，不捕获会随项目切换变化的 `ctx.projectDir`。
6. 用 `dedupeKey` 防止同一图片的 vision/caption 和同一 design 重复提交；embedding 不去重。

- [ ] **Step 4: 把图像转提示词、caption、设计生成改为提交任务并等待 completion。**

路由返回协议保持不变：

- image-to-prompt 仍返回 `{ prompt, assetId }`；
- caption 仍返回 `{ caption, asset }`；
- design generate 仍返回 `{ design }`；
- handler 失败时路由沿用现有 `DirectorError` → 400 映射。

- [ ] **Step 5: 改造 RAG 为可注入 embedding 提交器并运行测试。**

`ragSearch` 增加可选的 `embedTexts?: (texts: string[]) => Promise<number[][]>` 参数；缺省时保持原始直接客户端行为，路由调用时传入 `submitEmbeddingTask(...).completion` 的等待函数。这样 RAG 的分块、余弦排序、`unconfigured/error` 返回结构不变，只有 embedding 进入统一 worker。

Run: `pnpm exec vitest run src/tasks/handlers.test.ts src/api/design-api.test.ts src/api/ollama-api.test.ts src/api/story-api.test.ts`
Expected: PASS.

---

## Task 4: 将视觉降级链路和统一任务 REST/WS API 接通

**Files:**
- Modify: `src/api/routes.ts`
- Modify: `src/api/ws.ts`
- Modify: `src/index.ts`
- Modify: `src/api/api.test.ts`
- Modify: `src/api/ollama-api.test.ts`

**Interfaces:**

- New routes:
  - `GET /api/tasks -> { tasks: TaskRecord[] }`
  - `POST /api/tasks/:id/cancel -> { ok: boolean, task?: TaskRecord }`
  - `POST /api/tasks/:id/retry -> { task: TaskRecord }`
- `registerWs(server, getProjectDir, queue)` subscribes to `TaskQueue` and broadcasts `{ type: 'task', task }`.

- [ ] **Step 1: 写失败 API 测试。**

```ts
it('GET /api/tasks 返回全局任务并可取消 queued 任务', async () => {
  const asset = listAssets().find((item) => item.kind === 'img');
  expect(asset).toBeTruthy();
  const request = a.inject({ method: 'POST', url: '/api/ollama/image-to-prompt', payload: { assetId: asset!.id } });
  await new Promise((resolve) => setImmediate(resolve));
  const list = await a.inject({ method: 'GET', url: '/api/tasks' });
  expect(list.statusCode).toBe(200);
  const task = list.json().tasks.find((item: { payload?: { assetId?: string } }) => item.payload?.assetId === asset!.id);
  expect(task).toBeTruthy();
  const cancel = await a.inject({ method: 'POST', url: `/api/tasks/${task.id}/cancel` });
  expect(cancel.statusCode).toBe(200);
  expect(cancel.json().ok).toBe(true);
  await request;
});

it('Ollama 任务失败后可 retry', async () => {
  // 在本测试文件的 mock Ollama /api/chat handler 中加入 forceChatError 开关。
  forceChatError = true;
  const asset = listAssets().find((item) => item.kind === 'img')!;
  const failedResponse = await a.inject({ method: 'POST', url: '/api/ollama/image-to-prompt', payload: { assetId: asset.id } });
  expect(failedResponse.statusCode).toBe(400);
  const failed = (await a.inject({ method: 'GET', url: '/api/tasks' })).json().tasks.find((item: { status: string; payload?: { assetId?: string } }) => item.status === 'failed' && item.payload?.assetId === asset.id);
  expect(failed).toBeTruthy();
  forceChatError = false;
  const retry = await a.inject({ method: 'POST', url: `/api/tasks/${failed.id}/retry` });
  expect(retry.statusCode).toBe(202);
  expect(retry.json().task.status).toBe('queued');
});
```

- [ ] **Step 2: 运行测试确认失败。**

Run: `pnpm exec vitest run src/api/api.test.ts src/api/ollama-api.test.ts`
Expected: FAIL because unified task routes and `task` WS event do not exist.

- [ ] **Step 3: 实现 REST 路由和 WS 订阅。**

任务路由必须放在 project-scoped 前置钩子之外，使未打开项目时仍能查看全局任务。错误映射：不存在 404、状态不允许 409、取消失败返回 `{ ok: false }`。WS 订阅在 `buildApp` 创建 queue 后传入，`close` 时取消订阅；不可用客户端不抛回 worker。

- [ ] **Step 4: 让故事/Agent 视觉 fallback 通过同一 Ollama vision 提交器。**

将 `describeImageFiles`、`describeAssetImages` 改为接收 `TaskQueue`，内部调用 `submitVisionTask` 并等待 completion；原有视觉错误判定、caption 回写和 SSE 输出不变。Agent/pi 本身不进入队列，只是它触发的 Ollama fallback 进入队列。

- [ ] **Step 5: 运行 API/WS 回归测试。**

Run: `pnpm exec vitest run src/api/api.test.ts src/api/ollama-api.test.ts src/api/story-api.test.ts src/mcp/server.test.ts`
Expected: PASS；旧 SSE、Ollama image-to-prompt、caption、RAG 和 MCP generation 测试继续通过。

---

## Task 5: 增加前端任务类型、客户端和状态同步

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api/client.ts`
- Modify: `web/src/store/graph.ts`
- Modify: `web/src/api/ws.ts`

**Interfaces:**

```ts
export type TaskKind = 'comfy-generation' | 'comfy-design' | 'ollama-vision' | 'ollama-embedding';
export type TaskStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'interrupted';
export interface TaskRecord {
  id: string; kind: TaskKind; label: string; status: TaskStatus;
  projectDir?: string; progress: number; createdAt: number; updatedAt: number;
  startedAt?: number; finishedAt?: number; error?: string;
  payload: Record<string, unknown>; result?: Record<string, unknown>;
}
```

`client` 新增：

```ts
listTasks(): Promise<TaskRecord[]>;
cancelTask(id: string): Promise<{ ok: boolean; task?: TaskRecord }>;
retryTask(id: string): Promise<TaskRecord>;
```

`useGraphStore` 新增 `tasks: Map<string, TaskRecord>、replaceTasks(tasks)、upsertTask(task)`；`upsertGenerationTask` 从 task kind/result 映射旧 `GenTask`，供旧底部组件使用。

- [ ] **Step 1: 写前端失败测试。**

```tsx
it('TaskQueue 状态同步将 REST 列表和 WS task 事件合并为同一条记录', async () => {
  // App.test 的 fetch mock 对 /api/tasks 返回 id=task-1 queued，并将 WebSocket mock 保存为 lastSocket。
  render(<App />);
  await waitFor(() => expect(screen.getByTestId('task-queue-count')).toHaveTextContent('1'));
  lastSocket.onmessage?.({ data: JSON.stringify({ type: 'task', task: {
    id: 'task-1', kind: 'ollama-vision', label: '图像转描述', status: 'running', progress: 45,
    createdAt: 1, updatedAt: 2, payload: { assetId: 'a1' },
  } }) });
  expect(await screen.findByText(/45%/)).toBeInTheDocument();
  expect(screen.getAllByText('图像转描述')).toHaveLength(1);
});

it('client.retryTask 发送 POST /api/tasks/:id/retry 并返回 task', async () => {
  await client.retryTask('t1');
  expect(fetch).toHaveBeenCalledWith('/api/tasks/t1/retry', expect.objectContaining({ method: 'POST' }));
});
```

- [ ] **Step 2: 运行测试确认失败。**

Run: `pnpm --dir web exec vitest run src/api/client.test.ts src/App.test.tsx`
Expected: FAIL because task types/client/store methods are absent.

- [ ] **Step 3: 实现类型、客户端和 WS 事件。**

WS `WsEvent` 增加 `{ type: 'task'; task: TaskRecord }`。`connectWs` 增加可选 `onResync` hook，在每次 `onopen` 调用；App 在 hook 中重新请求任务列表，解决断线期间事件丢失。保留既有 `generation` event 解析以兼容服务升级期间的旧事件。

- [ ] **Step 4: 运行前端 API/状态测试。**

Run: `pnpm --dir web exec vitest run src/api/client.test.ts src/App.test.tsx`
Expected: PASS.

---

## Task 6: 实现与素材库并列的 TaskQueue 抽屉

**Files:**
- Create: `web/src/panels/TaskQueue.tsx`
- Create: `web/src/panels/task-queue.test.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.css`
- Modify: `web/src/panels/GenQueue.tsx`
- Modify: `web/src/panels/bottom.test.tsx`
- Modify: `web/src/App.test.tsx`

**Interfaces:**

```tsx
export function TaskQueue(props: {
  tasks: TaskRecord[];
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
}): JSX.Element;
```

- [ ] **Step 1: 写失败组件测试。**

```tsx
it('渲染 queued/running/failed/interrupted/success 任务和操作按钮', () => {
  render(<TaskQueue tasks={fixtures} onCancel={vi.fn()} onRetry={vi.fn()} />);
  expect(screen.getByText('图像转描述')).toBeInTheDocument();
  expect(screen.getByText(/排队中/)).toBeInTheDocument();
  expect(screen.getByText(/运行中/)).toBeInTheDocument();
  expect(screen.getByText(/已中断/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /取消/ }));
  fireEvent.click(screen.getByRole('button', { name: /重试/ }));
  expect(onCancel).toHaveBeenCalledWith('queued-id');
  expect(onRetry).toHaveBeenCalledWith('interrupted-id');
});

it('空任务显示暂无任务，运行任务显示进度条', () => {
  const { rerender } = render(<TaskQueue tasks={[]} onCancel={vi.fn()} onRetry={vi.fn()} />);
  expect(screen.getByText('暂无任务')).toBeInTheDocument();
  rerender(<TaskQueue tasks={[runningFixture]} onCancel={vi.fn()} onRetry={vi.fn()} />);
  expect(screen.getByText(/63%/)).toBeInTheDocument();
});
```

- [ ] **Step 2: 运行测试确认失败。**

Run: `pnpm --dir web exec vitest run src/panels/task-queue.test.tsx`
Expected: FAIL because the component does not exist.

- [ ] **Step 3: 实现任务抽屉内容。**

沿用 `GenQueue` 的 `panel-title/q-row` 视觉语言，不新增图标库。状态中文文案为：排队中、运行中、已完成、失败、已取消、已中断；kind 文案为：视频生成、参考图、图像理解、知识库检索。项目路径只显示 basename，完整路径放 title。按 `updatedAt` 倒序展示；错误文本使用可换行样式。

- [ ] **Step 4: 接入 App 顶栏和互斥抽屉。**

新增 `taskDrawerOpen`；顶栏素材库旁增加 `data-testid="task-queue-toggle"` 的“任务队列”按钮和摘要计数。`openTaskDrawer` 关闭素材抽屉，`openAssetDrawer` 关闭任务抽屉。任务抽屉使用 `data-testid="task-drawer"`，沿用 `asset-drawer` 的非模态结构，不显示 backdrop。

App 挂载时调用 `client.listTasks()`；WS `task` 事件调用 `replace/upsert`；取消/重试调用 client 并立即用返回记录更新 store。启动 WS 的 `onResync` 重新拉取任务，避免断线事件丢失。

- [ ] **Step 5: 让底部 GenQueue 使用统一任务摘要。**

不再从独立 generation 请求取数据；App 从统一 `TaskRecord[]` 过滤 `kind === 'comfy-generation'`，转换为旧 `GenTask` 传入 `GenQueue`。保留底部区域和现有测试，确保画布用户仍能看到生成状态；顶栏抽屉展示全部任务。

- [ ] **Step 6: 运行前端组件和布局测试。**

Run: `pnpm --dir web exec vitest run src/panels/task-queue.test.tsx src/panels/bottom.test.tsx src/App.test.tsx`
Expected: PASS.

---

## Task 7: 全量验证、类型修复和文档同步

**Files:**
- Modify: `src/**/*.test.ts` and `web/src/**/*.test.tsx` only when required by the completed API contract.
- Modify: `docs/superpowers/specs/2026-08-19-unified-task-queue-design.md` only if implementation reveals a confirmed contract correction.

- [ ] **Step 1: 运行后端全量测试。**

Run: `pnpm test`
Expected: all existing and new backend/frontend Vitest suites pass; no task remains in a test-global singleton after teardown.

- [ ] **Step 2: 运行 TypeScript 检查。**

Run: `pnpm exec tsc --noEmit`
Run: `pnpm --dir web exec tsc --noEmit`
Expected: both commands exit 0 with no implicit-any or client/server contract errors.

- [ ] **Step 3: 修复测试发现的契约问题而非放宽断言。**

重点检查：

- ProjectContext 项目切换后 queue 实例身份不变；
- 旧 generation status 的 `id` 仍为 generation node id，而统一任务 id 可不同；
- `/api/tasks` 不被 project-not-open hook 拒绝；
- Ollama 请求等待队列时仍正确清理 story 图片临时目录；
- queue JSON 的 `running` 恢复为 interrupted，不会自动向 ComfyUI/Ollama 重复提交；
- WebSocket 断线重连后 REST 全量同步不会重复渲染任务；
- 前端任务抽屉和素材抽屉互斥且都不阻塞画布。

- [ ] **Step 4: 运行最终定向回归。**

Run: `pnpm exec vitest run src/tasks src/generation src/api/api.test.ts src/api/ollama-api.test.ts src/api/design-api.test.ts src/mcp/server.test.ts`
Run: `pnpm --dir web exec vitest run src/panels/task-queue.test.tsx src/panels/bottom.test.tsx src/App.test.tsx`
Expected: PASS.

- [ ] **Step 5: 汇总变更和剩余边界。**

最终报告必须说明：统一队列现在覆盖的任务 kind、持久化路径、重启恢复行为、未纳入的 Agent/pi、测试命令和任何未实现的 ComfyUI 细粒度进度来源（若仍只有阶段级 0/100）。
