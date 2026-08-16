# 设计文档：角色系统提示词库（设置内 CRUD）

日期：2026-08-16
状态：已确认（方案 A：settings.json 存提示词库 + 前端按名引用回退）

## 一、背景与目标

5 个角色系统提示词（故事向导 STORY_TELLER_SYSTEM / 物体设计 OBJECT_DESIGNER_SYSTEM / 对话编剧 STORY_CHAT_SYSTEM / 总结成稿 STORY_SUMMARIZE_PROMPT / 回填向导 STORY_BACKFILL_PROMPT）当前硬编码在 `web/src/views/roles.ts`，用户无法调整。目标：在全局设置弹窗中提供**可增删的提示词库**——5 个角色条目预置，支持查看/编辑/新增/删除/恢复默认；AI 功能按名称引用，缺省回退内置默认。

## 二、已确认的关键决策

| 维度 | 决策 |
|---|---|
| 存储 | 全局 `~/.director/settings.json` 的 `AppSettings.prompts?: Record<string, string>`（与 comfyUrl 等同级，跨项目） |
| 写语义 | `prompts` 整体替换（增/删/改均提交完整 map）；保存时总是写入（含空对象） |
| 字段存在性 | `prompts` 键缺失 = 从未自定义（前端预填 5 默认）；`prompts: {}` = 已保存空库（不预填） |
| 消费键 | 固定 5 键：`storyTeller` / `objectDesigner` / `storyChat` / `storySummarize` / `storyBackfill` |
| 回退 | `resolvePrompt(prompts, key) = prompts[key] || 内置默认常量`（roles.ts 为内置默认的唯一来源） |
| UI | SettingsModal 新增「提示词库」区块：条目列表（名称+内容+删除）+「＋ 新增」+ 区块级「↺ 重置为默认提示词」 |
| 预置语义 | 存储 map 为权威；`prompts` 键缺失（从未保存过提示词库）时工作副本预填 5 角色条目；已保存的空库 `{}` 不预填，删除的条目不复活 |
| 生效 | 保存后立即生效（App settings state → props → 消费点） |
| 执行方式 | 敏捷：spec 确认后直接写计划并执行 |

## 三、架构

```
SettingsModal（⚙ 设置）
└─ 提示词库区块：条目列表（名称 + 内容 textarea + 🗑 删除）+ ＋ 新增 + ↺ 重置默认
        │ PUT /api/settings { ..., prompts: Record<string,string> }（整体替换）
        ▼
~/.director/settings.json  AppSettings.prompts
        │ GET /api/settings（App 挂载时拉取 → settings state）
        ▼
App → <StoryTellerView prompts> → <StoryChat prompts>
App → <ObjectDesignerView prompts>
        ▼ 消费点：resolvePrompt(prompts, key) || roles.ts 内置默认
aiSuggest / runAction(summarize|backfill) / objectDesigner AI 优化
```

**后端**（`src/settings/settings-store.ts` + `src/api/routes.ts`）：
- `AppSettings` 增加 `prompts?: Record<string, string>`（可选：缺失=从未自定义）；`DEFAULTS` 不含 prompts 字段（readSettings 对缺失返回 undefined，保存时总是写入）。
- `readSettings`：`data.prompts === undefined` → 返回 `prompts: undefined`；否则防御过滤（对象、值为 string 的键保留，空对象保留）。
- `saveSettings`：`patch.prompts` 为对象时整体替换（同样过滤非 string 值）且总是写入结果（含 `{}`）。

**前端**（`web/src/views/roles.ts` + `web/src/panels/SettingsModal.tsx` + `web/src/App.tsx` + 消费点）：
- `ROLE_PROMPT_KEYS: Record<key, 内置默认常量>`（roles.ts 内定义，键与内置默认同源）。
- `resolvePrompt(prompts: Record<string,string> | undefined, key: string): string`：`prompts?.[key] || ROLE_PROMPT_KEYS[key]`（空串视为未配置）。
- `App.tsx`：`handleSettingsSaved` 已有 state 更新；`settings.prompts` 传给 `StoryTellerView`/`ObjectDesignerView`（新增 `prompts` prop）；`StoryTellerView` 透传 `StoryChat`。
- 消费点替换：
  - `StoryTellerView.aiSuggest`：`resolvePrompt(prompts, 'storyTeller')` 取代 `STORY_TELLER_SYSTEM`。
  - `StoryChat.runAction`：基础角色 `resolvePrompt(prompts, 'storyChat')`；summarize 用 `resolvePrompt(prompts, 'storySummarize')`；backfill 用 `resolvePrompt(prompts, 'storyBackfill')`。
  - `ObjectDesignerView`：`resolvePrompt(prompts, 'objectDesigner')` 取代 `OBJECT_DESIGNER_SYSTEM`。

**SettingsModal 提示词库区块**：
- 工作副本 state：`prompts: Record<string, string>`（打开时从 `props.settings.prompts` 拷贝；`undefined` 时预填 5 角色条目 = 从未自定义）。
- 条目行：名称输入（可改；改名即变成自定义条目）+ 内容 textarea + 🗑 删除。
- 「＋ 新增」：追加空条目（`新提示词 N` 名称，可改）。
- 「↺ 重置为默认提示词」：把 5 角色条目（含默认内容）合并进工作副本（自定义条目保留）。
- 保存：`client.saveSettings({ ..., prompts })`（总是提交，含空对象）；成功后 `onSaved` → App state 更新 → 消费点立即生效。

## 四、错误处理矩阵

| 场景 | 处理 |
|---|---|
| settings.json 损坏/无 prompts 字段 | `readSettings` 返回默认（prompts 键缺失）；前端 `undefined` → 预填 5 角色条目 |
| 已保存空库（prompts:{}） | 不预填：删除的条目不复活；消费点全部回退内置默认 |
| 条目内容为空串 | 保存后消费点 `||` 回退内置默认（空串=未配置） |
| 删除角色条目 | 消费点回退内置默认（语义自然，不阻塞） |
| 重名键 | map 天然去重（同名覆盖） |
| 保存失败 | 沿用现有 onError 横幅，不关闭弹窗 |
| 名称/内容超长 | 不设硬限制（JSON 文本文件，桌面单用户） |

## 五、测试策略

| 层 | 用例 |
|---|---|
| `src/settings/settings-store.test.ts` | 缺失字段返回 prompts=undefined；保存整体替换（增/改/删）；空对象保留（不复活）；非 string 值过滤；损坏文件防御 |
| `src/api/api.test.ts`（或 settings 相关既有文件） | PUT /api/settings 携带 prompts 持久化并读回；未传 prompts 不影响现值 |
| `web/src/panels/SettingsModal.test.tsx` | 首次打开预填 5 条目；新增/编辑/删除；重置默认；保存 payload 含 prompts |
| `web/src/views/roles.test.ts`（或并入消费点测试） | resolvePrompt：命中/回退/空串回退 |
| `web/src/views/StoryTeller.test.tsx` | AI 建议用配置的 storyTeller（fetch 断言 message 含配置文本）；缺省用默认 |
| `web/src/views/StoryChat.test.tsx` | runAction 用配置的 storyChat/storySummarize/storyBackfill |
| `web/src/views/ObjectDesigner.test.tsx` | AI 优化用配置的 objectDesigner |

## 六、验收标准

1. ⚙ 设置弹窗出现「提示词库」区块，首次打开预填 5 个角色条目（内容=内置默认）。
2. 可编辑任意条目内容、新增自定义条目、删除任意条目、一键重置 5 角色默认。
3. 保存后：AI 建议/物体设计 AI 优化/对话总结成稿/回填向导使用配置值；未配置或删除的键回退内置默认。
4. 刷新页面/重启后配置持久（settings.json），跨项目生效。
5. 全部新增单测通过，现有测试不回归。
