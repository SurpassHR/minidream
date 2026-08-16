# 角色系统提示词库实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在全局设置弹窗中提供可增删的提示词库（5 个角色系统提示词预置，CRUD + 重置默认），AI 功能按名称引用，缺省回退 `roles.ts` 内置默认。

**Architecture:** 后端 `settings.json` 的 `AppSettings.prompts?: Record<string,string>` 存库（整体替换写语义，键缺失=从未自定义）；前端 `roles.ts` 定义 `ROLE_PROMPT_KEYS` + `resolvePrompt`；App 持 settings 并下传 props；SettingsModal 增「提示词库」区块；三个消费点（AI 建议 / runAction / AI 优化）改用 resolvePrompt。

**Tech Stack:** Fastify + Node fs（后端）、React 18 + vitest + @testing-library/react（前端）、纯 CSS。

## Global Constraints

- 零新依赖。
- 内置默认唯一来源 = `web/src/views/roles.ts` 现有 5 常量；`resolvePrompt(prompts, key) = prompts?.[key] || ROLE_PROMPT_KEYS[key]`（空串视为未配置）。
- 固定 5 消费键：`storyTeller` / `objectDesigner` / `storyChat` / `storySummarize` / `storyBackfill`。
- `prompts` 字段缺失 = 从未自定义（前端预填 5 默认条目）；`prompts: {}` = 已保存空库（不预填，删除不复活）；保存时总是写入（含空对象）。
- 中文 UI/注释/测试命名，沿用项目惯例。
- 所有改动 TDD：先写失败测试，再实现，再提交。

---
## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/settings/settings-store.ts` | AppSettings.prompts 读/写（整体替换 + 防御过滤） | 修改 |
| `src/settings/settings-store.test.ts` | prompts 存储语义测试 | 修改 |
| `src/api/routes.ts` | PUT /api/settings 透传 prompts | 修改 |
| `src/api/story-api.test.ts` | 全局设置 describe 追加 prompts API 测试 | 修改 |
| `web/src/views/roles.ts` | `ROLE_PROMPT_KEYS` + `resolvePrompt` | 修改 |
| `web/src/views/roles.test.ts` | resolvePrompt / 键表完整性测试 | 新建 |
| `web/src/App.tsx` | settings.prompts 下传两个视图 | 修改 |
| `web/src/views/StoryTellerView.tsx` | prompts prop + aiSuggest 消费 + 透传 StoryChat | 修改 |
| `web/src/views/StoryChat.tsx` | prompts prop + runAction 消费 | 修改 |
| `web/src/views/ObjectDesignerView.tsx` | prompts prop + aiOptimize 消费 | 修改 |
| `web/src/views/StoryTeller.test.tsx` / `StoryChat.test.tsx` / `ObjectDesigner.test.tsx` | 消费点测试 | 修改 |
| `web/src/panels/SettingsModal.tsx` | 提示词库区块（列表/增/删/改/重置/保存） | 修改 |
| `web/src/panels/SettingsModal.test.tsx` | 提示词库 UI 测试 | 修改 |
| `web/src/App.css` | 提示词库样式 | 修改 |
| `web/src/types.ts` | AppSettings.prompts? | 修改 |

---

### Task 1: 后端 prompts 存储

**Files:**
- Modify: `src/settings/settings-store.ts`、`src/settings/settings-store.test.ts`、`src/api/routes.ts:361-369`（PUT 透传）、`src/api/story-api.test.ts`（全局设置 describe 追加）
- Test: `src/settings/settings-store.test.ts`、`src/api/story-api.test.ts`

**Interfaces:**
- Produces: `AppSettings` 增加 `prompts?: Record<string, string>`（缺失=从未自定义）；`readSettings()` 缺失字段返回无 prompts 键、`{}` 保留、非 string 值过滤；`saveSettings(patch)` 中 `patch.prompts` 为对象时整体替换（过滤后总是写入，含 `{}`）、非对象时保持现值；`PUT /api/settings` 接受 `prompts` 字段。Task 2/4 依赖此形状。

- [ ] **Step 1: 写失败测试**

在 `src/settings/settings-store.test.ts` 末尾追加 describe：

```ts
describe('prompts 提示词库', () => {
  it('缺失 prompts 字段时返回 undefined（从未自定义）', () => {
    expect(readSettings().prompts).toBeUndefined();
  });

  it('保存 prompts 整体替换（增/改/删）且总是写入', () => {
    saveSettings({ prompts: { storyTeller: 'A', custom: 'B' } });
    expect(readSettings().prompts).toEqual({ storyTeller: 'A', custom: 'B' });
    // 整体替换：删 storyTeller、改 custom、加 storyChat
    saveSettings({ prompts: { custom: 'B2', storyChat: 'C' } });
    expect(readSettings().prompts).toEqual({ custom: 'B2', storyChat: 'C' });
  });

  it('空对象保留（已保存空库不复活）', () => {
    saveSettings({ prompts: {} });
    expect(readSettings().prompts).toEqual({});
  });

  it('非 string 值过滤；未传 prompts 保持现值', () => {
    saveSettings({ prompts: { a: 'ok', b: 123 as never, c: null as never } });
    expect(readSettings().prompts).toEqual({ a: 'ok' });
    const s = saveSettings({ comfyUrl: 'http://x' });
    expect(s.prompts).toEqual({ a: 'ok' });
  });

  it('损坏文件返回默认（prompts undefined，不抛错）', () => {
    mkdirSync(join(fakeHome, '.director'), { recursive: true });
    writeFileSync(join(fakeHome, '.director', 'settings.json'), '{broken', 'utf8');
    expect(readSettings().prompts).toBeUndefined();
  });
});
```

在 `src/api/story-api.test.ts` 的 `describe('API 全局设置')` 末尾追加：

```ts
  it('PUT /api/settings 携带 prompts 持久化并读回（整体替换）', async () => {
    const r = await a.inject({
      method: 'PUT', url: '/api/settings',
      payload: { prompts: { storyTeller: '定制', custom: 'x' } },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().settings.prompts).toEqual({ storyTeller: '定制', custom: 'x' });
    const g = await a.inject({ method: 'GET', url: '/api/settings' });
    expect(g.json().settings.prompts).toEqual({ storyTeller: '定制', custom: 'x' });
    // 整体替换：删 custom 并改 storyTeller
    const r2 = await a.inject({
      method: 'PUT', url: '/api/settings',
      payload: { prompts: { storyTeller: '定制2' } },
    });
    expect(r2.json().settings.prompts).toEqual({ storyTeller: '定制2' });
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/settings/settings-store.test.ts src/api/story-api.test.ts`
Expected: 新用例 FAIL（`prompts` 属性不存在 / `toBeUndefined` 不满足），其余 PASS。

- [ ] **Step 3: 实现**

`src/settings/settings-store.ts` 全量替换：

```ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// 全局设置：~/.director/settings.json（用户级，跨项目生效）
// 存 ComfyUI 地址 + agent 默认模型 + 思考强度 + 提示词库（prompts）；
// 目录用函数式求值（每次操作读取当前 HOME），测试 vi.stubEnv('HOME') 隔离不污染真实文件

export interface AppSettings {
  comfyUrl: string;      // ComfyUI 地址（http://...）
  agentModel: string;    // agent 默认模型 id（provider/model；空串 = pi 默认）
  agentThinking: string; // 思考强度（off/minimal/low/medium/high/xhigh/max；空串 = pi 默认）
  prompts?: Record<string, string>; // 提示词库（键=名称，值=内容）；键缺失=从未自定义
}

const DEFAULTS: AppSettings = { comfyUrl: '', agentModel: '', agentThinking: '' };

function settingsFile(): string {
  return join(homedir(), '.director', 'settings.json');
}

// prompts 防御过滤：仅保留值为 string 的键；非对象输入视为空对象
function filterPrompts(p: unknown): Record<string, string> {
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

// 读取设置；文件缺失/损坏返回默认值（防御式）
export function readSettings(): AppSettings {
  const f = settingsFile();
  if (!existsSync(f)) return { ...DEFAULTS };
  try {
    const data = JSON.parse(readFileSync(f, 'utf8')) as Partial<AppSettings>;
    const out: AppSettings = {
      comfyUrl: typeof data.comfyUrl === 'string' ? data.comfyUrl : DEFAULTS.comfyUrl,
      agentModel: typeof data.agentModel === 'string' ? data.agentModel : DEFAULTS.agentModel,
      agentThinking: typeof data.agentThinking === 'string' ? data.agentThinking : DEFAULTS.agentThinking,
    };
    // 键缺失（undefined）= 从未自定义，保持 out 无 prompts 键；
    // 已存在（含 {}）= 已保存过，原样过滤返回（删除的条目不复活）
    if (data.prompts !== undefined) {
      out.prompts = filterPrompts(data.prompts);
    }
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}

// 保存设置：只更新传入字段（白名单），未传字段保持现值；原子写（tmp + rename）
// prompts 为整体替换语义：传入对象则过滤后整体替换并总是写入（含空对象），未传则保持现值
export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const current = readSettings();
  const next: AppSettings = {
    comfyUrl: typeof patch.comfyUrl === 'string' ? patch.comfyUrl : current.comfyUrl,
    agentModel: typeof patch.agentModel === 'string' ? patch.agentModel : current.agentModel,
    agentThinking: typeof patch.agentThinking === 'string' ? patch.agentThinking : current.agentThinking,
  };
  if (patch.prompts !== undefined) {
    next.prompts = (typeof patch.prompts === 'object' && patch.prompts !== null && !Array.isArray(patch.prompts))
      ? filterPrompts(patch.prompts)
      : current.prompts;
  } else {
    next.prompts = current.prompts;
  }
  const f = settingsFile();
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  renameSync(tmp, f);
  return next;
}
```

`src/api/routes.ts` PUT 处理器（361-369 行）改为：

```ts
  app.put('/api/settings', async (req) => {
    const body = req.body as {
      comfyUrl?: string; agentModel?: string; agentThinking?: string; prompts?: Record<string, string>;
    };
    const settings = saveSettings({
      comfyUrl: typeof body.comfyUrl === 'string' ? body.comfyUrl : undefined,
      agentModel: typeof body.agentModel === 'string' ? body.agentModel : undefined,
      agentThinking: typeof body.agentThinking === 'string' ? body.agentThinking : undefined,
      prompts: body.prompts,
    });
```

（其余不变：comfyUrl 热切换逻辑、`return { settings }`。）

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/settings/settings-store.test.ts src/api/story-api.test.ts`
Expected: 全部 PASS（新 6 + 原有全部）。

- [ ] **Step 5: 提交**

```bash
git add src/settings/settings-store.ts src/settings/settings-store.test.ts src/api/routes.ts src/api/story-api.test.ts
git commit -m "feat(settings): 提示词库存储（AppSettings.prompts 整体替换 + 防御过滤）"
```

---

### Task 2: 前端键表 + resolvePrompt + props 接线

**Files:**
- Modify: `web/src/views/roles.ts`、`web/src/App.tsx`、`web/src/views/StoryTellerView.tsx`（props + 透传）、`web/src/views/StoryChat.tsx`（props）、`web/src/views/ObjectDesignerView.tsx`（props）、`web/src/types.ts`
- Create: `web/src/views/roles.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `AppSettings.prompts?` 形状。
- Produces: `ROLE_PROMPT_KEYS: { storyTeller: STORY_TELLER_SYSTEM, objectDesigner: OBJECT_DESIGNER_SYSTEM, storyChat: STORY_CHAT_SYSTEM, storySummarize: STORY_SUMMARIZE_PROMPT, storyBackfill: STORY_BACKFILL_PROMPT }`；`resolvePrompt(prompts: Record<string,string> | undefined, key: keyof typeof ROLE_PROMPT_KEYS): string`；`StoryTellerView`/`ObjectDesignerView` 新增可选 prop `prompts?: Record<string,string>`；`StoryChat` 新增同 prop；`App` 把 `settings.prompts` 传给两个视图。Task 3/4 依赖。

- [ ] **Step 1: 写失败测试**

创建 `web/src/views/roles.test.ts`：

```tsx
import { describe, expect, it } from 'vitest';
import { ROLE_PROMPT_KEYS, resolvePrompt } from './roles';

describe('resolvePrompt', () => {
  it('命中配置值', () => {
    expect(resolvePrompt({ storyTeller: '定制' }, 'storyTeller')).toBe('定制');
  });

  it('未配置（undefined / 空对象）回退内置默认', () => {
    expect(resolvePrompt(undefined, 'storyTeller')).toBe(ROLE_PROMPT_KEYS.storyTeller);
    expect(resolvePrompt({}, 'objectDesigner')).toBe(ROLE_PROMPT_KEYS.objectDesigner);
  });

  it('空串视为未配置', () => {
    expect(resolvePrompt({ storyChat: '' }, 'storyChat')).toBe(ROLE_PROMPT_KEYS.storyChat);
  });

  it('5 个角色键均有非空内置默认', () => {
    expect(Object.keys(ROLE_PROMPT_KEYS)).toHaveLength(5);
    expect(Object.keys(ROLE_PROMPT_KEYS).sort()).toEqual(
      ['objectDesigner', 'storyBackfill', 'storyChat', 'storySummarize', 'storyTeller'],
    );
    for (const v of Object.values(ROLE_PROMPT_KEYS)) {
      expect(v.trim().length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/views/roles.test.ts`（工作目录 `web/`）
Expected: FAIL（`ROLE_PROMPT_KEYS` / `resolvePrompt` 不存在）。

- [ ] **Step 3: 实现**

`web/src/views/roles.ts` 末尾追加（保留现有 5 常量不动）：

```ts
// 角色提示词库键表：键=消费键（设置里提示词库的条目名），值=内置默认（回退来源）
export const ROLE_PROMPT_KEYS = {
  storyTeller: STORY_TELLER_SYSTEM,
  objectDesigner: OBJECT_DESIGNER_SYSTEM,
  storyChat: STORY_CHAT_SYSTEM,
  storySummarize: STORY_SUMMARIZE_PROMPT,
  storyBackfill: STORY_BACKFILL_PROMPT,
} as const;

export type RolePromptKey = keyof typeof ROLE_PROMPT_KEYS;

// 解析提示词：配置命中（非空串）用之，否则回退内置默认
export function resolvePrompt(
  prompts: Record<string, string> | undefined,
  key: RolePromptKey,
): string {
  return prompts?.[key] || ROLE_PROMPT_KEYS[key];
}
```

`web/src/types.ts` AppSettings 增加（105 行附近）：

```ts
export interface AppSettings {
  comfyUrl: string;
  agentModel: string;
  agentThinking: string;
  // 提示词库（键=名称，值=内容）；键缺失=从未自定义（设置弹窗预填 5 角色默认）
  prompts?: Record<string, string>;
}
```

`web/src/App.tsx` 两处视图渲染传 prop（399-402 行附近）：

```tsx
      ) : route === 'story-teller' ? (
        <StoryTellerView projectName={graph?.projectName ?? ''} prompts={settings.prompts} />
      ) : (
        <ObjectDesignerView projectName={graph?.projectName ?? ''} prompts={settings.prompts} />
      )}
```

`web/src/views/StoryTellerView.tsx` 签名与透传（20 行与 215-220 行附近）：

```tsx
export function StoryTellerView(props: { projectName: string; prompts?: Record<string, string> }) {
```

```tsx
        <StoryChat
          projectName={props.projectName}
          completedAt={story.completedAt}
          onBackfill={handleBackfill}
          onSummarized={handleSummarized}
          prompts={props.prompts}
        />
```

`web/src/views/StoryChat.tsx` 签名（23-31 行附近）：

```tsx
export function StoryChat(props: {
  projectName: string;
  // 回填向导成功回调：携带解析出的答案（父组件写入 story.json 并切回向导式）
  onBackfill: (answers: Record<string, string>) => void;
  // 总结成稿成功回调：携带解析出的答案（父组件先 saveStory 再 completeStory 入库）
  onSummarized: (answers: Record<string, string>) => void;
  // 故事完成时间（总结成稿入库后非空）：对话式顶部显示完成提示条
  completedAt?: string | null;
  // 提示词库（角色系统提示词；未配置键回退内置默认）
  prompts?: Record<string, string>;
}) {
```

`web/src/views/ObjectDesignerView.tsx` 签名（组件函数签名处，约 30 行）：

```tsx
export function ObjectDesignerView(props: { projectName: string; prompts?: Record<string, string> }) {
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/views/roles.test.ts`（工作目录 `web/`）
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add web/src/views/roles.ts web/src/views/roles.test.ts web/src/types.ts web/src/App.tsx web/src/views/StoryTellerView.tsx web/src/views/StoryChat.tsx web/src/views/ObjectDesignerView.tsx
git commit -m "feat(web): 角色提示词键表 + resolvePrompt 回退 + 视图 prompts 接线"
```

---

### Task 3: 消费点接入（AI 建议 / runAction / AI 优化）

**Files:**
- Modify: `web/src/views/StoryTellerView.tsx`（aiSuggest）、`web/src/views/StoryChat.tsx`（runAction）、`web/src/views/ObjectDesignerView.tsx`（aiOptimize）
- Test: `web/src/views/StoryTeller.test.tsx`、`web/src/views/StoryChat.test.tsx`、`web/src/views/ObjectDesigner.test.tsx`

**Interfaces:**
- Consumes: Task 2 的 `resolvePrompt` 与 `prompts` props。

- [ ] **Step 1: 写失败测试**

`web/src/views/StoryTeller.test.tsx` 的 `describe('StoryTellerView')` 末尾追加：

```tsx
  it('AI 建议使用配置的 storyTeller 提示词', async () => {
    render(<StoryTellerView projectName="demo" prompts={{ storyTeller: '定制建议系统提示词' }} />);
    await waitFor(() => expect(screen.getByText(/故事主题是什么/)).toBeInTheDocument());
    fireEvent.click(screen.getByText('✨ AI 建议'));
    await waitFor(() => expect(screen.getByTestId('story-answer')).toHaveValue('建议文本'));
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => String(c[0]).includes('/api/agent/chat'),
    );
    const body = JSON.parse(String(calls.at(-1)![1]?.body)) as { message: string };
    expect(body.message).toContain('定制建议系统提示词');
    expect(body.message).not.toContain('你是导演工作台的故事向导角色');
  });
```

`web/src/views/StoryChat.test.tsx` 的 `describe('StoryChat')` 末尾追加：

```tsx
  it('总结成稿使用配置的 storyChat + storySummarize 提示词', async () => {
    const onSummarized = vi.fn();
    render(
      <StoryChat
        projectName="demo"
        onBackfill={() => {}}
        onSummarized={onSummarized}
        prompts={{ storyChat: '定制编剧', storySummarize: '定制总结' }}
      />,
    );
    await waitFor(() => expect(screen.getByText('我想做精灵与哥布林的故事')).toBeInTheDocument());
    fireEvent.click(screen.getByText('✨ 总结成稿'));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/story/chat'),
      expect.objectContaining({ method: 'POST' }),
    ));
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => String(c[0]).includes('/api/story/chat') && (c[1] as RequestInit)?.method === 'POST',
    );
    const body = JSON.parse(String(calls.at(-1)![1]?.body)) as { message: string };
    expect(body.message).toContain('定制编剧');
    expect(body.message).toContain('定制总结');
    expect(body.message).not.toContain('你是导演工作台的故事编剧');
  });
```

`web/src/views/ObjectDesigner.test.tsx` 末尾追加（沿用现有「AI 优化」用例的预置对象 + 流式 mock 模式）：

```tsx
  it('AI 优化使用配置的 objectDesigner 提示词', async () => {
    designs = [{ id: 'd1', kind: 'character', name: '精灵骑士', description: '', style: '', template: 'test-t2i', status: 'draft', createdAt: 1 }];
    render(<ObjectDesignerView projectName="demo" prompts={{ objectDesigner: '定制物体提示词' }} />);
    await waitFor(() => expect(screen.getByText('精灵骑士')).toBeInTheDocument());
    fireEvent.click(screen.getByText('精灵骑士'));
    await waitFor(() => expect(screen.getByTestId('design-name')).toHaveValue('精灵骑士'));
    fireEvent.click(screen.getByText('✨ AI 优化描述'));
    await waitFor(() => expect(screen.getByTestId('design-desc')).toHaveValue('+A1+A2'));
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => String(c[0]).includes('/api/agent/chat'),
    );
    const body = JSON.parse(String(calls.at(-1)![1]?.body)) as { message: string };
    expect(body.message).toContain('定制物体提示词');
    expect(body.message).not.toContain('你是导演工作台的物体设计师角色');
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/views/StoryTeller.test.tsx src/views/StoryChat.test.tsx src/views/ObjectDesigner.test.tsx`（工作目录 `web/`）
Expected: 新 3 用例 FAIL（message 不含配置文本——仍为内置默认），其余 PASS。

- [ ] **Step 3: 实现**

`web/src/views/StoryTellerView.tsx`：
- 导入改为：`import { resolvePrompt, STORY_TELLER_SYSTEM } from './roles';` → 若不再直接用常量则去掉 `STORY_TELLER_SYSTEM` 导入（aiSuggest 用 resolvePrompt 后该常量不再被引用，删除导入避免未使用告警）。
- `aiSuggest` 中（约 122 行）：

```tsx
    const prompt = `${resolvePrompt(props.prompts, 'storyTeller')}\n\n当前步骤问题：${step.question}\n已填写内容：\n${answersText || '（暂无）'}`;
```

`web/src/views/StoryChat.tsx`：
- 导入改为：`import { resolvePrompt } from './roles';`（原 `STORY_BACKFILL_PROMPT, STORY_CHAT_SYSTEM, STORY_SUMMARIZE_PROMPT` 不再直接引用，删除）。
- `runAction` 中（约 92 行）：

```tsx
    const system = kind === 'summarize'
      ? resolvePrompt(props.prompts, 'storySummarize')
      : resolvePrompt(props.prompts, 'storyBackfill');
    const prompt = `${resolvePrompt(props.prompts, 'storyChat')}\n\n${system}`;
```

`web/src/views/ObjectDesignerView.tsx`：
- 导入改为：`import { resolvePrompt, OBJECT_DESIGNER_SYSTEM } from './roles';` → 若不再直接用常量则去掉 `OBJECT_DESIGNER_SYSTEM` 导入。
- `aiOptimize` 中（约 111 行）：

```tsx
    const prompt = `${resolvePrompt(props.prompts, 'objectDesigner')}\n\n对象名称：${selected.name}\n风格：${selected.style || '（未指定）'}\n现有描述：${selected.description || '（暂无）'}`;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/views/StoryTeller.test.tsx src/views/StoryChat.test.tsx src/views/ObjectDesigner.test.tsx src/views/roles.test.ts`（工作目录 `web/`）
Expected: 全部 PASS。再跑 `pnpm exec tsc -b`（`web/`）确认无未使用导入等类型问题。

- [ ] **Step 5: 提交**

```bash
git add web/src/views/StoryTellerView.tsx web/src/views/StoryChat.tsx web/src/views/ObjectDesignerView.tsx web/src/views/StoryTeller.test.tsx web/src/views/StoryChat.test.tsx web/src/views/ObjectDesigner.test.tsx
git commit -m "feat(web): 消费点接入提示词库（AI 建议/对话总结回填/物体优化按名引用）"
```

---

### Task 4: SettingsModal 提示词库区块

**Files:**
- Modify: `web/src/panels/SettingsModal.tsx`、`web/src/panels/SettingsModal.test.tsx`、`web/src/App.css`

**Interfaces:**
- Consumes: Task 1 `settings.prompts`（undefined=从未自定义）、Task 2 `ROLE_PROMPT_KEYS`。

- [ ] **Step 1: 写失败测试**

在 `web/src/panels/SettingsModal.test.tsx` 的 `describe('SettingsModal')` 内追加（保存 payload 断言沿用现有 `mock.calls.at(-1)` 模式）：

```tsx
  it('首次打开（prompts undefined）预填 5 角色条目（内容=内置默认）', () => {
    render(<SettingsModal
      open settings={DEFAULT_SETTINGS} models={[]}
      onClose={() => {}} onSaved={() => {}} onError={() => {}}
    />);
    // 5 个角色名称输入
    for (const n of ['storyTeller', 'objectDesigner', 'storyChat', 'storySummarize', 'storyBackfill']) {
      expect(screen.getByDisplayValue(n)).toBeInTheDocument();
    }
    // 故事向导条目内容 = 内置默认
    expect(screen.getByDisplayValue(/你是导演工作台的「故事向导」角色/)).toBeInTheDocument();
  });

  it('已保存 prompts 直接展示（含自定义条目），不预填', () => {
    render(<SettingsModal
      open
      settings={{ ...DEFAULT_SETTINGS, prompts: { custom: '自定义内容' } }} models={[]}
      onClose={() => {}} onSaved={() => {}} onError={() => {}}
    />);
    expect(screen.getByDisplayValue('custom')).toBeInTheDocument();
    expect(screen.getByDisplayValue('自定义内容')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('storyTeller')).not.toBeInTheDocument();
  });

  it('新增/编辑/删除条目', () => {
    render(<SettingsModal
      open settings={DEFAULT_SETTINGS} models={[]}
      onClose={() => {}} onSaved={() => {}} onError={() => {}}
    />);
    // 新增：种子 5 条后新条目索引为 5
    fireEvent.click(screen.getByTestId('prompt-add'));
    expect(screen.getByTestId('prompt-name-5')).toHaveValue('新提示词 1');
    fireEvent.change(screen.getByTestId('prompt-name-5'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByTestId('prompt-text-5'), { target: { value: '自定义内容' } });
    expect(screen.getByDisplayValue('自定义内容')).toBeInTheDocument();
    // 删除索引 1（objectDesigner）
    fireEvent.click(screen.getByTestId('prompt-del-1'));
    expect(screen.queryByDisplayValue('objectDesigner')).not.toBeInTheDocument();
  });

  it('重置为默认提示词：恢复 5 角色条目（自定义保留）', () => {
    render(<SettingsModal
      open
      settings={{ ...DEFAULT_SETTINGS, prompts: { storyTeller: '改过', custom: 'x' } }} models={[]}
      onClose={() => {}} onSaved={() => {}} onError={() => {}}
    />);
    fireEvent.click(screen.getByText('↺ 重置为默认提示词'));
    expect(screen.getByDisplayValue(/你是导演工作台的「故事向导」角色/)).toBeInTheDocument();
    expect(screen.getByDisplayValue('custom')).toBeInTheDocument();
    expect(screen.getByDisplayValue('storyBackfill')).toBeInTheDocument();
  });

  it('保存携带 prompts（整体 map；空名称行丢弃）', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<SettingsModal
      open settings={DEFAULT_SETTINGS} models={[]}
      onClose={onClose} onSaved={onSaved} onError={() => {}}
    />);
    fireEvent.change(screen.getByTestId('prompt-text-0'), { target: { value: '定制故事向导' } });
    fireEvent.click(screen.getByTestId('prompt-add'));
    fireEvent.change(screen.getByTestId('prompt-name-5'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByTestId('prompt-text-5'), { target: { value: '自定义内容' } });
    fireEvent.change(screen.getByTestId('prompt-name-4'), { target: { value: '   ' } }); // 空名称 → 保存时丢弃
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/settings',
      expect.objectContaining({ method: 'PUT' }),
    ));
    const body = JSON.parse(String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1]?.body));
    expect(body.prompts.storyTeller).toBe('定制故事向导');
    expect(body.prompts.custom).toBe('自定义内容');
    expect(body.prompts.storyBackfill).toBeUndefined(); // 空名称行已丢弃
    expect(Object.keys(body.prompts).length).toBe(4); // storyTeller/objectDesigner/storyChat/custom（storyBackfill 空名被丢）
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/panels/SettingsModal.test.tsx`（工作目录 `web/`）
Expected: 新 5 用例 FAIL（无提示词库区块），原有 3 用例 PASS。

- [ ] **Step 3: 实现 SettingsModal.tsx**

替换为（完整文件，保留原有三项设置逻辑不变，新增提示词库区块）：

```tsx
import { useEffect, useState } from 'react';
import { client } from '../api/client';
import type { AppSettings } from '../types';
import { ROLE_PROMPT_KEYS } from '../views/roles';

// 全局设置弹窗：ComfyUI 地址 + agent 默认模型 + 思考强度 + 提示词库。
// 持久化到后端 ~/.director/settings.json（用户级，跨项目）；模型/思考强度是「默认值」，
// AgentPanel 内的临时切换不回写这里。
const THINKING_LEVELS = [
  { value: '', label: '思考：默认' },
  { value: 'off', label: '思考：关闭' },
  { value: 'minimal', label: '思考：最低' },
  { value: 'low', label: '思考：低' },
  { value: 'medium', label: '思考：中' },
  { value: 'high', label: '思考：高' },
  { value: 'xhigh', label: '思考：极高' },
  { value: 'max', label: '思考：最大' },
];

export function SettingsModal(props: {
  open: boolean;
  // 初始值（来自 App 已拉取的 settings）；保存成功后回调最新值
  settings: AppSettings;
  models: Array<{ id: string; provider: string; thinking: boolean }>;
  onClose: () => void;
  onSaved: (s: AppSettings) => void;
  onError: (msg: string) => void;
}) {
  const [comfyUrl, setComfyUrl] = useState(props.settings.comfyUrl);
  const [agentModel, setAgentModel] = useState(props.settings.agentModel);
  const [agentThinking, setAgentThinking] = useState(props.settings.agentThinking);
  // 提示词库工作副本（有序条目数组；保存时组装 map）
  const [promptEntries, setPromptEntries] = useState<Array<{ key: string; value: string }>>([]);
  const [saving, setSaving] = useState(false);

  // 打开时同步外部 settings（切换项目/外部变更后重新打开取最新）；
  // prompts 键缺失（undefined）= 从未自定义 → 预填 5 角色默认条目
  useEffect(() => {
    if (props.open) {
      setComfyUrl(props.settings.comfyUrl);
      setAgentModel(props.settings.agentModel);
      setAgentThinking(props.settings.agentThinking);
      setPromptEntries(props.settings.prompts === undefined
        ? Object.entries(ROLE_PROMPT_KEYS).map(([key, value]) => ({ key, value }))
        : Object.entries(props.settings.prompts).map(([key, value]) => ({ key, value })));
    }
  }, [props.open, props.settings]);

  if (!props.open) return null;

  const updateEntry = (i: number, patch: Partial<{ key: string; value: string }>) => {
    setPromptEntries((prev) => prev.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  };
  const removeEntry = (i: number) => {
    setPromptEntries((prev) => prev.filter((_, j) => j !== i));
  };
  const addEntry = () => {
    setPromptEntries((prev) => [...prev, { key: `新提示词 ${prev.length + 1}`, value: '' }]);
  };
  // 重置默认：5 角色条目（含默认内容）合并进工作副本，自定义条目保留
  const resetDefaults = () => {
    setPromptEntries((prev) => {
      const next = [...prev];
      for (const [key, value] of Object.entries(ROLE_PROMPT_KEYS)) {
        const i = next.findIndex((e) => e.key === key);
        if (i >= 0) next[i] = { key, value };
        else next.push({ key, value });
      }
      return next;
    });
  };

  const save = () => {
    setSaving(true);
    // 组装 prompts map：空名称行丢弃（无法按名引用）；空内容保留（消费点回退默认）
    const prompts: Record<string, string> = {};
    for (const e of promptEntries) {
      const key = e.key.trim();
      if (key) prompts[key] = e.value;
    }
    void client.saveSettings({
      comfyUrl: comfyUrl.trim(),
      agentModel,
      agentThinking,
      prompts,
    }).then((s) => {
      props.onSaved(s);
      props.onClose();
    }).catch((err) => {
      props.onError(err instanceof Error ? err.message : '保存设置失败');
    }).finally(() => setSaving(false));
  };

  return (
    <div className="dialog-mask" onClick={props.onClose}>
      <div className="dialog dialog-wide" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">⚙ 设置</div>
        <div className="dialog-body settings-body">
          <label className="role-field">
            <span className="role-field-label">COMFYUI 地址</span>
            <input
              className="ne-input"
              placeholder="http://127.0.0.1:8188"
              value={comfyUrl}
              onChange={(e) => setComfyUrl(e.target.value)}
            />
            <span className="role-field-hint">本机或远程 GPU 地址；保存后立即生效并写入当前项目节点</span>
          </label>
          <label className="role-field">
            <span className="role-field-label">默认模型</span>
            <select
              className="ne-input"
              value={agentModel}
              onChange={(e) => setAgentModel(e.target.value)}
            >
              <option value="">默认模型（pi 配置）</option>
              {props.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.provider}/{m.id.split('/').slice(1).join('/')}{m.thinking ? ' · 思考' : ''}
                </option>
              ))}
            </select>
            <span className="role-field-hint">AGENT 面板与对话式的默认模型（面板内可临时切换）</span>
          </label>
          <label className="role-field">
            <span className="role-field-label">思考强度</span>
            <select
              className="ne-input"
              value={agentThinking}
              onChange={(e) => setAgentThinking(e.target.value)}
            >
              {THINKING_LEVELS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <span className="role-field-hint">pi --thinking：控制模型推理深度（越高思考越充分，响应越慢）</span>
          </label>
          {/* 提示词库：角色系统提示词 CRUD（AI 功能按名称引用，缺省回退内置默认） */}
          <div className="settings-section" data-testid="prompt-lib">
            <div className="settings-section-head">
              <span className="role-field-label">提示词库 · 角色系统提示词</span>
              <button type="button" className="btn-ghost" onClick={resetDefaults}>↺ 重置为默认提示词</button>
            </div>
            <span className="role-field-hint">AI 建议 / 物体优化 / 对话总结回填按名称引用；删除或留空该条目即回退内置默认</span>
            <div className="prompt-lib">
              {promptEntries.map((e, i) => (
                <div key={i} className="prompt-entry">
                  <input
                    className="ne-input prompt-entry-name" data-testid={`prompt-name-${i}`}
                    value={e.key}
                    onChange={(ev) => updateEntry(i, { key: ev.target.value })}
                  />
                  <textarea
                    className="ne-input prompt-entry-text" data-testid={`prompt-text-${i}`}
                    rows={3} value={e.value}
                    onChange={(ev) => updateEntry(i, { value: ev.target.value })}
                  />
                  <button
                    type="button" className="btn-ghost prompt-entry-del" data-testid={`prompt-del-${i}`}
                    onClick={() => removeEntry(i)}
                  >🗑 删除</button>
                </div>
              ))}
            </div>
            <button type="button" className="btn-ghost" data-testid="prompt-add" onClick={addEntry}>＋ 新增提示词</button>
          </div>
        </div>
        <div className="dialog-actions">
          <button className="btn-ghost" onClick={props.onClose}>取消</button>
          <button className="btn-primary" onClick={save} disabled={saving}>保存</button>
        </div>
      </div>
    </div>
  );
}
```

`web/src/App.css` 末尾追加：

```css
/* ===== 设置弹窗：提示词库 ===== */
.settings-section { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--border); padding-top: 14px; }
.settings-section-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.prompt-lib { display: flex; flex-direction: column; gap: 8px; max-height: 320px; overflow: auto; }
.prompt-entry { display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--border); border-radius: 8px; padding: 10px; background: var(--panel-2); }
.prompt-entry-name { font-family: var(--mono); font-size: 12px; }
.prompt-entry-text { font-family: var(--mono); font-size: 12px; line-height: 1.6; resize: vertical; }
.prompt-entry-del { align-self: flex-end; font-size: 12px; }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/panels/SettingsModal.test.tsx`（工作目录 `web/`）
Expected: 全部 PASS（新 5 + 原有 3）。再跑全量：
Run: `pnpm exec vitest run`（`web/`）→ 全部 PASS
Run: `pnpm exec tsc -b`（`web/`）→ exit 0
Run: `pnpm test`（仓库根）→ 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add web/src/panels/SettingsModal.tsx web/src/panels/SettingsModal.test.tsx web/src/App.css
git commit -m "feat(web): 设置弹窗提示词库区块（角色提示词 CRUD + 重置默认）"
```

---

## 验收（对照 spec）

1. ⚙ 设置弹窗出现「提示词库」区块，首次打开预填 5 角色条目 —— Task 4 用例 1。
2. 编辑/新增/删除/重置默认 —— Task 4 用例 3、4。
3. 保存后 AI 建议/物体优化/总结成稿/回填使用配置值；未配置回退默认 —— Task 3 三个消费用例 + Task 2 resolvePrompt 用例。
4. 持久化跨项目、刷新不丢（settings.json）—— Task 1 后端用例。
5. 全部新增单测通过、现有测试不回归 —— Task 4 Step 4 全量回归。
