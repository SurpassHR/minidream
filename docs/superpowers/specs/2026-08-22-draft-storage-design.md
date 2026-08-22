# 本地草稿存储与产物拦截设计

## 目标

在“生成”和“资产”侧栏项目之间增加“草稿”，将图片/视频生成完成后的产物从 ComfyUI 临时输出转存到本地可配置目录，聊天结果和草稿页面统一读取项目本地文件。

## 已确认决策

- 存储目录允许配置为任意绝对路径。
- ComfyUI 产物先通过 `/view` 读取，保存到本地成功后尽力删除 ComfyUI 临时文件。
- 默认目录为项目内 `server/data/drafts`。
- `TaskQueue` 仍是唯一生成任务管理器。
- 不引入数据库或第三方依赖。
- 设置和索引文件使用现有 `.tmp + renameSync` 原子写入方案。

## 现状

生成任务由 `TaskQueue` 执行并从 ComfyUI `/history` 获取输出元数据。任务输出目前直接生成 `/comfyui/view?...` 地址，前端通过 ComfyUI 代理读取；项目没有本地媒体索引，也没有草稿页面。侧栏数据来自 `server/src/mock.ts`，设置页面由 `web/src/components/SettingsModal.tsx` 管理。

## 方案

### DraftStore

新增 `server/src/drafts.ts`，负责本地草稿文件和索引：

- 设置文件新增 `storage.outputDir`，必须为绝对路径；不存在时自动创建；
- 草稿索引保存于 `server/data/drafts.json`，独立于可变的输出目录；
- 每个文件使用 `draft_<时间戳>_<随机 ID>.<扩展名>`，不接受用户传入路径作为文件名；
- 记录 `id`、`taskId`、`kind`、`filename`、`path`、`mime`、`size`、`createdAt`；
- 提供 `list()`、`get()`、`saveFromBuffer()`、`delete()` 和目录可写性检查；
- 索引更新采用临时文件加 rename；
- 读取文件时根据索引记录定位，不把任意请求路径直接拼进文件系统路径。

### TaskQueue 产物拦截

`TaskQueue.executeRealComfyTask()` 从 `/history` 收集到输出后：

1. 通过 ComfyUI `/view` 下载每个图片/视频；
2. 交给 `DraftStore` 写入配置目录；
3. 将 `TaskOutput.url` 改为 `/api/drafts/:draftId/file`；
4. 任务输出更新为本地草稿信息；
5. 尝试调用 ComfyUI 删除接口清理临时输出；
6. 本地保存失败则任务进入 `failed`，不伪装成 `completed`。

ComfyUI 的输出目录只承担短暂的中转职责，最终产物不再依赖 ComfyUI `/view`。

### HTTP API

新增：

- `GET /api/drafts`：返回草稿元数据列表，按创建时间倒序；
- `GET /api/drafts/:id/file`：以索引中的文件路径读取媒体；
- `DELETE /api/drafts/:id`：删除索引记录和对应本地文件；
- `POST /api/settings/storage`：校验并持久化绝对输出目录。

`GET /api/settings` 增加 `storage.outputDir`；原 ComfyUI 和生图设置保持兼容。

### 前端

侧栏顺序调整为：

> 灵感 → 生成 → 草稿 → 资产 → 画布

新增草稿页面：

- 图片网格预览；
- 视频可播放预览；
- 显示文件名、类型、创建时间和来源任务；
- 支持删除草稿；
- 生成产物完成后通过活动刷新或重新进入页面获取列表。

SettingsModal 增加“产物存储”分类：

- 展示和编辑绝对路径；
- 保存时检查目录可创建/可写；
- 失败时不覆盖旧配置并展示中文错误；
- 成功后提示已生效。

聊天任务卡和媒体卡片使用 `/api/drafts/:id/file`，不再直接输出 `/comfyui/view`。

## 错误处理与兼容

- 非绝对路径拒绝保存；
- 不存在的草稿或文件返回 404；
- 删除已不存在的物理文件仍移除索引并返回成功；
- ComfyUI 临时文件清理失败只记录任务日志，不让已成功本地保存的任务失败；
- 历史任务中已有 `/comfyui/view` URL 的消息保持可读，不回溯迁移；
- 修改输出目录不迁移旧草稿，旧草稿继续依据索引中的绝对路径读取。

## 测试验收

服务端覆盖：

1. 绝对路径校验、目录创建和原子索引写入；
2. 图片/视频 buffer 保存和索引读取；
3. 草稿删除；
4. 设置目录持久化；
5. TaskQueue 输出被替换为本地草稿 URL；
6. 本地保存失败会使任务失败。

前端验收：

- TypeScript 检查通过；
- Vite 构建通过；
- 侧栏显示草稿入口；
- 草稿页面正确展示本地图片/视频并可删除。
