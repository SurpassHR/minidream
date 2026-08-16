# 设计文档：故事向导右侧剧本栏（总结成稿后代码视图展示）

日期：2026-08-16
状态：已确认（方案 A：后端返回 md + 前端轻量高亮视图）

## 一、背景与目标

故事向导（对话式 / 向导式）完成后（点击「✨ 总结成稿」或「完成故事」），当前仅生成 `story_<项目名>.md` 进素材库并显示完成横幅，用户看不到剧本内容。目标：

1. 故事向导页改为**左右两栏**：左侧对话/向导不变，右侧常驻剧本栏。
2. 完成后，右侧栏以**代码编辑器风格**展示剧本全文（即入库的六段故事文档）。
3. 代码视图**高亮三类 token**：`object` 关键字、`<>` 字段、`[]` 字段（剧本内容约定格式）。

## 二、已确认的关键决策

| 维度 | 决策 |
|---|---|
| 内容来源 | 完成的六段故事文档（`buildStoryMarkdown` 产物，与入库 `story_<项目名>.md` 一致） |
| 获取方式 | 后端返回：`POST /api/story/complete` 响应加 `md`；`GET /api/story` 已完成时加 `md`（刷新恢复） |
| 编辑器形态 | 轻量自定义代码视图（行号 + tokenizer 高亮），零新依赖，不引入 Monaco/CodeMirror |
| 布局 | 右侧栏常驻（未完成显示占位），固定宽 380px，不做拖拽分割条 |
| 高亮规则 | `object`（词边界、大小写不敏感）琥珀色加粗；`<...>`（非贪婪、含括号、不跨行）蓝色；`[...]` 绿色 |
| 执行方式 | 敏捷：spec 确认后直接写计划并执行 |

## 三、架构

```
故事向导页（#/story-teller）
┌──────────────────────────────┬──────────────────┐
│ 向导式 ║ 对话式（原内容不变）    │ 右侧剧本栏（常驻）    │
│  ─ 模式 tab                   │  ─ 未完成：占位提示 │
│  ─ 向导步骤 / StoryChat        │  ─ 已完成：        │
│                              │    剧本 · story_<项目名>.md │
│                              │    ScriptViewer（行号+高亮）│
└──────────────────────────────┴──────────────────┘
```

**后端（`src/api/routes.ts`）**：
- `POST /api/story/complete`：响应 `{ asset, story, md }`（`md` 复用已构建的 `buildStoryMarkdown` 变量，零额外计算）。
- `GET /api/story`：`completedAt` 非空时响应 `{ story, md }`；未完成时 `md` 为 `null`（前端占位）。

**前端**：
- `StoryTellerView.tsx`：改两栏布局；新增 `md` state（GET / complete 响应写入，reset 清空）；传给右侧栏组件。
- 新组件 `web/src/views/ScriptViewer.tsx`：只读代码视图 + 行号 + 高亮。
- 新样式（`App.css`）：`.story-layout` / `.script-sidebar` / `.script-viewer` / `.script-line` 等，沿用片场风格（`--panel-2` 底、`--mono` 字体）。

## 四、ScriptViewer 组件设计

**Props**：`{ text: string; name?: string }`（`name` 用于栏标题，如 `story_测试项目.md`）。

**渲染**：行号列（1..N，右对齐、`--text-faint`）+ 代码行（横向滚动容器）。整体只读，无交互。

**tokenizer**（导出纯函数便于测试）：

```ts
// web/src/views/ScriptViewer.tsx
export type Token = { text: string; kind: 'plain' | 'object' | 'angle' | 'square' };
export function tokenizeScriptLine(line: string): Token[]
```

- 单行从左到右单次扫描，优先级：`<>` 字段 > `[]` 字段 > `object` 关键字 > 普通文本。
- `object` 规则：`/\bobject\b/i`（词边界、大小写不敏感）。
- `<>` 规则：`/<[^<>]*>/`（非贪婪、含尖括号、不跨行）。
- `[]` 规则：`/\[[^\[\]]*\]/`（非贪婪、含方括号、不跨行）。
- 渲染：React span（`className="tok-object"` / `tok-angle` / `tok-square`），文本节点天然转义，无 XSS。

**配色**（theme.css 变量）：`object` → `--amber` 加粗；`<>` → `--blue`；`[]` → `--ok`。

## 五、数据流

```
总结成稿：StoryChat → onSummarized(answers) → saveStory → completeStory
  → 响应 { asset, story, md } → setStory(r.story) + setMd(r.md) → 右侧栏渲染
挂载/切项目：GET /api/story → { story, md } → 已完成则右侧栏直接展示
reset：响应 story（completedAt=null）→ setMd(null) → 右侧栏回占位
```

## 六、错误处理矩阵

| 场景 | 处理 |
|---|---|
| 未完成（completedAt 为空） | 右侧栏占位：「对话结束点击 ✨ 总结成稿（或向导完成故事）后，剧本将在这里展示」 |
| GET /api/story 失败 | 沿用现有「加载故事进度失败」横幅；右侧栏显示占位 |
| 已完成但 md 为空（旧数据/异常） | 右侧栏显示「剧本暂不可用」占位（不崩溃） |
| 剧本含特殊字符 | React 文本节点渲染，天然转义，无注入风险 |
| 切换项目 | 随 GET /api/story 重新拉取（现有加载逻辑已覆盖） |

## 七、测试策略

| 层 | 用例 |
|---|---|
| `web/src/views/ScriptViewer.test.tsx` | tokenize：object 词边界/大小写；`<>` 与 `[]` 内容、多组匹配、嵌套不跨行；行号渲染；特殊字符转义 |
| `web/src/views/StoryTellerView.test.tsx` | 总结成稿完成后右侧栏展示 md；已完成项目挂载 GET 恢复 md；reset 回占位；未完成占位文案 |
| `src/api/story-api.test.ts` | complete 响应含 md（与 buildStoryMarkdown 一致）；GET 已完成返回 md、未完成返回 null |

## 八、验收标准

1. 对话式点「✨ 总结成稿」→ 流结束 → 右侧栏出现剧本全文（六段 Markdown）。
2. 剧本中 `object`（任意大小写、词边界）高亮为琥珀色加粗；`<...>` 蓝色；`[...]` 绿色。
3. 刷新页面 / 切换项目后，已完成项目的剧本仍在右侧栏展示。
4. 「重新生成」后右侧栏回占位。
5. 向导式「完成故事」同样在右侧栏展示剧本。
6. 全部新增单测通过，现有测试不回归。
