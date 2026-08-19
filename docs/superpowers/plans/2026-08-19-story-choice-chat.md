# 故事向导点击即执行对话 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 StoryChat 增加可解析、可点击、可恢复的单选访谈交互，同时保留自由输入、附件和素材引用能力。

**Architecture:** `web/src/views/choice.ts` 作为唯一 choice 解析入口，agent 原文仍按现有 ChatMessage/SSE 落盘；StoryChat 只从最新 agent 原文派生 choice/free/busy composer。后端通过 `mode='chat'|'system'` 选择访谈契约或总结成稿旧要求，所有异步 UI 写回都绑定 session/request 上下文。

**Tech Stack:** React、TypeScript、Fastify、Vitest、现有 MentionComposer 和 SSE client。

**Spec:** `docs/superpowers/specs/2026-08-19-story-choice-chat-design.md`

## Global Constraints

- 仅修改 StoryChat；AgentPanel 保持不变。
- 不新增 API、SSE 帧或 `ChatMessage`/`story-chat.json` 字段。
- choice 是 agent.text 的前端派生视图，失败必须退回自由输入。
- kickoff 使用 `（开始访谈）`，总结成稿使用 `（请总结成稿）`；两个标记不自动命名标题。
- 点击选项只发送 label，不携带待发送附件或 assetRefs；附件留在“其他”输入区。
- v1 只支持单选，options 数量为 2–4。

---

### Task 1: Choice 纯函数

**Files:**
- Create: `web/src/views/choice.ts`
- Create: `web/src/views/choice.test.ts`

- [ ] 先写正常块、多个块取最后一个、坏 JSON、未闭合、错误项数、重复 label 和正文清洗测试。
- [ ] 运行 `pnpm exec vitest run web/src/views/choice.test.ts` 确认测试因模块不存在失败。
- [ ] 实现 `parseChoiceBlock(text): ParsedChoice | null`、系统标记常量、kickoff 文案。
- [ ] 重新运行同一测试并确认通过。

### Task 2: 后端 prompt 与标题

**Files:**
- Modify: `src/api/routes.ts`
- Modify: `src/sessions/store.ts`
- Modify: `src/api/story-api.test.ts`
- Modify: `src/sessions/store.test.ts`

- [ ] 为 `buildStoryChatPrompt` 增加默认 `mode='chat'`，chat 注入 choice 契约，system 保留旧四条要求。
- [ ] 路由仅把总结成稿标记映射为 system，kickoff 和普通请求映射为 chat。
- [ ] 用 exact marker helper 跳过系统用户消息的自动标题。
- [ ] 先运行后端测试，再修复模式或标题回归。

### Task 3: StoryChat 核心状态与发送管线

**Files:**
- Modify: `web/src/views/StoryChat.tsx`

- [ ] 最新 agent 消息派生 choice/free，busy 优先。
- [ ] 统一普通文本、选项、总结请求的 busy 和 request/session guard。
- [ ] 保存 raw agent 文本，流式期间只临时隐藏 choice 围栏；最终解析失败展示完整原文。
- [ ] 接入 kickoff 的历史/内存双闸和同会话写回。
- [ ] 渲染用户系统 kickoff 标记时隐藏，agent 气泡渲染净化后的 prompt。

### Task 4: Composer 交互

**Files:**
- Modify: `web/src/views/StoryChat.tsx`
- Modify: `web/src/views/StoryChat.test.tsx`
- Modify: `web/src/App.css`

- [ ] choice 状态显示问题、选项按钮和“其他”输入；free 状态保持原 composer。
- [ ] 点击选项发送 label 且不带附件/assetRefs，其他输入仍可发送附件和引用。
- [ ] 加入全局数字快捷键，并保证输入框和 @ 菜单优先。
- [ ] 增加 choice、kickoff、降级、busy 和快捷键测试。

### Task 5: 验证

- [ ] 运行 choice、StoryChat、story-api、sessions 相关测试。
- [ ] 运行 `pnpm test`。
- [ ] 运行项目 typecheck（若无独立脚本则使用仓库现有 TypeScript 检查命令）。
- [ ] 修复测试、类型或既有 StoryChat 附件/会话回归。
