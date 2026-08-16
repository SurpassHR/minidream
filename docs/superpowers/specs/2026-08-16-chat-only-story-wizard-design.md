# 设计文档：去除向导式，对话式统一使用 storyTeller 系统提示词

日期：2026-08-16
状态：已确认（对话式唯一模式；自由聊天与总结成稿统一 storyTeller；提示词库移除 storyChat/storyBackfill）

## 一、背景与目标

故事向导当前双模式（向导式六步问卷 / 对话式），系统提示词三套（storyTeller 用于向导式 AI 建议、storyChat+storySummarize/storyBackfill 用于对话式动作、后端写死文本用于自由聊天），割裂且配置混乱。目标：

1. **去掉向导式**，故事向导页只保留对话式。
2. 对话式（自由聊天 + 总结成稿）的**基础系统提示词统一用 storyTeller**（默认 = docs/prompt-guider-system-prompt.md 的 MiniMax H3 Prompt Director）。
3. 删除「回填向导」（向导式消失后无意义）。
4. 提示词库移除不再被消费的 `storyChat` / `storyBackfill` 键，保留 `storyTeller` / `storySummarize` / `objectDesigner`。

## 二、已确认的关键决策

| 维度 | 决策 |
|---|---|
| 模式 | 仅对话式：StoryTellerView 渲染 RoleHeader + StoryChat + 完成横幅 + 右侧剧本栏；删除模式 tab 与向导式全部 UI/状态机 |
| 自由聊天系统提示词 | 前端 `resolvePrompt(prompts, 'storyTeller')` 经 `POST /api/story/chat` 新字段 `systemPrompt` 传给后端，替换 `buildStoryChatPrompt` 写死的系统文本（缺省用原文本兜底）；落盘/persistAs/历史窗口逻辑不变 |
| 总结成稿 | 保留：prompt = `withArmorBreak(storyTeller + '\n\n' + storySummarize)`；入库链路（saveStory+completeStory）不变 |
| 回填向导 | 删除：按钮、onBackfill prop、runAction backfill 分支、`storyBackfill` 键与 `STORY_BACKFILL_PROMPT` 常量 |
| 提示词库键 | 移除 `storyChat` / `storyBackfill`（含 `STORY_CHAT_SYSTEM` 常量）；保留 3 键：storyTeller / storySummarize / objectDesigner |
| 后端向导 API | `/api/story`（step/answers）、complete、reset **保留不动**（总结成稿与重新生成依赖） |
| storyTeller 标签 | 「故事向导 · 对话式」 |
| 执行方式 | 敏捷：spec 确认后直接写计划并执行 |

## 三、架构

```
故事向导页（#/story-teller）
└─ RoleHeader + 完成横幅（✅ + 重新生成）+ StoryChat（对话式唯一）
     └─ 自由聊天：message=用户输入，systemPrompt=resolvePrompt(prompts,'storyTeller')
     └─ ✨ 总结成稿：withArmorBreak(storyTeller + storySummarize) → 解析 → saveStory+completeStory 入库
     └─ 右侧剧本栏（md）不变
```

**后端**（`src/api/routes.ts`）：
- `buildStoryChatPrompt(projectName, answers, history, message, systemPrompt?)`：`systemPrompt` 缺省时用原写死文本（兜底）；传入时替换。
- `POST /api/story/chat` body 增加 `systemPrompt?: string` → 传入 buildStoryChatPrompt。

**前端**：
- `roles.ts`：`ROLE_PROMPT_KEYS` 收为 3 键；删除 `STORY_CHAT_SYSTEM` / `STORY_BACKFILL_PROMPT` 常量（无消费点）；保留 `STORY_SUMMARIZE_PROMPT` / `STORY_TELLER_SYSTEM` / `OBJECT_DESIGNER_SYSTEM`。
- `client.storyChat(message, onChunk, model?, thinking?, persistAs?, sessionId?, systemPrompt?)`：body 加 `systemPrompt`。
- `StoryChat.tsx`：删 onBackfill prop / 回填按钮 / backfill 分支（action 仅 summarize）；`send` 传 `systemPrompt=resolvePrompt(prompts,'storyTeller')`；`runAction('summarize')` prompt = `withArmorBreak(`${resolvePrompt(prompts,'storyTeller')}\n\n${resolvePrompt(prompts,'storySummarize')}`)`。
- `StoryTellerView.tsx`：仅对话式渲染（`story-view chat-mode` 常驻）；删除 STORY_STEPS / draft / persist / goto / next / prev / complete / handleBackfill / mode 切换；保留 getStory(completedAt) → 完成横幅 + 重新生成（reset → setMd(null)）+ handleSummarized + 右侧剧本栏。
- `SettingsModal.tsx`：`ROLE_PROMPT_KEYS` 3 键自动生效；`ROLE_PROMPT_LABELS.storyTeller` = 「故事向导 · 对话式」。

## 四、错误处理矩阵

| 场景 | 处理 |
|---|---|
| systemPrompt 缺失（旧前端/直接调用） | 后端用原写死文本兜底（行为与现状一致） |
| storyTeller 配置缺失/空 | resolvePrompt 回退内置默认（MiniMax H3 Prompt Director） |
| 总结成稿已完成再点 | 后端 409（现有），前端提示 |
| 重新生成 | reset 清空 story.json + completedAt + md（现有逻辑） |

## 五、测试策略

| 层 | 用例 |
|---|---|
| `src/api/routes.ts` 相关测试（story-api.test.ts / 或 api.test.ts） | buildStoryChatPrompt：systemPrompt 替换写死文本 / 缺省兜底；POST body.systemPrompt 透传（mock pi） |
| `web/src/views/roles.test.ts` | ROLE_PROMPT_KEYS 收为 3 键（键集断言更新） |
| `web/src/views/StoryChat.test.tsx` | send 携带 systemPrompt=storyTeller 配置文本；总结成稿 prompt=storyTeller+storySummarize；删除回填相关用例 |
| `web/src/views/StoryTeller.test.tsx` | 删除向导式全部用例；保留：完成横幅/重新生成/右侧剧本栏 md/加载失败；页面无模式 tab 与向导元素 |
| `web/src/panels/SettingsModal.test.tsx` | 提示词库 3 键（名称标签更新） |

## 六、验收标准

1. 故事向导页只有对话式：无模式 tab、无六步问卷；自由聊天与「✨ 总结成稿」正常。
2. 自由聊天请求携带 storyTeller 系统提示词（默认 MiniMax H3 Prompt Director；设置里配置后生效）。
3. 「↩ 回填向导」按钮与相关代码/提示词键移除。
4. 提示词库只显示 3 个角色条目（storyTeller/storySummarize/objectDesigner），storyTeller 标签为「故事向导 · 对话式」。
5. 总结成稿入库、完成横幅、右侧剧本栏、重新生成全部保留；全部单测通过、现有后端 API 不回归。
