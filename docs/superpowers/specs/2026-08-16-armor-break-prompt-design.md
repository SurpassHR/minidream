# 设计文档：破甲提示词预设（全局开关，插入所有系统提示词之前）

日期：2026-08-16
状态：已确认（全局单开关 + 预设默认空用户自填）

## 一、背景与目标

提示词库（角色系统提示词）已支持按名引用与回退。新增「破甲预设」：一个用户自填的预设文本 + 全局开关；开启时该文本插入到**所有系统提示词之前**（即每个 AI 功能最终组装 prompt 的最前面）。默认关闭、预设文本默认空。

## 二、已确认的关键决策

| 维度 | 决策 |
|---|---|
| 开关粒度 | 全局单开关（不按角色键细分） |
| 预设内容 | 默认空，用户自填（设置弹窗 textarea） |
| 插入位置 | 开启且文本非空时，插入到最终组装 prompt 最前面（所有系统提示词之前） |
| 存储 | `AppSettings.armorBreak: string` + `AppSettings.armorBreakEnabled: boolean`（settings.json，防御式读写） |
| 消费点 | 3 处：aiSuggest / runAction（总结+回填）/ aiOptimize |
| 执行方式 | 敏捷：spec 确认后直接写计划并执行 |

## 三、架构

```
SettingsModal 提示词库区块顶部
  ├─ 「⚔ 破甲预设」textarea（armorBreak）
  └─ 「开启破甲」checkbox（armorBreakEnabled）
        │ PUT /api/settings { armorBreak, armorBreakEnabled }（settings.json）
        ▼
App settings state → props（armorBreak / armorBreakEnabled 随 prompts 下传）
        ▼ 消费点：withArmorBreak(finalPrompt, armorBreak, enabled)
aiSuggest / runAction / aiOptimize → 破甲文本 + '\n\n' + 原 prompt
```

**后端**（`src/settings/settings-store.ts` + `src/api/routes.ts`）：
- `AppSettings` 增加 `armorBreak: string`（默认 ''）与 `armorBreakEnabled: boolean`（默认 false）。
- `readSettings`：缺失/非 string → ''；缺失/非 boolean → false。
- `saveSettings`：同白名单模式（类型校验后写入，未传保持现值）。
- `PUT /api/settings` 透传两字段（类型校验在 store 层）。

**前端**：
- `web/src/views/roles.ts` 新增纯函数：

```ts
// 破甲预设：开启且文本非空时插入到 prompt 最前面（所有系统提示词之前）
export function withArmorBreak(
  prompt: string,
  armorBreak?: string,
  armorBreakEnabled?: boolean,
): string {
  const t = armorBreak?.trim();
  return armorBreakEnabled && t ? `${t}\n\n${prompt}` : prompt;
}
```

- `App.tsx`：`settings.armorBreak` / `settings.armorBreakEnabled` 传给 `StoryTellerView` / `ObjectDesignerView`（新增可选 props）；`StoryTellerView` 透传 `StoryChat`。
- 消费点（3 处，包裹最终 prompt）：
  - `StoryTellerView.aiSuggest`：`const prompt = withArmorBreak(`${resolvePrompt(...)}\n\n当前步骤问题：...`, props.armorBreak, props.armorBreakEnabled);`
  - `StoryChat.runAction`：`const prompt = withArmorBreak(`${resolvePrompt(storyChat)}\n\n${system}`, props.armorBreak, props.armorBreakEnabled);`
  - `ObjectDesignerView.aiOptimize`：同 aiSuggest 模式。
- `web/src/types.ts`：`AppSettings` 增加两字段（镜像后端）。

**设置 UI**（SettingsModal 提示词库区块顶部）：
- 「⚔ 破甲预设」label + textarea（`data-testid="armor-break-text"`）+ hint「开启后插入到所有系统提示词之前」。
- 「开启破甲」checkbox（`data-testid="armor-break-enabled"`）。
- 打开时从 props.settings 同步；保存时携带两字段（类型：string / boolean）。

## 四、错误处理矩阵

| 场景 | 处理 |
|---|---|
| 关闭开关 | 不插入（prompt 原样） |
| 开启但文本为空/全空白 | 不插入（trim 后空判定） |
| settings.json 缺失/损坏/字段类型异常 | readSettings 返回 '' / false 默认 |
| 自定义提示词条目 | 与破甲无关（只有被消费的 5 键所在 prompt 受影响；全局开关统一生效） |

## 五、测试策略

| 层 | 用例 |
|---|---|
| `src/settings/settings-store.test.ts` | armorBreak 字段读写；缺失→''/false；非 string/boolean 防御；保存整体持久化 |
| `src/api/story-api.test.ts`（全局设置 describe） | PUT 携带 armorBreak/armorBreakEnabled 持久化读回 |
| `web/src/views/roles.test.ts` | withArmorBreak：关闭原样/开启空文本原样/开启非空前缀/trim |
| `web/src/views/StoryTeller.test.tsx` / `StoryChat.test.tsx` / `ObjectDesigner.test.tsx` | 开启+文本 → 请求体 message 以破甲文本开头；关闭 → 不含 |
| `web/src/panels/SettingsModal.test.tsx` | textarea/checkbox 渲染与同步；保存 payload 含两字段 |

## 六、验收标准

1. 设置弹窗提示词库区块顶部出现「破甲预设」textarea 与「开启破甲」checkbox。
2. 开启并填写文本后：AI 建议 / 物体 AI 优化 / 对话总结成稿与回填的请求 prompt 均以破甲文本开头（在所有系统提示词之前）。
3. 关闭开关或文本为空：prompt 与现状完全一致。
4. 配置持久化（settings.json），刷新/重启不丢。
5. 全部新增单测通过，现有测试不回归。
