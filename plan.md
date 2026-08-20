# 实施计划：故事会话与分镜提示词 YAML 多版本关联与管理

## 目标
- 将生成的分镜提示词 YAML 直接与对话会话（`sessionId`）关联并持久化。
- 支持单会话下的多版本提示词管理（自动自增 `v1`, `v2`, `v3`... 与时间戳）。
- 每次生成时自动追加新版本并切为最新版本展示，不覆盖历史版本。
- 在右侧「提示词 (YAML)」面板顶栏提供版本切换选择器，支持查看任意历史版本的 YAML 及分段预览。

## 架构设计
1. **数据模型 (`src/sessions/store.ts`)**:
   - 定义 `PromptVersion` 接口：`{ id: string; version: number; label: string; yaml: string; createdAt: number }`
   - `ChatSession` 扩展：`promptVersions?: PromptVersion[]; activeVersionId?: string | null;`
   - 存储在 `.director/story-chat.json`，原子落盘与按需加载。
2. **后端 Store & API (`src/story/chat-store.ts`, `src/api/routes.ts`)**:
   - `GET /api/story/chat/sessions/:id/versions` -> `{ versions: PromptVersion[], activeVersionId: string | null }`
   - `POST /api/story/chat/sessions/:id/versions` -> `{ ok: true, version: PromptVersion, activeVersionId: string }`
   - `PUT /api/story/chat/sessions/:id/versions/active` -> `{ ok: true, activeVersionId: string }`
   - `DELETE /api/story/chat/sessions/:id/versions/:versionId` -> `{ ok: true }`
3. **前端 API & 状态联动 (`web/src/api/client.ts`, `web/src/views/StoryChat.tsx`, `web/src/views/StoryTellerView.tsx`)**:
   - `StoryChat.tsx` 在生成提示词时透传 `sessionId` 给父组件，并在切换会话时触发 `onSessionChange`。
   - `StoryTellerView.tsx` 接收 `sessionId`，调用新增版本 API 并维护当前会话的 `promptVersions` 和 `activeVersionId`。
   - 右侧「提示词 (YAML)」顶栏增加版本下拉切换器，切换时即时响应并刷新 YAML / 分段解析展示。

---

## 任务进度

- [x] **Task 1: 后端数据结构与会话版本 Store**
  - [x] 在 `src/sessions/store.ts` 中定义 `PromptVersion` 并在 `ChatSession` 中添加 `promptVersions` / `activeVersionId`
  - [x] 在 `src/sessions/store.ts` 中实现 `addPromptVersion`, `setActivePromptVersion`, `deletePromptVersion`, `getPromptVersions`
  - [x] 在 `src/story/chat-store.ts` 中封装并导出对应的 `*StoryPromptVersion` 方法
  - [x] 在 `src/sessions/store.test.ts` 编写单元测试验证版本操作

- [x] **Task 2: 后端 REST 接口**
  - [x] 在 `src/api/routes.ts` 中注册 `GET/POST/PUT/DELETE /api/story/chat/sessions/:id/versions` 相关路由
  - [x] 在 `src/api/story-api.test.ts` 编写接口自动化测试，验证版本创建、自增编号、激活切换与会话隔离

- [x] **Task 3: 前端 API 客户端与类型定义**
  - [x] 在 `web/src/types.ts` 中定义 `PromptVersion` 并在 `ChatSession` 中补充字段
  - [x] 在 `web/src/api/client.ts` 中实现 `listStoryPromptVersions`, `addStoryPromptVersion`, `setActiveStoryPromptVersion`, `deleteStoryPromptVersion`

- [x] **Task 4: 前端视图与交互实现**
  - [x] 在 `web/src/views/StoryChat.tsx` 中向 `onSummarized` 传递 `sessionId`，并提供 `onSessionChange` 回调
  - [x] 在 `web/src/views/StoryTellerView.tsx` 中接入版本管理逻辑：生成时自动新增版本、切换会话时加载版本
  - [x] 在右侧「提示词 (YAML)」面板顶栏增加版本选择器与状态展示
  - [x] 在 `web/src/views/StoryTeller.test.tsx` 添加前端组件与交互测试

- [x] **Task 5: 全量测试与验证**
  - [x] 运行后端全量测试 `pnpm test` (320 tests 全部通过)
  - [x] 运行前端全量测试 `cd web && pnpm test` (243 tests 全部通过)
