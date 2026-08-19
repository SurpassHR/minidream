# 设计文档：故事向导点击即执行对话

日期：2026-08-19
状态：已确认（2026-08-19）

## 一、背景与目标

故事向导（`StoryChat`）目前是自由输入 + Markdown 气泡。系统提示词虽要求「用户不确定时给 2–4 个选项」，但选项只写在正文里，前端无法点击。用户期望每轮都是「点一下就往下走」：模型返回格式化选项，前端直接渲染；同时保留「其他」自定义输入（含附件与 `@` 提及）。

本设计只改故事向导，不改 AGENT 画布对话。

## 二、已确认的关键决策

| 维度 | 决策 |
|---|---|
| 范围 | 仅 `StoryChat`；`AgentPanel` 保持自由输入 |
| 点选行为 | 点击选项立刻把 `label` 当作用户回答发出，进入下一题 |
| 输入区 | 有选项时，选项铺在原来的输入框位置；底栏「其他」保留附件 / `@` / Enter 发送 |
| 回传格式 | 自然语言提问 + 文末 ` ```choice ` JSON 块；前端解析，正文照常渲染 |
| 空会话 | 自动静默 kickoff，不插「开始访谈」假用户气泡 |
| 「其他」 | 永远由前端提供，不靠模型返回 |
| 选择模式 | v1 只支持单选 |
| 失败策略 | 解析失败 / 无 JSON → 退回现有自由输入，不报错、不卡死 |
| SSE / 历史存储 | 不改协议与 `ChatMessage` 形状；历史仍存原文，前端解析还原选项 |

## 三、架构

```
StoryChat
  ├─ parseChoiceBlock(text)          共享纯函数：抽出文末 choice 块
  ├─ 气泡渲染                         只显示 prompt（去掉 choice 围栏）
  ├─ composer 三态                    choice / free / busy
  └─ 空会话 kickoff                   persistAs = （开始访谈）

POST /api/story/chat
  └─ buildStoryChatPrompt(..., mode)
       ├─ mode='chat'（普通发送、kickoff）：注入 choice 契约
       └─ mode='system'（persistAs=（请总结成稿））：保持旧「要求」
```

不新增 API，不改 SSE 帧，不改 `story-chat.json` schema。结构化选项是前端对 `agent.text` 的派生视图。

### 文件

| 文件 | 职责 |
|---|---|
| `web/src/views/choice.ts`（新建） | `parseChoiceBlock`、`STORY_SYSTEM_MARKERS`、`STORY_KICKOFF_MESSAGE`、类型。解析只发生在前端 |
| `src/api/routes.ts` | `buildStoryChatPrompt` 增加 `mode`；`'chat'` 注入契约，`'system'` 保持总结成稿用的旧「要求」 |
| `src/sessions/store.ts` | 系统标记（`（开始访谈）` / `（请总结成稿）`）不作为自动会话标题 |
| `web/src/views/StoryChat.tsx` | composer 三态、kickoff、气泡隐藏围栏与 kickoff 标记 |
| `web/src/App.css` | 选项卡样式，沿用现有 composer token |
| 测试 | `web/src/views/choice.test.ts`、`web/src/views/StoryChat.test.tsx`、`src/api/story-api.test.ts`、`src/sessions/store.test.ts` |

前端测试不从 `src/` 引用。后端不解析 choice 块，只负责把契约写进 prompt。

## 四、契约与解析

### 4.1 机器块

模型每轮（kickoff 与普通访谈轮）在自然语言提问之后追加且仅追加一个围栏：

````markdown
先选访谈语言。之后的问题都会用这种语言。

```choice
{"question":"希望用哪种语言进行访谈？","options":[{"id":"zh","label":"中文"},{"id":"en","label":"English"}]}
```
````

| 字段 | 约定 |
|---|---|
| 围栏语言标记 | 必须是 `choice`，不用 `json` |
| `question` | 非空短问句，给输入区当标题 |
| `options` | 数组，长度 2–4 |
| `options[].id` | 非空字符串，仅作 React key；不发送、不落盘 |
| `options[].label` | 非空字符串，点击后作为用户消息发出 |
| 位置 | 整段回复的最后一个 `choice` 围栏；若有多个，取最后一个 |
| 「其他」 | 禁止出现在 JSON 里 |

发送内容是 `label` 原文。用户看到「中文」，历史里存「中文」，模型下一轮才能接着认。`id` 不稳定也不影响正确性。

### 4.2 注入点

不改 `storyTeller` / `STORY_TELLER_SYSTEM` 人设正文，避免和提示词库、项目级 prompt 冲突。

`buildStoryChatPrompt` 在现有参数末尾增加 `mode?: 'chat' | 'system'`（缺省 `'chat'`）：

```ts
export function buildStoryChatPrompt(
  projectName: string,
  answers: Record<string, string>,
  history: ChatMessage[],
  message: string,
  systemPrompt?: string,
  ragContext?: string,
  mode?: 'chat' | 'system',
): string
```

项目名、向导进度、历史、RAG、用户消息的拼接不变，只换「要求」列表。现有只传 4–6 个参数的调用方保持 `'chat'`。

`'chat'`（普通发送与 kickoff）的「要求」全文：

```
要求：
1. 用访谈语言写一句短问或确认，像资深编剧推进访谈，不要重复用户已确认的内容；
2. 每次只问一件事；正文不要罗列选项，不要解释机器格式；
3. 文末必须追加且仅追加一个 choice 代码块，围栏语言标记为 choice；
4. choice 块必须是合法 JSON：{"question":"短问句","options":[{"id":"stable-id","label":"可发送的选项原文"}]}；
5. options 2–4 项，互斥；label 用访谈语言，点击后会原样作为用户回答发回；
6. 不要把「其他 / 自定义 / 我自己说」放进 options，前端会单独提供输入框；
7. 用户说「你决定 / 随便 / I don't know」时自己选定并继续，不要停住追问；
8. 用中文还是其它语言，以用户已选的访谈语言为准；尚未选择时先问语言。
```

`'system'`（仅总结成稿）保持**现在**的「要求」全文，一字不改：

```
要求：
1. 直接给出创作建议、扩展点子或追问，像资深编剧与导演讨论剧本一样自然；
2. 结合项目设定与已有向导进度，不要重复用户已写的内容；
3. 每次回答 100-200 字，聚焦推进故事；
4. 用中文回答。
```

路由判断：

- `body.persistAs === '（请总结成稿）'` → `mode = 'system'`
- 其它请求（普通发送、kickoff `persistAs === '（开始访谈）'`、无 persistAs）→ `mode = 'chat'`

不要用「有没有 persistAs」一刀切：kickoff 必须注入契约，否则第一问没有选项。RAG 跳过仍按现有 `if (!body.persistAs)`，kickoff 与总结成稿都不做检索。

### 4.3 `parseChoiceBlock`（`web/src/views/choice.ts`）

```ts
export const STORY_KICKOFF_MARKER = '（开始访谈）';
export const STORY_SUMMARIZE_MARKER = '（请总结成稿）';
export const STORY_SYSTEM_MARKERS = [STORY_KICKOFF_MARKER, STORY_SUMMARIZE_MARKER] as const;
export const STORY_KICKOFF_MESSAGE =
  '这是新会话。按系统提示词开始访谈：先问用户希望使用哪种访谈语言，然后在文末给出 choice 代码块。';

export interface ChoiceOption { id: string; label: string }
export interface ParsedChoice {
  question: string;
  options: ChoiceOption[];
  prompt: string; // 去掉该围栏后的正文，trimEnd
}

export function parseChoiceBlock(text: string): ParsedChoice | null
```

后端 `src/sessions/store.ts` 不引用前端模块。自动标题黑名单在 store 内复制同一组中文字面量（`（开始访谈）` / `（请总结成稿）`），测试锁定两边文案一致即可。

规则：

1. 用正则从文本中找全部 ` ```choice\n...\n``` ` 围栏（允许 `\r\n`；收尾围栏可位于文件末尾且无换行）。
2. 取**最后一个**围栏。
3. `JSON.parse` 失败 → `null`。
4. `question` 必须是 trim 后非空的 string。
5. `options` 必须是 array，长度 2–4。
6. 每项：`label` trim 后非空；缺 `id` 时用 `opt-${index}` 补上。
7. 重复 `label`（忽略首尾空白）视为非法 → `null`（避免两个按钮发同一句话）。
8. 成功则 `prompt = 原文.slice(0, fenceStart) + 原文.slice(fenceEnd)`，再 `trimEnd`。正文里的其它代码块不动。
9. 流式未闭合、JSON 残缺、项数不对、`question` 空 → `null`。

历史重载与流式结束走同一函数。测试覆盖：正常块、多个围栏取最后一个、未闭合、坏 JSON、1 项、5 项、缺 label、重复 label、围栏前后空白、围栏在文本中间（非文末，只要是最后一个仍接受）。

## 五、输入区交互

输入区由「当前会话最新一条 `who === 'agent'` 的消息」派生，不另存选项缓存。

```
busy === true                         → busy
else 最新 agent 消息 parse 成功        → choice
else                                  → free
```

### 5.1 `choice`

选项卡**替换**原来的多行输入，不是叠在上面。结构从上到下：

1. `question` 一行短标题（`.chat-choice-q`）
2. 2–4 个整行选项按钮（`.chat-choice-opt`），左侧键盘序号 `1`–`4`
3. 底部分隔线后的「其他」行：现有附件按钮 + `MentionComposer` + 发送
4. 原 `chat-actions`（总结成稿 + hint）不动

点击选项 = `send(label)`，与点发送走同一条 `client.storyChat` 路径。不带当前附件、不带 `assetRefs`。若用户先贴了图再点选项：附件留在输入区，不丢、不跟选项走。

「其他」完全复用现有输入能力：`@` 提及、Ctrl+V 粘贴图、拖入素材、Enter 发送、Shift+Enter 换行。placeholder 改为「其他… 可 @ 引用素材，或直接输入」。

### 5.2 `free`

`parseChoiceBlock` 返回 `null` 时，输入区与现在完全一致。不插错误条，不当成故障。用于：模型没给块、块坏了、项数不对、流式尚未结束、总结成稿回复（无 choice）。

### 5.3 `busy`

发送、kickoff、总结成稿期间：

- 选项 `disabled`，数字键无效
- 「其他」不可编辑、发送不可点
- 总结成稿按钮沿用现有 `busy`
- 流结束：若最新 agent 消息能解析 → `choice`，否则 `free`

### 5.4 气泡

- agent 气泡渲染 `parseChoiceBlock(text)?.prompt ?? text`，JSON 对用户不可见
- 流式：一旦累积文本匹配到 `\n```choice` 或文首 ` ```choice`，之后的增量不再写入气泡；流结束后用完整 `agentText` 再解析一次，用 `prompt` 覆盖气泡
- 若最终解析失败：把流式期间缓存的 choice 原文补回气泡，输入区保持 `free`（用户仍能看到模型写了什么）
- 用户气泡：kickoff 标记 `（开始访谈）` 不渲染；总结成稿标记 `（请总结成稿）` 保持现有可见行为
- 历史更早的 choice 块不渲染按钮，只净化正文

### 5.5 键盘

| 焦点 | 行为 |
|---|---|
| `choice` 且焦点不在「其他」/`@` 菜单 | `1`–`4` 发送对应选项；超出当前 options 长度则忽略 |
| 焦点在「其他」 | 数字是普通字符；Enter 发送，Shift+Enter 换行 |
| `@` 菜单打开 | 方向键 / Enter 仍归提及选择 |
| `busy` / `free` | 无选项快捷键 |

监听挂在 `window`，组件卸载或会话切换时移除。

### 5.6 视觉

沿用现有故事阅读列 token（`--panel` / `--amber` / serif 正文 / sans 控件），不引入新色板。选项按钮是整行、左对齐、hover 用 `--amber-dim`，与 composer 内框同一圆角（9px）。序号用 `--mono` 小键盘块，不是装饰性 01/02。深色主题走现有 `data-theme` 变量。

## 六、空会话开场

### 6.1 触发

当前会话同时满足：

1. `loaded === true`
2. `busy === false`
3. 可见消息为空：历史里没有 `who === 'agent'` 的消息，也没有非系统标记的用户消息
4. 历史里**没有** `（开始访谈）` 标记（失败过的 kickoff 不自动重试）

触发时机：首次加载空会话、点「新建会话」、删光后自动新建。项目 / board 切换后若新会话为空，同样 kickoff。

系统标记集合：

```ts
const STORY_SYSTEM_MARKERS = ['（开始访谈）', '（请总结成稿）'] as const;
```

「可见消息为空」= `messages.filter(m => !STORY_SYSTEM_MARKERS.includes(m.text)).length === 0`。

### 6.2 请求

复用 `POST /api/story/chat`，不新开端点。

| 字段 | 值 |
|---|---|
| `message` | `这是新会话。按系统提示词开始访谈：先问用户希望使用哪种访谈语言，然后在文末给出 choice 代码块。` |
| `persistAs` | `（开始访谈）` |
| `sessionId` | 当前 `activeId`，必带 |
| `systemPrompt` / `boardId` / `model` / `thinking` | 与普通发送相同 |

kickoff 走 `mode = 'chat'`（注入契约）。RAG 因 `persistAs` 已跳过。

前端**不**把 kickoff 的 `message` 插入 `msgs`。`persistAs` 由后端落盘；加载历史时跳过该用户气泡。

### 6.3 会话标题

`appendMessage` 目前会用首条用户消息自动命名。kickoff 会把标题变成「（开始访谈）」。

改动：自动标题改看「第一条非系统标记的用户消息」，不能只跳过当前这条。

否则 kickoff 先落入 `（开始访谈）` 后，`messages` 里已有 user 行，用户再点「中文」时会被当成第二条用户消息，标题永远停在「新会话」。

```ts
const SYSTEM_TITLE_SKIP = ['（开始访谈）', '（请总结成稿）'];
const isMarker = who === 'user' && SYSTEM_TITLE_SKIP.includes(trimmed);
const hasRealUser = s.messages.some(
  (m) => m.who === 'user' && !SYSTEM_TITLE_SKIP.includes(m.text),
);
if (who === 'user' && !isMarker && !hasRealUser && s.title === '新会话') {
  s.title = trimTitle(trimmed);
}
```

kickoff / 总结成稿标记都不改标题。用户随后点选或输入「中文」时，标题变为「中文」。

此改动在 `src/sessions/store.ts`，AGENT 面板不会发出这些标记，行为不变。

### 6.4 防串台

kickoff 异步，必须绑死 `sessionId`：

1. 发起时 `kickoffSessionIdRef.current = activeId`
2. `appendStream` / 结束回调若 `activeId !== kickoffSessionIdRef`，丢弃 chunk，不改当前视图
3. 只在同一会话上解除 `busy`、写入 agent 气泡
4. kickoff / 普通发送 / 总结期间，新建、切换、删除继续走现有 `busy` 锁

同一会话不发第二次 kickoff，两层闸：

1. **落盘**：历史里已有 `（开始访谈）` 或任意 agent 消息 → 视为开过场。刷新「只有标记、没有 agent 回复」的失败会话 → 保持 `free`，不自动再踢。
2. **内存**：`kickoffAttemptedRef` 按 `sessionId` 记「本组件生命周期内已发起」。请求一开始就写入。即使 HTTP 在服务端落盘前失败（历史里没有标记），`busy` 解除后也不会因「可见消息仍为空」再踢一轮。

切到另一个空会话时 ref 不命中该 id，允许新会话 kickoff。卸载 / 切项目会重置 ref，这是预期：新挂载且历史无标记的空会话可以再试一次。

kickoff 失败：`ErrorBanner` 显示连接错误（沿用 `send` 的 catch 文案），输入区 `free`，用户可打字或新建会话。

## 七、失败降级

原则：选项流是加速层，不是硬门。任何结构化失败都退回今天就能用的自由输入。

| 场景 | 行为 |
|---|---|
| 模型没给 `choice` 块 | `free`；气泡显示全文 |
| JSON 坏掉 / 未闭合 | `free`；流式期间藏起来的残片补回气泡 |
| options 长度 &lt; 2 或 &gt; 4 | `free` |
| 缺 `label` / `question` 空 / 重复 label | `free` |
| 模型把「其他」写成了某个 option | 照常渲染（契约禁止，但不前端过滤文案）；前端自己的「其他」输入仍在，用户不会被卡住 |
| 模型在正文里又手写了一份 1. 2. 3. 列表 | 正文照常显示；真正可点的只有 JSON 块。契约要求不要重复罗列，但不做列表解析 |
| 流式中途切会话 | 现有 `busy` 锁禁止切换；若锁被绕过，chunk 按 `sessionId` 丢弃 |
| 连点两个选项 | 第一次 `send` 置 `busy`，按钮 disabled，第二次点击无效 |
| 点选项同时回车「其他」 | 同一 `busy` 锁，后者直接 return |
| kickoff 失败 | 见 6.4；不自动重试 |
| kickoff 成功但第一问无 JSON | `free`，用户可打字回答语言；下一轮仍注入契约 |
| 总结成稿 | 不注入契约；回复走 `parseStoryAnswers`，输入区 `free` |
| 旧历史（无 choice 块） | 全部 `free`，行为与现在一致 |
| 仅图片 / 仅素材引用的用户消息 | 不触发 kickoff（已有非标记用户消息） |
| 附件待发送时点选项 | 选项不带附件；附件留在「其他」 |
| 数字快捷键与 `@` 菜单冲突 | `@` 菜单优先 |
| 模型输出多个 choice 围栏 | 取最后一个；其余留在 `prompt` 里（用户会看见，属模型失误，不额外处理） |
| `label` 含 Markdown / HTML | 按纯文本按钮渲染，发送原文 |
| 超长 `label`（&gt; 80 字） | 仍然渲染，按钮内换行；不截断（截断会改发送内容） |

不在 v1 做：多选、选项带描述/图标、后端二次校验、模型重试补块、把 choice 写入独立存储字段。

## 八、数据流

### 普通点选

```
agent 原文落盘
  → parseChoiceBlock → composer=choice
  → 用户点击 label
  → setBusy; 追加 user 气泡(label); composer=busy
  → POST /api/story/chat { message: label, sessionId }
  → 流式：气泡写 prompt 增量；扫到围栏后停止追加
  → 结束：落盘全文; parse; choice 或 free
```

### kickoff

```
空会话 loaded
  → busy; POST { message: kickoff指令, persistAs: '（开始访谈）', sessionId }
  → 后端落盘 user=（开始访谈）  （UI 不渲染）
  → 流式 agent 第一问
  → 结束：落盘 agent 全文; parse; choice 或 free
```

### 历史重载

```
GET history
  → 过滤不渲染 （开始访谈）
  → agent 气泡显示 prompt
  → 若最后一条可见消息是 agent 且 parse 成功 → composer=choice
  → 否则 free；若可见消息为空且无 kickoff 标记 → 触发 kickoff
```

## 九、错误处理矩阵

| 场景 | 处理 |
|---|---|
| `storyChat` HTTP / 连接失败 | 现有：agent 气泡追加「（agent 连接失败：…）」；kickoff 额外 `ErrorBanner` |
| 总结成稿无六步格式 | 现有 `未识别到答案格式，请重试` |
| 当前模型不支持视觉 | 现有后端降级，与选项流无关 |
| 解析失败 | 静默 `free`，无错误条 |
| 切项目 / 切 board | 现有 effect 重载会话；新空会话 kickoff |

## 十、测试策略

| 层 | 用例 |
|---|---|
| `web/src/views/choice.test.ts` | 4.3 列出的解析边界；`prompt` 去掉围栏后正文完整 |
| `src/api/story-api.test.ts` | `buildStoryChatPrompt(..., 'chat')` 含 choice 契约与新「要求」全文；`mode='system'` 仍含旧四条、不含 ` ```choice `；路由在总结成稿时走 system、kickoff 走 chat；RAG 在 persistAs 时仍跳过 |
| `src/sessions/store.test.ts` | 首条用户消息为 `（开始访谈）` / `（请总结成稿）` 时标题仍为「新会话」；随后普通用户消息才命名 |
| `web/src/views/StoryChat.test.tsx` | 最新 agent 含 choice → 渲染选项按钮、气泡无 JSON；点击选项发出 `label`；「其他」发送自定义文本；无 JSON → 只有原输入框；kickoff：空会话自动 POST persistAs、不渲染「（开始访谈）」；kickoff 失败不重试；busy 时选项不可点；历史重载还原选项；数字键发送 / 输入框内数字不发送；总结成稿路径不被选项逻辑拦截 |

不改 AGENT 面板测试。现有 StoryChat 发送 / 附件 / `@` / 会话 CRUD 用例保持通过；有选项时「输入框在 composer 内」的断言改为：`free` 时输入框在，`choice` 时「其他」输入框在。

## 十一、验收标准

1. 空的故事会话打开后，无需打字即可看到第一问和可点选项（成功时）。
2. 点击选项立即作为用户回答发出，进入下一轮；历史里是选项原文，不是 JSON。
3. 「其他」可发附件、`@` 提及和自由文本；点预设选项不带走附件。
4. 模型不给或给坏 JSON 时，输入区与现在一致，对话不中断。
5. 刷新后，若最新编剧消息仍带合法 choice 块，选项卡恢复。
6. 总结成稿、会话 CRUD、附件、RAG、破甲提示词行为不变。
7. kickoff 不会把会话标题写成「（开始访谈）」。
8. AGENT 画布对话完全不动。

## 十二、明确不做

- 改 AgentPanel
- 多选 / 选项描述 / 选项图标
- 新 SSE 事件或独立 `choices` 存储字段
- 改 `storyTeller` 提示词库正文
- 模型输出失败后的自动重试补块
- 把「其他」做成模型可返回的 option
