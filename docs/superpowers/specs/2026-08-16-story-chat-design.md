# 设计文档：故事向导对话式模式（story-chat）

日期：2026-08-16
状态：已确认（2026-08-16 三节评审通过；后续按敏捷开发执行，不再逐节确认）

## 一、背景与目标

故事向导当前只有「向导式」（六步预定义问卷）。用户希望增加「对话式」模式：与 AI 编剧自由对话选择主题与内容，更自由地探索故事方向。两种模式双向衔接：

1. **对话式自由聊**：AI 扮演故事编剧，基于项目名 + 向导已有答案 + 最近 20 条对话历史接话。
2. **总结成稿**：从对话提炼六步答案 → 复用现有 complete 流程 → 故事文档进素材库 + completedAt。
3. **回填向导**：从对话提取六步答案 → 写入 story.json answers → 切回向导式继续精修。

## 二、已确认的关键决策

| 维度 | 决策 |
|---|---|
| 模式关系 | 双向衔接：总结成稿（入库）+ 回填向导（写入 answers），模式 tab 切换 |
| 对话上下文 | 独立端点 + 全上下文：项目名 + 向导答案摘要 + 最近 20 条历史 |
| 历史存储 | `.director/story-chat.json`（独立于 AGENT 面板 chat.json，上限 100 条） |
| 产出格式 | AI 输出 + 约定格式（`stepId: 内容` 每行一条），前端解析 |
| 入库路径 | 总结成稿复用现有 `POST /api/story/complete`（answers 快照 → 组装 → 入库 + completedAt） |
| 执行方式 | 敏捷：spec 确认后直接写计划并执行，不逐节确认 |

## 三、架构

```
故事向导页（#/story-teller）
┌──────────────────────────────────────────┐
│ 向导式 ║ 对话式      ← 模式 tab（localStorage 记住）│
└──────────────────────────────────────────┘
  对话式（StoryChat 组件）：
  ├─ 消息列表（Markdown 渲染，流式追加）
  ├─ 输入框（Enter 发送）
  └─ [✨ 总结成稿] [↩ 回填向导]
```

**后端新增：**

```
src/story/chat-store.ts          // story-chat.json 读写（参照 chat-history.ts 模式）
GET  /api/story/chat/history    → { messages: ChatMessage[] }
POST /api/story/chat            → SSE 流式（复用 runAgentStream + writeAgentMcpConfig）
```

**POST /api/story/chat 请求体**：`{ message, model?, thinking? }`（与 /api/agent/chat 同构）

**Prompt 构造**（后端组装）：
```
你是导演工作台的故事编剧（story-teller 对话模式）……
当前项目：<projectName>
向导进度（已完成部分）：
  theme: 精灵与哥布林的战争与和解
  …（只列出有内容的步骤）
对话历史（最近 20 条）：
  用户：…
  agent：…
用户消息：<message>
```

**历史落盘**：用户消息先落盘（不依赖 pi 退出），agent 全文流结束后落盘；MCP 隔离配置复用 `writeAgentMcpConfig`。

## 四、前端对话式 UI

**StoryTellerView 改造**：顶部加模式 tab（向导式/对话式），`localStorage` 记住选择（key `dw:storyMode`）。模式 tab 放在 RoleHeader 之下、内容之上。

**新组件 `web/src/views/StoryChat.tsx`**：
- 消息列表：用户/agent 气泡（复用 AgentPanel 的 ReactMarkdown + remarkGfm 渲染，流式容忍未闭合片段）
- 输入框 + Enter 发送；发送 → 追加用户消息 → `client.storyChat(message, onChunk, model?, thinking?)`（SSE 流式）→ 流式追加 agent 消息
- 挂载/切换项目 → `GET /api/story/chat/history` 恢复历史
- 「✨ 总结成稿」：调 agent 输出六步答案（约定格式）→ 解析 → `completeStory` → 入库 + completedAt
- 「↩ 回填向导」：调 agent 输出六步答案 → 解析 → `saveStory({ answers })` → 切回向导式
- 两按钮 busy 状态防重复点击；回填覆盖已有答案时弹确认
- AI 输出完整答案后的按钮操作：流式完成后按钮才可点（等待流结束）

**角色提示词**（`roles.ts` 新增）：
- `STORY_CHAT_SYSTEM`：编剧自由对话（接话风格，参考已有 STORY_TELLER_SYSTEM）
- `STORY_SUMMARIZE_PROMPT`：总结成稿（输出六步约定格式）
- `STORY_BACKFILL_PROMPT`：回填向导（输出六步约定格式，说明只填对话中出现的步骤，未提及的步骤可留空）

## 五、产出格式约定

**六步答案输出约定**（总结成稿与回填向导共用）：

```
theme: 精灵与哥布林的战争与和解
protagonist: 银发绿眸的精灵骑士，……
support: 人类养女、年迈的哥布林长老
antagonist: 两族共有的「灰雾诅咒」
scenes: 迷雾森林、地下矿洞、圣山祭坛
ending: 以牺牲换来两族和解，开放式尾声
```

- 解析规则：按行匹配 `^(theme|protagonist|support|antagonist|scenes|ending):\s*(.+)$`，非法行忽略；缺失步骤在向导式显示为空（不强制）
- 解析函数 `parseStoryAnswers(text: string): Record<string, string>` 放 `web/src/views/StoryChat.tsx`（导出便于测试）
- **总结成稿**：AI 输出 → 解析 → `saveStory({ answers })` → `completeStory` → 素材库 `story_<项目>.md`
- **回填向导**：AI 输出 → 解析 → `saveStory({ answers })` → 切回向导式

## 六、错误处理矩阵

| 场景 | 处理 |
|---|---|
| story-chat.json 损坏/不存在 | 返回空历史（不 500），写时重建 |
| AI 输出无法解析（无合法行） | 提示「未识别到答案格式，请重试」，不覆盖现有答案 |
| 对话历史超上限 | 保留最近 100 条（裁剪最早） |
| 对话式发送时 agent 连接失败 | 追加错误消息「（agent 连接失败）」，历史保留用户消息 |
| 切换项目 | 对话历史随项目重新拉取 |
| 总结成稿时已完成（completedAt 非空） | 后端 409 → 前端提示先「重新生成」 |
| 回填覆盖确认 | 弹确认「将覆盖向导中已填写的 X 步答案？」 |

## 七、测试策略

| 层 | 用例 |
|---|---|
| `src/story/chat-store.test.ts` | 读写/裁剪 100 条/损坏兜底/原子写 |
| `src/api/story-api.test.ts`（追加） | history GET / chat POST（mock pi）落盘与响应 |
| `web/src/views/StoryChat.test.tsx` | 历史加载/发送流式渲染/总结成稿解析/回填解析/确认门 |
| `web/src/views/StoryTeller.test.tsx` | 模式切换 tab 保留上次选择 |

## 八、验收标准

1. `pnpm test` 全绿（现有 + 新增）
2. 对话式自由聊 → 总结成稿 → 素材库出现故事文档，两模式显示已完成
3. 对话式聊 → 回填向导 → 切回向导式可见六步答案
4. 切换项目后对话历史各自独立

## 九、范围外（YAGNI）

- 不做对话式与 AGENT 面板历史互通（独立 story-chat.json）
- 不做多轮 AI 追问式引导（对话式就是自由聊）
- 不做后端结构化解析（AI 输出 + 前端解析足够）
