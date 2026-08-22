# 本地草稿存储与 ComfyUI 产物拦截 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将图片/视频生成产物从 ComfyUI 临时输出转存到可配置的本地草稿目录，并增加草稿浏览页面。

**Architecture:** 新增 `DraftStore` 管理本地文件和原子索引，`TaskQueue` 完成 ComfyUI 任务后负责下载、转存、替换输出 URL 和清理临时文件。设置、HTTP API、侧栏和前端草稿页面围绕同一个本地草稿索引接入。

**Tech Stack:** Node.js, TypeScript, Express, Vitest, React, Vite, SSE, ComfyUI HTTP API。

**Spec:** `docs/superpowers/specs/2026-08-22-draft-storage-design.md`

## Global Constraints

- 生成最终产物必须由项目本地存储提供，不能依赖 ComfyUI `output` 目录。
- ComfyUI 允许作为短暂中转源，成功转存后必须尽力清理临时文件。
- 存储目录必须是任意绝对路径，默认值为 `server/data/drafts`。
- `TaskQueue` 是唯一任务管理器。
- 设置和草稿索引使用 `.tmp + renameSync` 原子写入。
- 不引入第三方依赖；用户可见文案使用简体中文。

---

### Task 1: DraftStore 与存储设置基础能力

**Files:**
- Modify: `server/src/settings.ts`
- Create: `server/src/drafts.ts`
- Test: `server/src/settings.test.ts`
- Test: `server/src/drafts.test.ts`

**Interfaces:**

```ts
export interface StorageSettings { outputDir: string }
export interface DraftRecord {
  id: string;
  taskId?: string;
  kind: 'image' | 'video' | 'text';
  filename: string;
  path: string;
  mime?: string;
  size: number;
  createdAt: number;
}
export class DraftStore {
  constructor(options: { indexFile: string; outputDir: string });
  list(): DraftRecord[];
  get(id: string): DraftRecord | undefined;
  saveFromBuffer(input: { taskId?: string; kind: DraftRecord['kind']; sourceName: string; mime?: string; data: Buffer }): Promise<DraftRecord>;
  delete(id: string): boolean;
}
```

- [ ] **Step 1: 写绝对路径、目录创建、索引原子写入和删除失败测试**

```ts
it('拒绝相对路径并保存到绝对目录', ...)
it('保存媒体后可从索引读取并删除', ...)
it('输入文件名不会穿越输出目录', ...)
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter server exec vitest run src/drafts.test.ts src/settings.test.ts`

Expected: 因 `DraftStore` 和 `storage` 设置尚未实现而失败。

- [ ] **Step 3: 实现设置和 DraftStore**

新增 `storage.outputDir` 的默认值、读取兼容、更新函数；`DraftStore` 创建目录、生成安全文件名、写文件、原子更新 `drafts.json`、删除物理文件和索引记录。

- [ ] **Step 4: 运行基础测试**

Run: `pnpm --filter server exec vitest run src/drafts.test.ts src/settings.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/src/settings.ts server/src/drafts.ts server/src/settings.test.ts server/src/drafts.test.ts
git commit -m "feat(drafts): 增加本地草稿存储与目录设置"
```

---

### Task 2: TaskQueue 产物转存与 ComfyUI 清理

**Files:**
- Modify: `server/src/tasks/queue.ts`
- Modify: `server/src/tasks/types.ts`
- Modify: `server/src/comfyui.ts`
- Test: `server/src/tasks/queue.test.ts`

**Interfaces:**

```ts
export interface TaskQueueOptions {
  dataFile: string;
  settingsFile?: string;
  drafts?: DraftStore;
  autoStart?: boolean;
  executor?: TaskExecutor;
}
```

- [ ] **Step 1: 写产物转存失败测试**

使用注入的 `DraftStore`/executor 验证：任务输出转为 `/api/drafts/<id>/file`；本地保存失败时任务状态为 `failed`；多个输出全部转存。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter server exec vitest run src/tasks/queue.test.ts`

Expected: 新增断言因队列没有 DraftStore 输出处理而失败。

- [ ] **Step 3: 实现 TaskQueue 转存**

从 `/history` 获得输出后下载 ComfyUI 文件，交给 DraftStore 保存；把输出 URL 改为项目草稿 API；增加 ComfyUI 临时文件删除方法并以 best-effort 调用。保存失败抛出错误，沿用现有失败处理。

- [ ] **Step 4: 运行队列测试**

Run: `pnpm --filter server exec vitest run src/tasks/queue.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/src/tasks/queue.ts server/src/tasks/types.ts server/src/comfyui.ts server/src/tasks/queue.test.ts
git commit -m "feat(tasks): 拦截并转存 ComfyUI 生成产物"
```

---

### Task 3: 服务端草稿和存储设置 API

**Files:**
- Modify: `server/src/index.ts`
- Modify: `web/src/api.ts`
- Test: `server/src/api.test.ts`

**Interfaces:**

```text
GET    /api/drafts
GET    /api/drafts/:id/file
DELETE /api/drafts/:id
POST   /api/settings/storage
```

- [ ] **Step 1: 写 API 失败测试**

测试目录设置保存、草稿列表、草稿文件下载和删除响应。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter server exec vitest run src/api.test.ts`

Expected: 新接口尚未注册而失败。

- [ ] **Step 3: 实现 API**

创建全局 DraftStore；`GET /api/settings` 返回 `storage.outputDir`；保存设置前校验绝对路径并检查目录可写；草稿文件接口使用索引记录的路径并设置媒体类型；删除接口移除文件和索引。

- [ ] **Step 4: 运行 API 测试**

Run: `pnpm --filter server exec vitest run src/api.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/src/index.ts web/src/api.ts server/src/api.test.ts
 git commit -m "feat(api): 增加草稿文件与产物存储设置接口"
```

---

### Task 4: 侧栏草稿入口、草稿页面和设置 Modal

**Files:**
- Modify: `server/src/mock.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/Rail.tsx`
- Create: `web/src/components/DraftsView.tsx`
- Modify: `web/src/components/SettingsModal.tsx`
- Modify: `web/src/App.css`

**Interfaces:**

```ts
fetchDrafts(): Promise<DraftRecord[]>;
deleteDraft(id: string): Promise<void>;
saveStorageSettings(outputDir: string): Promise<StorageSettings>;
```

- [ ] **Step 1: 写前端 API 类型和页面结构**

增加草稿记录类型、接口封装和 `activeNav === 'drafts'` 分支。

- [ ] **Step 2: 实现草稿页面**

图片使用 `img`，视频使用 `video controls`，统一使用 `/api/drafts/:id/file`；删除后更新列表；空状态显示中文提示。

- [ ] **Step 3: 修改侧栏和设置 Modal**

将 `drafts` 插入 `assets` 前；增加“产物存储”设置分类、绝对路径输入、保存和错误提示。

- [ ] **Step 4: 运行前端构建**

Run: `pnpm --filter web build`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/src/mock.ts web/src/App.tsx web/src/components/Rail.tsx web/src/components/DraftsView.tsx web/src/components/SettingsModal.tsx web/src/App.css
 git commit -m "feat(web): 增加草稿媒体页与存储目录设置"
```

---

### Task 5: 全量验证与输出链路检查

**Files:**
- Modify: files identified by failing tests only.

- [ ] **Step 1: 运行服务端类型检查和测试**

Run: `pnpm --filter server exec tsc --noEmit && pnpm --filter server test`

Expected: PASS。

- [ ] **Step 2: 运行前端构建**

Run: `pnpm --filter web build`

Expected: PASS。

- [ ] **Step 3: 检查 ComfyUI 输出引用**

Run: `rg "viewUrl\(|/comfyui/view|submitPrompt\(" server/src/tasks server/src/index.ts server/src/jobs.ts`

Expected: ComfyUI `/view` 仅用于队列内部转存；任务最终 outputs 使用 `/api/drafts/:id/file`。

- [ ] **Step 4: 修复回归并重复验证**

保持现有会话、活动监控、任务取消和 ComfyUI 设置行为不变。

- [ ] **Step 5: Commit**

```bash
git add server/src web/src docs/superpowers/specs docs/superpowers/plans
 git commit -m "test: 验证本地草稿产物闭环"
```
