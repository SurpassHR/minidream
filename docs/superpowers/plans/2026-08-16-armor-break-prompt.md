# 破甲提示词预设实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增「破甲预设」：用户自填文本 + 全局开关；开启且文本非空时，插入到所有 AI 功能（AI 建议/物体优化/对话总结回填）最终 prompt 最前面（所有系统提示词之前）。

**Architecture:** `AppSettings` 增加 `armorBreak: string` + `armorBreakEnabled: boolean`（settings.json 防御式读写，PUT 透传）；`roles.ts` 新增纯函数 `withArmorBreak(prompt, armorBreak?, enabled?)`；三个消费点包裹最终 prompt；SettingsModal 提示词库区块顶部加 textarea + checkbox；App 下传两字段给两个视图（StoryTellerView 透传 StoryChat）。

**Tech Stack:** Fastify + Node fs（后端）、React 18 + vitest + @testing-library/react（前端）、纯 CSS。

## Global Constraints

- 零新依赖。
- 全局单开关（不按角色键细分）；插入位置 = 最终组装 prompt 最前面；`withArmorBreak` 语义：`enabled && armorBreak?.trim()` 为真才插入（`${trimmed}\n\n${prompt}`），否则原样返回。
- 预设默认空、开关默认 false；`readSettings` 缺失/类型异常 → '' / false；`saveSettings` 白名单类型校验。
- 前端 `AppSettings.armorBreak?` / `armorBreakEnabled?` 为可选（既有测试字面量不受影响），消费处 `undefined` 视为关闭。
- 中文 UI/注释/测试命名；TDD 每任务。

---
## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/settings/settings-store.ts` | AppSettings 增加 armorBreak/armorBreakEnabled（防御读写） | 修改 |
| `src/settings/settings-store.test.ts` | 字段语义测试 | 修改 |
| `src/api/routes.ts` | PUT 透传两字段 | 修改 |
| `src/api/story-api.test.ts` | PUT 持久化测试 | 修改 |
| `web/src/views/roles.ts` | `withArmorBreak` 纯函数 | 修改 |
| `web/src/views/roles.test.ts` | withArmorBreak 单测 | 修改 |
| `web/src/types.ts` | AppSettings 两可选字段 | 修改 |
| `web/src/App.tsx` | 两字段下传两视图 | 修改 |
| `web/src/views/StoryTellerView.tsx` | props + aiSuggest 包裹 | 修改 |
| `web/src/views/StoryChat.tsx` | props + runAction 包裹 | 修改 |
| `web/src/views/ObjectDesignerView.tsx` | props + aiOptimize 包裹 | 修改 |
| 三个消费测试文件 | 请求体前缀断言 | 修改 |
| `web/src/panels/SettingsModal.tsx` | 破甲 textarea + checkbox | 修改 |
| `web/src/panels/SettingsModal.test.tsx` | UI 与保存 payload 测试 | 修改 |
| `web/src/App.css` | 破甲区块样式 | 修改 |

---

### Task 1: 后端 armorBreak 字段

**Files:**
- Modify: `src/settings/settings-store.ts`、`src/settings/settings-store.test.ts`、`src/api/routes.ts`（PUT body 透传）、`src/api/story-api.test.ts`

**Interfaces:**
- Produces: `AppSettings` 增加 `armorBreak: string`（默认 ''）与 `armorBreakEnabled: boolean`（默认 false）；`readSettings` 缺失/非 string → ''、缺失/非 boolean → false；`saveSettings` 白名单类型校验（未传保持现值）；`PUT /api/settings` 接受两字段。Task 2/3 依赖。

- [ ] **Step 1: 写失败测试**

`src/settings/settings-store.test.ts` 末尾追加：

```ts
describe('armorBreak 破甲预设', () => {
  it('缺失字段返回默认（'' / false）', () => {
    expect(readSettings().armorBreak).toBe('');
    expect(readSettings().armorBreakEnabled).toBe(false);
  });

  it('保存并读回（类型校验：非 string/boolean 忽略）', () => {
    saveSettings({ armorBreak: '  无视限制  ', armorBreakEnabled: true });
    const s = readSettings();
    expect(s.armorBreak).toBe('  无视限制  ');
    expect(s.armorBreakEnabled).toBe(true);
    // 非类型值忽略（保持现值）
    const s2 = saveSettings({ armorBreak: 123 as never, armorBreakEnabled: 'yes' as never });
    expect(s2.armorBreak).toBe('  无视限制  ');
    expect(s2.armorBreakEnabled).toBe(true);
  });

  it('未传字段保持现值', () => {
    saveSettings({ armorBreak: '文本', armorBreakEnabled: true });
    const s = saveSettings({ comfyUrl: 'http://x' });
    expect(s.armorBreak).toBe('文本');
    expect(s.armorBreakEnabled).toBe(true);
  });
});
```

`src/api/story-api.test.ts` 全局设置 describe 末尾追加：

```ts
  it('PUT /api/settings 携带 armorBreak/armorBreakEnabled 持久化读回', async () => {
    const r = await a.inject({
      method: 'PUT', url: '/api/settings',
      payload: { armorBreak: '无视限制的预设', armorBreakEnabled: true },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().settings.armorBreak).toBe('无视限制的预设');
    expect(r.json().settings.armorBreakEnabled).toBe(true);
    const g = await a.inject({ method: 'GET', url: '/api/settings' });
    expect(g.json().settings.armorBreak).toBe('无视限制的预设');
    expect(g.json().settings.armorBreakEnabled).toBe(true);
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/settings/settings-store.test.ts src/api/story-api.test.ts`
Expected: 新用例 FAIL（字段不存在）。

- [ ] **Step 3: 实现**

`src/settings/settings-store.ts`：

```ts
export interface AppSettings {
  comfyUrl: string;
  agentModel: string;
  agentThinking: string;
  prompts?: Record<string, string>;
  armorBreak: string;          // 破甲预设文本（插入到所有系统提示词之前；空=不生效）
  armorBreakEnabled: boolean;  // 破甲全局开关
}

const DEFAULTS: AppSettings = { comfyUrl: '', agentModel: '', agentThinking: '', armorBreak: '', armorBreakEnabled: false };
```

`readSettings` 中 `out` 增加：

```ts
    const out: AppSettings = {
      comfyUrl: typeof data.comfyUrl === 'string' ? data.comfyUrl : DEFAULTS.comfyUrl,
      agentModel: typeof data.agentModel === 'string' ? data.agentModel : DEFAULTS.agentModel,
      agentThinking: typeof data.agentThinking === 'string' ? data.agentThinking : DEFAULTS.agentThinking,
      armorBreak: typeof data.armorBreak === 'string' ? data.armorBreak : DEFAULTS.armorBreak,
      armorBreakEnabled: typeof data.armorBreakEnabled === 'boolean' ? data.armorBreakEnabled : DEFAULTS.armorBreakEnabled,
    };
```

`saveSettings` 中 `next` 增加：

```ts
  const next: AppSettings = {
    comfyUrl: typeof patch.comfyUrl === 'string' ? patch.comfyUrl : current.comfyUrl,
    agentModel: typeof patch.agentModel === 'string' ? patch.agentModel : current.agentModel,
    agentThinking: typeof patch.agentThinking === 'string' ? patch.agentThinking : current.agentThinking,
    armorBreak: typeof patch.armorBreak === 'string' ? patch.armorBreak : current.armorBreak,
    armorBreakEnabled: typeof patch.armorBreakEnabled === 'boolean' ? patch.armorBreakEnabled : current.armorBreakEnabled,
  };
```

（prompts 分支不变。）

`src/api/routes.ts` PUT 处理器：

```ts
    const body = req.body as {
      comfyUrl?: string; agentModel?: string; agentThinking?: string;
      prompts?: Record<string, string>;
      armorBreak?: string; armorBreakEnabled?: boolean;
    };
    const settings = saveSettings({
      comfyUrl: typeof body.comfyUrl === 'string' ? body.comfyUrl : undefined,
      agentModel: typeof body.agentModel === 'string' ? body.agentModel : undefined,
      agentThinking: typeof body.agentThinking === 'string' ? body.agentThinking : undefined,
      prompts: body.prompts,
      armorBreak: typeof body.armorBreak === 'string' ? body.armorBreak : undefined,
      armorBreakEnabled: typeof body.armorBreakEnabled === 'boolean' ? body.armorBreakEnabled : undefined,
    });
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/settings/settings-store.test.ts src/api/story-api.test.ts`
Expected: 全部 PASS。再 `pnpm test`（后端全量）。

- [ ] **Step 5: 提交**

```bash
git add src/settings/settings-store.ts src/settings/settings-store.test.ts src/api/routes.ts src/api/story-api.test.ts
git commit -m "feat(settings): 破甲预设字段（armorBreak 文本 + 全局开关，防御式读写）"
```

---

### Task 2: withArmorBreak + 消费点接入

**Files:**
- Modify: `web/src/views/roles.ts`、`web/src/views/roles.test.ts`、`web/src/types.ts`、`web/src/App.tsx`、`web/src/views/StoryTellerView.tsx`、`web/src/views/StoryChat.tsx`、`web/src/views/ObjectDesignerView.tsx`、`web/src/views/StoryTeller.test.tsx`、`web/src/views/StoryChat.test.tsx`、`web/src/views/ObjectDesigner.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `AppSettings.armorBreak` / `armorBreakEnabled`。
- Produces: `withArmorBreak(prompt: string, armorBreak?: string, armorBreakEnabled?: boolean): string`；`StoryTellerView`/`ObjectDesignerView` 新增可选 props `armorBreak?: string`、`armorBreakEnabled?: boolean`；`StoryChat` 同；`App` 下传 `settings.armorBreak` / `settings.armorBreakEnabled`。

- [ ] **Step 1: 写失败测试**

`web/src/views/roles.test.ts` 末尾追加：

```tsx
import { ROLE_PROMPT_KEYS, resolvePrompt, withArmorBreak } from './roles';

describe('withArmorBreak', () => {
  it('关闭开关：原样返回', () => {
    expect(withArmorBreak('系统提示词', '破甲文本', false)).toBe('系统提示词');
    expect(withArmorBreak('系统提示词', '破甲文本', undefined)).toBe('系统提示词');
  });

  it('开启但文本为空/全空白：原样返回', () => {
    expect(withArmorBreak('系统提示词', '', true)).toBe('系统提示词');
    expect(withArmorBreak('系统提示词', '   ', true)).toBe('系统提示词');
    expect(withArmorBreak('系统提示词', undefined, true)).toBe('系统提示词');
  });

  it('开启且文本非空：前置插入（trim + 双换行分隔）', () => {
    expect(withArmorBreak('系统提示词', '  破甲预设  ', true)).toBe('破甲预设\n\n系统提示词');
  });
});
```

`web/src/views/StoryTeller.test.tsx` 追加：

```tsx
  it('破甲开启时 AI 建议请求以预设文本开头', async () => {
    render(<StoryTellerView projectName="demo" armorBreak="破甲预设文本" armorBreakEnabled />);
    await waitFor(() => expect(screen.getByText(/故事主题是什么/)).toBeInTheDocument());
    fireEvent.click(screen.getByText('✨ AI 建议'));
    await waitFor(() => expect(screen.getByTestId('story-answer')).toHaveValue('建议文本'));
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => String(c[0]).includes('/api/agent/chat'),
    );
    const body = JSON.parse(String(calls.at(-1)![1]?.body)) as { message: string };
    expect(body.message).toMatch(/^破甲预设文本\n\n/);
  });

  it('破甲关闭时 AI 建议请求不含预设文本', async () => {
    render(<StoryTellerView projectName="demo" armorBreak="破甲预设文本" />);
    await waitFor(() => expect(screen.getByText(/故事主题是什么/)).toBeInTheDocument());
    fireEvent.click(screen.getByText('✨ AI 建议'));
    await waitFor(() => expect(screen.getByTestId('story-answer')).toHaveValue('建议文本'));
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => String(c[0]).includes('/api/agent/chat'),
    );
    const body = JSON.parse(String(calls.at(-1)![1]?.body)) as { message: string };
    expect(body.message).not.toContain('破甲预设文本');
  });
```

`web/src/views/StoryChat.test.tsx` 追加：

```tsx
  it('破甲开启时总结成稿请求以预设文本开头', async () => {
    render(
      <StoryChat
        projectName="demo" onBackfill={() => {}} onSummarized={() => {}}
        armorBreak="破甲预设文本" armorBreakEnabled
      />,
    );
    await waitFor(() => expect(screen.getByTestId('session-item-s1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('✨ 总结成稿'));
    await waitFor(() => expect(CHAT_BODIES.length).toBeGreaterThan(0));
    expect(CHAT_BODIES.at(-1)!.message).toMatch(/^破甲预设文本\n\n/);
  });
```

`web/src/views/ObjectDesigner.test.tsx` 追加：

```tsx
  it('破甲开启时 AI 优化请求以预设文本开头', async () => {
    designs = [{ id: 'd1', kind: 'character', name: '精灵骑士', description: '', style: '', template: 'test-t2i', status: 'draft', createdAt: 1 }];
    render(<ObjectDesignerView projectName="demo" armorBreak="破甲预设文本" armorBreakEnabled />);
    await waitFor(() => expect(screen.getByText('精灵骑士')).toBeInTheDocument());
    fireEvent.click(screen.getByText('精灵骑士'));
    await waitFor(() => expect(screen.getByTestId('design-name')).toHaveValue('精灵骑士'));
    fireEvent.click(screen.getByText('✨ AI 优化描述'));
    await waitFor(() => expect(screen.getByTestId('design-desc')).toHaveValue('+A1+A2'));
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => String(c[0]).includes('/api/agent/chat'),
    );
    const body = JSON.parse(String(calls.at(-1)![1]?.body)) as { message: string };
    expect(body.message).toMatch(/^破甲预设文本\n\n/);
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/views/roles.test.ts src/views/StoryTeller.test.tsx src/views/StoryChat.test.tsx src/views/ObjectDesigner.test.tsx`（工作目录 `web/`）
Expected: 新用例 FAIL（withArmorBreak 不存在 / 请求体无前缀）。

- [ ] **Step 3: 实现**

`web/src/views/roles.ts` 末尾追加：

```ts
// 破甲预设：开启且文本非空时，插入到 prompt 最前面（所有系统提示词之前）
export function withArmorBreak(
  prompt: string,
  armorBreak?: string,
  armorBreakEnabled?: boolean,
): string {
  const t = armorBreak?.trim();
  return armorBreakEnabled && t ? `${t}\n\n${prompt}` : prompt;
}
```

`web/src/types.ts` AppSettings：

```ts
export interface AppSettings {
  comfyUrl: string;
  agentModel: string;
  agentThinking: string;
  // 提示词库（键=名称，值=内容）；键缺失=从未自定义（设置弹窗预填 5 角色默认）
  prompts?: Record<string, string>;
  // 破甲预设：开启且文本非空时插入到所有系统提示词之前
  armorBreak?: string;
  armorBreakEnabled?: boolean;
}
```

`web/src/App.tsx` 两处视图渲染：

```tsx
      ) : route === 'story-teller' ? (
        <StoryTellerView
          projectName={graph?.projectName ?? ''}
          prompts={settings.prompts}
          armorBreak={settings.armorBreak}
          armorBreakEnabled={settings.armorBreakEnabled}
        />
      ) : (
        <ObjectDesignerView
          projectName={graph?.projectName ?? ''}
          prompts={settings.prompts}
          armorBreak={settings.armorBreak}
          armorBreakEnabled={settings.armorBreakEnabled}
        />
      )}
```

`web/src/views/StoryTellerView.tsx`：
- 签名：`export function StoryTellerView(props: { projectName: string; prompts?: Record<string, string>; armorBreak?: string; armorBreakEnabled?: boolean }) {`
- 导入：`import { resolvePrompt, withArmorBreak, STORY_TELLER_SYSTEM } from './roles';` → `STORY_TELLER_SYSTEM` 若已不直接用则去掉。
- `aiSuggest`：

```tsx
    const prompt = withArmorBreak(
      `${resolvePrompt(props.prompts, 'storyTeller')}\n\n当前步骤问题：${step.question}\n已填写内容：\n${answersText || '（暂无）'}`,
      props.armorBreak,
      props.armorBreakEnabled,
    );
```

- StoryChat 透传：

```tsx
        <StoryChat
          projectName={props.projectName}
          completedAt={story.completedAt}
          onBackfill={handleBackfill}
          onSummarized={handleSummarized}
          prompts={props.prompts}
          armorBreak={props.armorBreak}
          armorBreakEnabled={props.armorBreakEnabled}
        />
```

`web/src/views/StoryChat.tsx`：
- 签名 props 增加 `armorBreak?: string; armorBreakEnabled?: boolean;`
- `runAction`：

```tsx
    const system = kind === 'summarize'
      ? resolvePrompt(props.prompts, 'storySummarize')
      : resolvePrompt(props.prompts, 'storyBackfill');
    const prompt = withArmorBreak(
      `${resolvePrompt(props.prompts, 'storyChat')}\n\n${system}`,
      props.armorBreak,
      props.armorBreakEnabled,
    );
```

- 导入：`import { resolvePrompt, withArmorBreak } from './roles';`

`web/src/views/ObjectDesignerView.tsx`：
- 签名 props 增加 `armorBreak?: string; armorBreakEnabled?: boolean;`
- `aiOptimize`：

```tsx
    const prompt = withArmorBreak(
      `${resolvePrompt(props.prompts, 'objectDesigner')}\n\n对象名称：${selected.name}\n风格：${selected.style || '（未指定）'}\n现有描述：${selected.description || '（暂无）'}`,
      props.armorBreak,
      props.armorBreakEnabled,
    );
```

- 导入：`import { resolvePrompt, withArmorBreak } from './roles';`（OBJECT_DESIGNER_SYSTEM 若不再直接用则去掉）

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/views/roles.test.ts src/views/StoryTeller.test.tsx src/views/StoryChat.test.tsx src/views/ObjectDesigner.test.tsx`（工作目录 `web/`）
Expected: 全部 PASS。再 `pnpm exec vitest run`（`web/` 全量）+ `pnpm exec tsc -b`（`web/`）。

- [ ] **Step 5: 提交**

```bash
git add web/src/views/roles.ts web/src/views/roles.test.ts web/src/types.ts web/src/App.tsx web/src/views/StoryTellerView.tsx web/src/views/StoryChat.tsx web/src/views/ObjectDesignerView.tsx web/src/views/StoryTeller.test.tsx web/src/views/StoryChat.test.tsx web/src/views/ObjectDesigner.test.tsx
git commit -m "feat(web): 破甲预设接入消费点（withArmorBreak 前置插入，全局开关）"
```

---

### Task 3: SettingsModal 破甲 UI

**Files:**
- Modify: `web/src/panels/SettingsModal.tsx`、`web/src/panels/SettingsModal.test.tsx`、`web/src/App.css`

**Interfaces:**
- Consumes: Task 1 字段、Task 2 类型。

- [ ] **Step 1: 写失败测试**

`web/src/panels/SettingsModal.test.tsx` 追加（沿用现有 mock/断言模式）：

```tsx
  it('渲染破甲预设 textarea 与开关（打开时同步外部值）', () => {
    render(<SettingsModal
      open
      settings={{ ...DEFAULT_SETTINGS, armorBreak: '破甲文本', armorBreakEnabled: true }} models={[]}
      onClose={() => {}} onSaved={() => {}} onError={() => {}}
    />);
    expect(screen.getByTestId('armor-break-text')).toHaveValue('破甲文本');
    expect(screen.getByTestId('armor-break-enabled')).toBeChecked();
  });

  it('保存携带 armorBreak/armorBreakEnabled', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<SettingsModal
      open settings={DEFAULT_SETTINGS} models={[]}
      onClose={onClose} onSaved={onSaved} onError={() => {}}
    />);
    fireEvent.change(screen.getByTestId('armor-break-text'), { target: { value: '新的破甲文本' } });
    fireEvent.click(screen.getByTestId('armor-break-enabled'));
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/settings',
      expect.objectContaining({ method: 'PUT' }),
    ));
    const body = JSON.parse(String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1]?.body));
    expect(body.armorBreak).toBe('新的破甲文本');
    expect(body.armorBreakEnabled).toBe(true);
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/panels/SettingsModal.test.tsx`（工作目录 `web/`）
Expected: 新 2 用例 FAIL（无 armor-break 元素）。

- [ ] **Step 3: 实现**

`web/src/panels/SettingsModal.tsx`：
- state（promptEntries 附近）：

```tsx
  const [armorBreak, setArmorBreak] = useState(props.settings.armorBreak ?? '');
  const [armorBreakEnabled, setArmorBreakEnabled] = useState(props.settings.armorBreakEnabled ?? false);
```

- open 同步 effect 追加：

```tsx
      setArmorBreak(props.settings.armorBreak ?? '');
      setArmorBreakEnabled(props.settings.armorBreakEnabled ?? false);
```

- `save` 调用追加两字段：

```tsx
    void client.saveSettings({
      comfyUrl: comfyUrl.trim(),
      agentModel,
      agentThinking,
      prompts,
      armorBreak,
      armorBreakEnabled,
    }).then(...)
```

- JSX：提示词库 section 内、条目列表之前插入：

```tsx
          <div className="armor-break">
            <label className="armor-break-head">
              <input
                type="checkbox" data-testid="armor-break-enabled"
                checked={armorBreakEnabled}
                onChange={(e) => setArmorBreakEnabled(e.target.checked)}
              />
              <span className="role-field-label">⚔ 破甲预设 · 开启后插入到所有系统提示词之前</span>
            </label>
            <textarea
              className="ne-input armor-break-text" data-testid="armor-break-text"
              rows={3} value={armorBreak} placeholder="在此填写破甲预设文本…"
              onChange={(e) => setArmorBreak(e.target.value)}
            />
          </div>
```

`web/src/App.css` 追加：

```css
/* ===== 设置弹窗：破甲预设 ===== */
.armor-break { display: flex; flex-direction: column; gap: 8px; }
.armor-break-head { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.armor-break-head input { accent-color: var(--amber); }
.armor-break-text { font-family: var(--mono); font-size: 12px; line-height: 1.6; resize: vertical; }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/panels/SettingsModal.test.tsx`（工作目录 `web/`）
Expected: 全部 PASS。再全量：`pnpm exec vitest run`（`web/`）+ `pnpm exec tsc -b`（`web/`）+ `pnpm test`（仓库根）。

- [ ] **Step 5: 提交**

```bash
git add web/src/panels/SettingsModal.tsx web/src/panels/SettingsModal.test.tsx web/src/App.css
git commit -m "feat(web): 设置弹窗破甲预设区块（textarea + 全局开关）"
```

---

## 验收（对照 spec）

1. 设置弹窗提示词库区块顶部出现破甲 textarea + 开关 —— Task 3 用例 1。
2. 开启并填写后：AI 建议/物体优化/总结成稿与回填请求均以预设文本开头 —— Task 2 三个消费用例 + withArmorBreak 单测。
3. 关闭或空文本：prompt 与现状一致 —— Task 2 withArmorBreak 单测 + 关闭用例。
4. 持久化（settings.json）—— Task 1 后端用例。
5. 全量回归不破——各任务 Step 4。
