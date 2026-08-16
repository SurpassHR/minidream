# 设计文档：Agent 对话多会话（历史会话列表 + 查看/继续）

日期：2026-08-16
状态：已确认（方案 A：共享会话存储 + 每区域 CRUD API + 前端会话 UI）

## 一、背景与目标

AGENT 面板（画布右栏）与故事向导对话式（StoryChat）目前各只有**单条会话线程**（`.director/chat.json` / `.director/story-chat.json`，扁平消息数组）。目标：两个 agent 对话区域支持**多会话**——展示会话历史列表，可新建会话、选择任意历史会话查看消息并继续对话、重命名、删除。

## 二、已确认的关键决策

| 维度 | 决策 |
|---|---|
| 存储 | 每项目每区域一个会话文件：`{ sessions: [{id,title,createdAt,updatedAt,messages}], activeId }`；chat.json / story-chat.json 各自独立 |
| 迁移 | 旧扁平数组（ChatMessage[]）读时自动包装为「会话 1」；损坏/缺失 = 空库 |
| 会话上限 | 每会话消息上限沿用：AGENT 300 条、故事 100 条（裁剪最早）；会话总数不设限 |
| 标题 | 自动 = 首条用户消息截断 20 字符；无消息 = 「新会话」；可重命名 |
| 删除语义 | 删当前会话 → activeId 回退最近更新的会话；无会话 → activeId=null（前端自动建空会话） |
| API 形态 | 每区域一组：sessions CRUD + history?sessionId + chat body.sessionId（落盘与 prompt 上下文按会话作用域） |
| 前端布局 | StoryChat：聊天区左侧窄会话列表面板（~150px）；AgentPanel：消息区上方紧凑会话条（下拉） |
| 执行方式 | 敏捷：spec 确认后直接写计划并执行 |

## 三、架构

```
前端会话 UI（StoryChat 左列表 / AgentPanel 顶部会话条）
   │ sessions CRUD / history?sessionId / chat { sessionId }
   ▼
src/sessions/store.ts（共享会话存储：read/create/rename/delete/append，按文件参数化）
   ├─ chat.json  ← src/agent/chat-history.ts 薄封装（上限 300）
   └─ story-chat.json ← src/story/chat-store.ts 薄封装（上限 100）
```

**后端**：
- 新建 `src/sessions/store.ts`：
  - `readSessions(file): { sessions: Session[]; activeId: string | null }`（迁移旧扁平数组；防御损坏）
  - `createSession(file): { sessions, activeId }`（新会话 activeId 指向它；标题「新会话」）
  - `renameSession(file, id, title): Session | null`
  - `deleteSession(file, id): { sessions, activeId }`（activeId 回退规则）
  - `appendMessage(file, sessionId, who, text): Session[]`（无会话时自动创建；裁剪上限；刷新 updatedAt）
- `src/agent/chat-history.ts` / `src/story/chat-store.ts`：改为薄封装（保留既有导出名 `readChatHistory` / `appendChatMessage` / `readStoryChat` / `appendStoryChat`，签名扩展 sessionId 参数），上限常量保留。
- 路由（`src/api/routes.ts`）：
  - AGENT：`GET /api/agent/sessions`、`POST /api/agent/sessions`、`PATCH /api/agent/sessions/:id`（重命名）、`DELETE /api/agent/sessions/:id`、`GET /api/agent/history?sessionId=`、`POST /api/agent/chat` body 加 `sessionId`（落盘到该会话）
  - 故事：`GET/POST /api/story/chat/sessions`、`PATCH/DELETE /api/story/chat/sessions/:id`、`GET /api/story/chat/history?sessionId=`、`POST /api/story/chat` body 加 `sessionId`；`buildStoryChatPrompt` 的历史参数改为该会话消息
- 会话消息上限：AGENT 300（原有）、故事 100（原有）。

**前端**：
- `web/src/api/client.ts` 新增：`listAgentSessions / createAgentSession / renameAgentSession / deleteAgentSession`、`listStorySessions / createStorySession / renameStorySession / deleteStorySession`；`getStoryChatHistory(sessionId)`、`storyChat(..., sessionId)` 扩展；AGENT 侧 `listChatHistory(sessionId)`。
- `web/src/panels/AgentPanel.tsx`：消息区上方会话条：「会话：<当前标题> ▾」（下拉：全部会话列表 + 每项 重命名/删除）+「＋ 新建会话」。选择会话 → 加载该会话消息；发送 → 携带当前 sessionId；删除当前会话 → 后端回退，前端跟随。
- `web/src/views/StoryChat.tsx`：聊天区左侧窄会话列表面板（~150px）：「＋ 新建会话」+ 列表（标题/更新日期，active 高亮，悬停 ✎ 重命名 / 🗑 删除带确认）。发送/总结成稿/回填向导携带当前 sessionId；总结/回填的 prompt 上下文 = 当前会话。
- 会话标题显示：列表项显示标题 + 相对日期（HH:mm / MM-DD）。

## 四、错误处理矩阵

| 场景 | 处理 |
|---|---|
| 旧扁平数组文件 | 读时迁移为「会话 1」并惰性写回（下次写时落盘新结构） |
| 文件损坏/缺失 | 空库（sessions: []，activeId: null）；前端自动建空会话 |
| 删除不存在的会话 id | 404 `SESSION_NOT_FOUND`（`DirectorErrorCode` 新增该码，错误处理器映射 404，与 NODE_NOT_FOUND 惯例一致） |
| 删除当前会话 | activeId 回退最近 updatedAt 的会话；无会话 → null → 前端自动新建 |
| 重命名空标题 | 忽略（保持原标题） |
| 切换会话时流式进行中 | 前端 busy 锁禁止切换（沿用现有 busy） |
| 项目切换 | 会话列表随项目重新加载 |
| 发送时无会话 | 后端 appendMessage 自动创建会话并返回（activeId 跟随）；前端加载后无会话也自动建空会话（双保险） |
| history 端点兼容 | `GET .../history` 不带 sessionId 时返回当前 active 会话消息（向后兼容旧调用） |

## 五、测试策略

| 层 | 用例 |
|---|---|
| `src/sessions/store.test.ts` | 读写/迁移（旧数组→会话 1）/新建/重命名/删除（含当前会话回退、删光→null）/append 自动建会话/上限裁剪/updatedAt 刷新/损坏防御 |
| `src/api/api.test.ts` 或既有 chat 相关测试文件 | sessions CRUD 端点 + history?sessionId + chat body sessionId 落盘到指定会话（mock pi） |
| `web/src/panels/agent.test.tsx` | 会话条渲染/下拉选择加载消息/新建/重命名/删除/发送携带 sessionId |
| `web/src/views/StoryChat.test.tsx` | 会话列表渲染/点选加载/新建/重命名/删除确认/总结成稿携带 sessionId |

## 六、验收标准

1. AGENT 面板与故事对话式均显示会话历史列表（或下拉），可新建、点选任意历史会话查看消息并继续对话。
2. 重命名与删除（带确认）可用；删除当前会话自动切换到其他会话或新建空会话。
3. 会话按项目隔离、刷新与重启不丢；旧单线历史迁移为第一个会话，内容不丢。
4. 发送消息落入当前会话；故事对话式总结成稿/回填向导的上下文 = 当前会话。
5. 全部新增单测通过，现有测试不回归。
