# 故事板角色扩展（story-teller 与 object-designer）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在导演工作台新增两个画布前置角色页——story-teller（六步问卷向导，AI 辅助润色，产出故事文档进素材库）与 object-designer（人物/场景/物品设计器，ComfyUI 文生图生成参考图进素材库），顶栏三个 tab 通过 hash 路由切换。

**Architecture:** 方案 A——后端新增 `src/story/` 与 `src/design/` 两个领域模块（各自独立存储 `.director/story.json` / `.director/design.json`），REST API 挂在现有 `mountRoutes` 上；AI 辅助复用现有 `/api/agent/chat` SSE 桥（前端传角色提示词，零后端改动）；前端手写轻量 hash 路由（`useHashRoute` hook），顶栏 tab 三视图切换，现有五区布局保持为 canvas 视图。

**Tech Stack:** Fastify + React (Vite) + zustand + vitest（后端 inject 测试 / 前端 testing-library，均已有）。

## Global Constraints

- 存储文件位置：`<projectDir>/.director/story.json`、`<projectDir>/.director/design.json`（与 chat.json 同级，参照 `src/agent/chat-history.ts` 的读写模式：缺失/损坏返回空，原子写 tmp+rename）。
- 素材库为全局（`~/.director/assets`），入库复用 `src/assets/assets-store.ts` 的 `importAssetText` / `importAssetFile`，**不新建**入库逻辑。
- 路由 hash 形式：`#/story-teller`、`#/object-designer`、`#/canvas`（默认无 hash 视为 canvas）。不引入 react-router。
- AI 辅助复用 `/api/agent/chat`，角色提示词为前端常量（`web/src/views/roles.ts`），不改后端 agent 桥。
- 文生图模板：用户自备 `workflows/*.template.json`；模板必须包含 `${prompt}` 变量，其余只支持 `seed/width/height/steps/cfg/negative_prompt`，未知变量报 400。
- 生成采用同步等待（请求挂起直至 ComfyUI 完成，spec 已确认）。
- 代码注释、UI 文案、commit message 使用中文。
- 前端组件测试沿用 `web/src/App.test.tsx` 模式：mock fetch + mock WebSocket（jsdom）。

---

### Task 1: story 存储模块（步骤定义 + story.json 读写）

**Files:**
- Create: `src/story/steps.ts`
- Create: `src/story/store.ts`
- Test: `src/story/store.test.ts`

**Interfaces:**
- Produces（Task 2 消费）:
  - `STORY_STEPS: StoryStep[]`（`{ id, question, hint, required }`，6 步）
  - `StoryProgress = { step: number; answers: Record<string, string>; completedAt: string | null }`
  - `readStory(projectDir: string): StoryProgress`
  - `saveStory(projectDir: string, patch: { step?: number; answers?: Record<string, string> }): StoryProgress`
  - `completeStory(projectDir: string, completedAt: string): StoryProgress`
  - `buildStoryMarkdown(projectName: string, answers: Record<string, string>): string`

- [ ] **Step 1: 写失败测试**

创建 `src/story/store.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STORY_STEPS } from './steps.js';
import { buildStoryMarkdown, completeStory, readStory, saveStory } from './store.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'director-story-'));
  mkdirSync(join(dir, '.director'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('STORY_STEPS', () => {
  it('6 个步骤，id 唯一且必填步正确', () => {
    expect(STORY_STEPS).toHaveLength(6);
    expect(new Set(STORY_STEPS.map((s) => s.id)).size).toBe(6);
    expect(STORY_STEPS.filter((s) => s.required).map((s) => s.id))
      .toEqual(['theme', 'protagonist', 'antagonist', 'scenes', 'ending']);
  });
});

describe('readStory', () => {
  it('文件不存在返回空进度', () => {
    expect(readStory(dir)).toEqual({ step: 0, answers: {}, completedAt: null });
  });

  it('文件损坏返回空进度（不抛错）', () => {
    writeFileSync(join(dir, '.director', 'story.json'), '{broken', 'utf8');
    expect(readStory(dir)).toEqual({ step: 0, answers: {}, completedAt: null });
  });
});

describe('saveStory', () => {
  it('合并写入 answers 并落盘', () => {
    saveStory(dir, { step: 1, answers: { theme: '精灵与哥布林' } });
    saveStory(dir, { answers: { protagonist: '精灵骑士' } });
    const story = readStory(dir);
    expect(story.step).toBe(1);
    expect(story.answers.theme).toBe('精灵与哥布林');
    expect(story.answers.protagonist).toBe('精灵骑士');
    // 原子写：临时文件被 rename，不残留 .tmp
    expect(existsSync(join(dir, '.director', 'story.json.tmp'))).toBe(false);
  });

  it('非法 step（越界/负数）被钳制', () => {
    saveStory(dir, { step: 99 });
    expect(readStory(dir).step).toBe(STORY_STEPS.length - 1);
    saveStory(dir, { step: -3 });
    expect(readStory(dir).step).toBe(0);
  });
});

describe('completeStory', () => {
  it('设置 completedAt', () => {
    completeStory(dir, '2026-08-15T00:00:00.000Z');
    expect(readStory(dir).completedAt).toBe('2026-08-15T00:00:00.000Z');
  });
});

describe('buildStoryMarkdown', () => {
  it('按步骤顺序组装 Markdown 文档', () => {
    const md = buildStoryMarkdown('测试项目', {
      theme: '战争与和解', protagonist: '精灵骑士', scenes: '迷雾森林',
    });
    expect(md).toContain('# 测试项目 · 故事设定');
    expect(md).toContain('## 主题\n\n战争与和解');
    expect(md).toContain('## 主角\n\n精灵骑士');
    expect(md).toContain('## 场景\n\n迷雾森林');
    // 未填写的步骤显示占位
    expect(md).toContain('## 结局\n\n（未填写）');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/story/store.test.ts`
Expected: FAIL — 找不到 `./steps.js` / `./store.js` 模块。

- [ ] **Step 3: 实现 steps.ts**

创建 `src/story/steps.ts`：

```ts
// story-teller 向导步骤定义（预定义 + AI 辅助模式；spec 第 4.1 节）
export interface StoryStep {
  id: string;
  question: string;
  hint: string;
  required: boolean;
}

export const STORY_STEPS: StoryStep[] = [
  { id: 'theme', question: '故事主题是什么？', hint: '一句话主题（如「精灵与哥布林的战争与和解」）', required: true },
  { id: 'protagonist', question: '主角是谁？', hint: '身份、性格、目标', required: true },
  { id: 'support', question: '配角有哪些？', hint: '每个配角一句话（可留空）', required: false },
  { id: 'antagonist', question: '冲突来自哪里？', hint: '对手/障碍/内在矛盾', required: true },
  { id: 'scenes', question: '故事发生在哪些场景？', hint: '每个场景一句（可作为物体设计器的种子）', required: true },
  { id: 'ending', question: '结局如何？', hint: '开放/圆满/反转', required: true },
];
```

- [ ] **Step 4: 实现 store.ts**

创建 `src/story/store.ts`：

```ts
// story-teller 向导进度：按项目持久化到 <projectDir>/.director/story.json
// （与 chat.json 同级；缺失/损坏视为空进度，原子写 tmp+rename 防半写）
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { STORY_STEPS } from './steps.js';

export interface StoryProgress {
  step: number;                        // 当前步骤索引（0..5）
  answers: Record<string, string>;     // 每步答案（按步骤 id）
  completedAt: string | null;          // 完成时间 ISO；null=未完成
}

function storyFile(projectDir: string): string {
  return join(projectDir, '.director', 'story.json');
}

export function readStory(projectDir: string): StoryProgress {
  const f = storyFile(projectDir);
  if (!existsSync(f)) return { step: 0, answers: {}, completedAt: null };
  try {
    const data = JSON.parse(readFileSync(f, 'utf8')) as StoryProgress;
    return {
      step: data.step ?? 0,
      answers: data.answers && typeof data.answers === 'object' ? data.answers : {},
      completedAt: data.completedAt ?? null,
    };
  } catch {
    return { step: 0, answers: {}, completedAt: null };
  }
}

function writeStory(projectDir: string, story: StoryProgress): StoryProgress {
  const f = storyFile(projectDir);
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(story, null, 2), 'utf8');
  renameSync(tmp, f);
  return story;
}

// 合并保存：只更新传入字段，step 钳制到 [0, STORY_STEPS.length-1]
export function saveStory(
  projectDir: string,
  patch: { step?: number; answers?: Record<string, string> },
): StoryProgress {
  const story = readStory(projectDir);
  if (patch.step !== undefined) {
    story.step = Math.min(Math.max(Math.round(patch.step), 0), STORY_STEPS.length - 1);
  }
  if (patch.answers) story.answers = { ...story.answers, ...patch.answers };
  return writeStory(projectDir, story);
}

export function completeStory(projectDir: string, completedAt: string): StoryProgress {
  const story = readStory(projectDir);
  story.completedAt = completedAt;
  return writeStory(projectDir, story);
}

// 全部答案汇总为 Markdown 故事文档（complete 接口入库前组装）
export function buildStoryMarkdown(projectName: string, answers: Record<string, string>): string {
  const lines = [`# ${projectName} · 故事设定`, ''];
  for (const step of STORY_STEPS) {
    const answer = (answers[step.id] ?? '').trim();
    lines.push(`## ${step.question}`, '', answer || '（未填写）', '');
  }
  return lines.join('\n');
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run src/story/store.test.ts`
Expected: PASS（5 个用例全绿）

- [ ] **Step 6: Commit**

```bash
git add src/story/steps.ts src/story/store.ts src/story/store.test.ts
git commit -m "feat(story): story-teller 步骤定义与 story.json 读写存储"
```

---

### Task 2: story API 路由（GET/PUT/complete）

**Files:**
- Modify: `src/api/routes.ts`（在 `/api/agent/history` 路由附近追加 story 路由块）
- Test: `src/api/story-api.test.ts`（新建，复制 api.test.ts 的 buildApp setup 模式）

**Interfaces:**
- Consumes: Task 1 的 `readStory/saveStory/completeStory/buildStoryMarkdown`、`STORY_STEPS`
- Produces: 路由 `GET /api/story`、`PUT /api/story`、`POST /api/story/complete`
  - GET → `{ story: StoryProgress }`
  - PUT body `{ step?, answers? }` → `{ story }`
  - POST complete → 素材入库 `story_<项目名>.md`（`importAssetText`）→ `{ asset: AssetRecord, story }`

- [ ] **Step 1: 写失败测试**

创建 `src/api/story-api.test.ts`：

```ts
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { basename, join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../index.js';
import { listAssets } from '../assets/assets-store.js';
import { readStory } from '../story/store.js';

let dir: string;
let a: Awaited<ReturnType<typeof buildApp>>;
let fakeHome: string;
let realHome: string;
beforeEach(async () => {
  // 隔离 HOME：素材入库落到临时目录，不污染真实 ~/.director/assets
  realHome = homedir();
  fakeHome = mkdtempSync(join(tmpdir(), 'director-home-'));
  vi.stubEnv('HOME', fakeHome);
  dir = mkdtempSync(join(tmpdir(), 'director-story-api-'));
  mkdirSync(join(dir, 'mmh3'), { recursive: true });
  a = buildApp({ projectDir: dir, comfyBaseUrl: 'http://127.0.0.1:59999' });
});
afterEach(async () => {
  vi.stubEnv('HOME', realHome);
  vi.unstubAllEnvs();
  await a.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('API 故事向导', () => {
  it('GET /api/story 返回空进度', async () => {
    const res = await a.inject({ method: 'GET', url: '/api/story' });
    expect(res.statusCode).toBe(200);
    expect(res.json().story).toEqual({ step: 0, answers: {}, completedAt: null });
  });

  it('PUT /api/story 合并保存答案', async () => {
    const r1 = await a.inject({
      method: 'PUT', url: '/api/story',
      payload: { step: 1, answers: { theme: '战争与和解' } },
    });
    expect(r1.json().story.answers.theme).toBe('战争与和解');
    const r2 = await a.inject({
      method: 'PUT', url: '/api/story',
      payload: { answers: { protagonist: '精灵骑士' } },
    });
    expect(r2.json().story.step).toBe(1);
    expect(r2.json().story.answers.protagonist).toBe('精灵骑士');
    // 落盘持久化
    expect(readStory(dir).answers.theme).toBe('战争与和解');
  });

  it('POST /api/story/complete 组装文档入库并标记完成', async () => {
    // 无项目节点时 projectName 默认为目录 basename（graph-store.loadGraph 行为）
    await a.inject({
      method: 'PUT', url: '/api/story',
      payload: { answers: { theme: '精灵与哥布林' } },
    });
    const res = await a.inject({ method: 'POST', url: '/api/story/complete', payload: {} });
    expect(res.statusCode).toBe(201);
    const { asset, story } = res.json();
    expect(asset.name).toBe(`story_${basename(dir)}.md`);
    expect(asset.kind).toBe('txt');
    expect(story.completedAt).toBeTruthy();
    // 素材已入库
    const assets = listAssets();
    expect(assets.some((x) => x.id === asset.id)).toBe(true);
  });

  it('POST /api/story/complete 重复调用不重复入库', async () => {
    await a.inject({ method: 'POST', url: '/api/story/complete', payload: {} });
    const res2 = await a.inject({ method: 'POST', url: '/api/story/complete', payload: {} });
    expect(res2.statusCode).toBe(409);
    expect(res2.json().code).toBe('STORY_ALREADY_COMPLETED');
    expect(listAssets()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/api/story-api.test.ts`
Expected: FAIL — 404（路由未挂载）/ 无项目节点时 complete 行为未定义。

- [ ] **Step 3: 实现路由**

在 `src/api/routes.ts` 的 `/api/agent/history` 路由之后追加：

```ts
// —— 故事向导（计划：story-teller 角色页）——
// 进度存 .director/story.json；complete 时组装 Markdown 入库为 story_<项目名>.md 素材
app.get('/api/story', async () => ({ story: readStory(ctx.projectDir) }));

app.put('/api/story', async (req) => {
  const body = req.body as { step?: number; answers?: Record<string, string> };
  return { story: saveStory(ctx.projectDir, {
    step: typeof body.step === 'number' ? body.step : undefined,
    answers: body.answers && typeof body.answers === 'object' ? body.answers : undefined,
  }) };
});

app.post('/api/story/complete', async (req, reply) => {
  const story = readStory(ctx.projectDir);
  if (story.completedAt) {
    return reply.code(409).send({ code: 'STORY_ALREADY_COMPLETED', message: '故事已完成，如需重新生成请先重置' });
  }
  const projectName = loadGraph(ctx.projectDir).projectName || '未命名项目';
  const md = buildStoryMarkdown(projectName, story.answers);
  const asset = importAssetText(`story_${projectName}.md`, md);
  completeStory(ctx.projectDir, new Date().toISOString());
  reply.code(201);
  return { asset, story: readStory(ctx.projectDir) };
});
```

同时更新 imports（在现有 `import { listAssets, importAssetFile, importAssetText, ... }` 行追加 `importAssetText` 已有；新增 story imports）：

```ts
import { readStory, saveStory, completeStory, buildStoryMarkdown } from '../story/store.js';
```

（`importAssetText` 已在该文件 import 中，无需改动。）

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/api/story-api.test.ts`
Expected: PASS（4 个用例全绿）

- [ ] **Step 5: 回归现有测试**

Run: `pnpm test`
Expected: 全绿（现有用例不受影响）

- [ ] **Step 6: Commit**

```bash
git add src/api/routes.ts src/api/story-api.test.ts
git commit -m "feat(story): story 向导 API（进度读写 + 完成入库）"
```

---

### Task 3: design 存储模块（design.json CRUD）

**Files:**
- Create: `src/design/store.ts`
- Test: `src/design/store.test.ts`

**Interfaces:**
- Produces（Task 4/5 消费）:
  - `type DesignKind = 'character' | 'scene' | 'prop'`
  - `interface DesignObject { id; kind; name; description; style; template; status: 'draft'|'generating'|'done'|'failed'; assetId?; error?; createdAt: number }`
  - `listDesigns(projectDir): DesignObject[]`
  - `createDesign(projectDir, kind, name): DesignObject`（kind 非法抛 DirectorError INVALID_PATCH）
  - `updateDesign(projectDir, id, patch): DesignObject`（白名单字段：name/description/style/template/status/assetId/error；未知 id 抛 NODE_NOT_FOUND）
  - `deleteDesign(projectDir, id): void`（未知 id 抛 NODE_NOT_FOUND）

- [ ] **Step 1: 写失败测试**

创建 `src/design/store.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesign, deleteDesign, listDesigns, updateDesign } from './store.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'director-design-'));
  mkdirSync(join(dir, '.director'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('design store', () => {
  it('createDesign 新建对象并落盘', () => {
    const d = createDesign(dir, 'character', '精灵骑士');
    expect(d.kind).toBe('character');
    expect(d.status).toBe('draft');
    expect(d.name).toBe('精灵骑士');
    expect(listDesigns(dir)).toHaveLength(1);
  });

  it('非法 kind 抛 INVALID_PATCH', () => {
    expect(() => createDesign(dir, 'weapon' as never, 'x')).toThrowError(
      expect.objectContaining({ code: 'INVALID_PATCH' }),
    );
  });

  it('updateDesign 白名单字段更新', () => {
    const d = createDesign(dir, 'scene', '迷雾森林');
    const updated = updateDesign(dir, d.id, {
      description: '雾气弥漫的森林', style: '吉卜力风', template: 'my-t2i',
    });
    expect(updated.description).toBe('雾气弥漫的森林');
    expect(updated.style).toBe('吉卜力风');
    // 白名单外字段被忽略
    const hacked = updateDesign(dir, d.id, { createdAt: 1 } as never);
    expect(hacked.createdAt).toBe(d.createdAt);
  });

  it('updateDesign 未知 id 抛 NODE_NOT_FOUND', () => {
    expect(() => updateDesign(dir, 'nope', { name: 'x' })).toThrowError(
      expect.objectContaining({ code: 'NODE_NOT_FOUND' }),
    );
  });

  it('deleteDesign 删除并落盘', () => {
    const d = createDesign(dir, 'prop', '精灵地图');
    deleteDesign(dir, d.id);
    expect(listDesigns(dir)).toHaveLength(0);
    expect(() => deleteDesign(dir, d.id)).toThrowError(
      expect.objectContaining({ code: 'NODE_NOT_FOUND' }),
    );
  });

  it('design.json 损坏返回空列表（不抛错）', () => {
    writeFileSync(join(dir, '.director', 'design.json'), '{broken', 'utf8');
    expect(listDesigns(dir)).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/design/store.test.ts`
Expected: FAIL — 找不到 `./store.js`。

- [ ] **Step 3: 实现 store.ts**

创建 `src/design/store.ts`：

```ts
// object-designer 对象设计存储：<projectDir>/.director/design.json
// 三类对象（人物/场景/物品），状态机 draft → generating → done/failed
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DirectorError } from '../types.js';

export type DesignKind = 'character' | 'scene' | 'prop';
export type DesignStatus = 'draft' | 'generating' | 'done' | 'failed';

export interface DesignObject {
  id: string;
  kind: DesignKind;
  name: string;
  description: string;   // 视觉描述
  style: string;         // 风格（自由文本）
  template: string;      // 文生图模板名（workflows/*.template.json）
  status: DesignStatus;
  assetId?: string;      // 生成的参考图素材 id
  error?: string;
  createdAt: number;
}

const KINDS: DesignKind[] = ['character', 'scene', 'prop'];
// 客户端可更新字段白名单（id/kind/createdAt 不可改；status 由生成流程写）
const PATCHABLE = ['name', 'description', 'style', 'template', 'status', 'assetId', 'error'] as const;

function designFile(projectDir: string): string {
  return join(projectDir, '.director', 'design.json');
}

export function listDesigns(projectDir: string): DesignObject[] {
  const f = designFile(projectDir);
  if (!existsSync(f)) return [];
  try {
    const data = JSON.parse(readFileSync(f, 'utf8'));
    return Array.isArray(data) ? (data as DesignObject[]) : [];
  } catch {
    return [];
  }
}

function writeDesigns(projectDir: string, designs: DesignObject[]): void {
  const f = designFile(projectDir);
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(designs, null, 2), 'utf8');
  renameSync(tmp, f);
}

function findDesign(designs: DesignObject[], id: string): DesignObject {
  const d = designs.find((x) => x.id === id);
  if (!d) throw new DirectorError('NODE_NOT_FOUND', `设计对象不存在: ${id}`);
  return d;
}

export function createDesign(projectDir: string, kind: DesignKind, name: string): DesignObject {
  if (!KINDS.includes(kind)) {
    throw new DirectorError('INVALID_PATCH', `不支持的对象类型: ${kind}`);
  }
  const d: DesignObject = {
    id: randomUUID(),
    kind,
    name: name || '未命名',
    description: '',
    style: '',
    template: '',
    status: 'draft',
    createdAt: Date.now(),
  };
  const designs = [...listDesigns(projectDir), d];
  writeDesigns(projectDir, designs);
  return d;
}

export function updateDesign(
  projectDir: string,
  id: string,
  patch: Partial<Pick<DesignObject, (typeof PATCHABLE)[number]>>,
): DesignObject {
  const designs = listDesigns(projectDir);
  const target = findDesign(designs, id);
  const updated = { ...target };
  for (const key of PATCHABLE) {
    const v = (patch as Record<string, unknown>)[key];
    // undefined = 不更新（空串是有意义的清除值，如 error: ''）
    if (v !== undefined) (updated as Record<string, unknown>)[key] = v;
  }
  writeDesigns(projectDir, designs.map((x) => (x.id === id ? updated : x)));
  return updated;
}

export function deleteDesign(projectDir: string, id: string): void {
  const designs = listDesigns(projectDir);
  findDesign(designs, id);
  writeDesigns(projectDir, designs.filter((x) => x.id !== id));
}
```

**（最终代码说明）**：上面 imports 即最终版本（fs 函数来自 `node:fs`，`randomUUID` 来自 `node:crypto`）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/design/store.test.ts`
Expected: PASS（6 个用例全绿）

- [ ] **Step 5: Commit**

```bash
git add src/design/store.ts src/design/store.test.ts
git commit -m "feat(design): object-designer 对象存储（design.json CRUD）"
```

---

### Task 4: workflows 模板目录 + design API CRUD + /api/workflows

**Files:**
- Modify: `src/comfy/workflow.ts`（模板目录支持环境变量覆盖，供测试注入临时目录）
- Modify: `src/api/routes.ts`（designs CRUD + workflows 列表路由）
- Test: `src/api/design-api.test.ts`（新建）

**Interfaces:**
- Consumes: Task 3 的 `listDesigns/createDesign/updateDesign/deleteDesign`、`DesignObject`
- Produces:
  - `GET /api/workflows` → `{ workflows: string[] }`（扫描 `workflows/*.template.json`，去后缀）
  - `GET /api/designs` → `{ designs: DesignObject[] }`
  - `POST /api/designs` body `{ kind, name }` → 201 `{ design }`（非法 kind → 400）
  - `PUT /api/designs/:id` body `{ patch }` → `{ design }`（未知 id → 404）
  - `DELETE /api/designs/:id?confirm=true` → `{ ok: true }`（无 confirm → 400；未知 id → 404）
- `buildWorkflow` 模板目录改为函数式求值：`process.env.DIRECTOR_WORKFLOWS_DIR ?? <cwd>/workflows`（测试注入临时目录用，行为不变）

- [ ] **Step 1: 写失败测试**

创建 `src/api/design-api.test.ts`：

```ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../index.js';
import { listDesigns } from '../design/store.js';

let dir: string;
let a: Awaited<ReturnType<typeof buildApp>>;
let fakeHome: string;
let realHome: string;
let wfDir: string;

beforeEach(async () => {
  realHome = homedir();
  fakeHome = mkdtempSync(join(tmpdir(), 'director-home-'));
  vi.stubEnv('HOME', fakeHome);
  // 模板目录指向临时目录：写一个测试用 t2i 模板
  wfDir = mkdtempSync(join(tmpdir(), 'director-wf-'));
  process.env.DIRECTOR_WORKFLOWS_DIR = wfDir;
  writeFileSync(join(wfDir, 'test-t2i.template.json'), JSON.stringify({
    '1': { class_type: 'KSampler', inputs: { text: '${prompt}', seed: '${seed}' } },
  }), 'utf8');
  dir = mkdtempSync(join(tmpdir(), 'director-design-api-'));
  mkdirSync(join(dir, 'mmh3'), { recursive: true });
  a = buildApp({ projectDir: dir, comfyBaseUrl: 'http://127.0.0.1:59999' });
});
afterEach(async () => {
  vi.stubEnv('HOME', realHome);
  vi.unstubAllEnvs();
  delete process.env.DIRECTOR_WORKFLOWS_DIR;
  await a.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(wfDir, { recursive: true, force: true });
});

describe('API workflows', () => {
  it('GET /api/workflows 扫描模板目录去后缀', async () => {
    const res = await a.inject({ method: 'GET', url: '/api/workflows' });
    expect(res.statusCode).toBe(200);
    expect(res.json().workflows).toContain('test-t2i');
  });
});

describe('API designs CRUD', () => {
  it('POST 新建 → GET 列表 → PUT 更新 → DELETE 删除', async () => {
    const created = await a.inject({
      method: 'POST', url: '/api/designs',
      payload: { kind: 'character', name: '精灵骑士' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().design.id;

    const list = await a.inject({ method: 'GET', url: '/api/designs' });
    expect(list.json().designs).toHaveLength(1);

    const upd = await a.inject({
      method: 'PUT', url: `/api/designs/${id}`,
      payload: { patch: { description: '银发绿眸', template: 'test-t2i' } },
    });
    expect(upd.json().design.description).toBe('银发绿眸');

    const del = await a.inject({ method: 'DELETE', url: `/api/designs/${id}?confirm=true` });
    expect(del.json().ok).toBe(true);
    expect(listDesigns(dir)).toHaveLength(0);
  });

  it('非法 kind 返回 400', async () => {
    const res = await a.inject({
      method: 'POST', url: '/api/designs',
      payload: { kind: 'weapon', name: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_PATCH');
  });

  it('DELETE 无 confirm 返回 400', async () => {
    const res = await a.inject({ method: 'DELETE', url: '/api/designs/whatever' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('CONFIRM_REQUIRED');
  });

  it('PUT 未知 id 返回 404', async () => {
    const res = await a.inject({
      method: 'PUT', url: '/api/designs/nope',
      payload: { patch: { name: 'x' } },
    });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/api/design-api.test.ts`
Expected: FAIL — 404（路由未挂载）。

- [ ] **Step 3: 改造 workflow.ts 支持模板目录覆盖**

修改 `src/comfy/workflow.ts` 顶部：

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DirectorError, type DirectorNode } from '../types.js';

// 模板目录：默认 <cwd>/workflows；测试可用 DIRECTOR_WORKFLOWS_DIR 覆盖（避免污染真实目录）
function templateDir(): string {
  return process.env.DIRECTOR_WORKFLOWS_DIR ?? join(process.cwd(), 'workflows');
}
```

并将 `buildWorkflow` 内 `const p = join(TEMPLATE_DIR, ...)` 改为 `const p = join(templateDir(), ...)`，删除 `const TEMPLATE_DIR = join(process.cwd(), 'workflows');`。

- [ ] **Step 4: 实现 design 路由**

在 `src/api/routes.ts` 的 story 路由块之后追加：

```ts
// —— 物体设计器（object-designer 角色页）——
// 对象设计列表存 .director/design.json；生成参考图走 /api/designs/:id/generate（Task 5）
app.get('/api/workflows', async () => {
  const wfDir = process.env.DIRECTOR_WORKFLOWS_DIR ?? join(process.cwd(), 'workflows');
  const names: string[] = [];
  try {
    for (const f of readdirSync(wfDir)) {
      const m = /^(.*)\.template\.json$/.exec(f);
      if (m) names.push(m[1]!);
    }
  } catch {
    // 目录不存在 → 空列表（前端显示「暂无模板」）
  }
  return { workflows: names.sort() };
});

app.get('/api/designs', async () => ({ designs: listDesigns(ctx.projectDir) }));

app.post('/api/designs', async (req, reply) => {
  const body = req.body as { kind?: string; name?: string };
  try {
    const design = createDesign(ctx.projectDir, body.kind as DesignKind, body.name ?? '');
    reply.code(201);
    return { design };
  } catch (err) {
    if (err instanceof DirectorError && err.code === 'INVALID_PATCH') {
      return reply.code(400).send({ code: err.code, message: err.message });
    }
    throw err;
  }
});

app.put('/api/designs/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const patch = (req.body as { patch?: Record<string, unknown> }).patch ?? {};
  try {
    return { design: updateDesign(ctx.projectDir, id, patch as Partial<DesignObject>) };
  } catch (err) {
    if (err instanceof DirectorError && err.code === 'NODE_NOT_FOUND') {
      return reply.code(404).send({ code: err.code, message: err.message });
    }
    throw err;
  }
});

app.delete('/api/designs/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!confirmOf(req.query)) {
    return reply.code(400).send({ code: 'CONFIRM_REQUIRED', message: '删除设计对象需 confirm=true' });
  }
  try {
    deleteDesign(ctx.projectDir, id);
    return { ok: true };
  } catch (err) {
    if (err instanceof DirectorError && err.code === 'NODE_NOT_FOUND') {
      return reply.code(404).send({ code: err.code, message: err.message });
    }
    throw err;
  }
});
```

更新 imports：`import { readdirSync } from 'node:fs';`（现有 `readFileSync` 行合并）以及 design store：

```ts
import { listDesigns, createDesign, updateDesign, deleteDesign } from '../design/store.js';
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run src/api/design-api.test.ts`
Expected: PASS（4 个用例全绿）

- [ ] **Step 6: 回归**

Run: `pnpm test`
Expected: 全绿（workflow.ts 改造向后兼容）

- [ ] **Step 7: Commit**

```bash
git add src/comfy/workflow.ts src/api/routes.ts src/api/design-api.test.ts
git commit -m "feat(design): design 对象 CRUD API 与 workflows 模板列表"
```

---

### Task 5: design 生成端点 + 素材图片文件端点

**Files:**
- Modify: `src/api/routes.ts`（`POST /api/designs/:id/generate` + `GET /api/assets/:id/file`）
- Test: `src/api/design-api.test.ts`（追加两个 describe）

**Interfaces:**
- Consumes: Task 3 store、Task 4 workflows、现有 `ComfyUIClient`（ctx.comfy）、`buildWorkflow`、`importAssetFile`
- Produces:
  - `POST /api/designs/:id/generate` → `{ design }`（同步等待 ComfyUI；成功后 design.status=done + assetId）
  - `GET /api/assets/:id/file` → 图片/文本文件字节流（content-type 按扩展名；未知 id → 404）

**生成规则：**
1. design 不存在 → 404；status=generating（防并发）→ 400。
2. 读模板提取 `${...}` 变量；不含 `${prompt}` → 400 `INVALID_PATCH`「模板必须包含 ${prompt} 变量」；含未知变量（非 seed/width/height/steps/cfg/negative_prompt）→ 400 列出。
3. prompt = `[style, description].filter(Boolean).join(', ')`；为空 → 400「请先填写风格或视觉描述」。
4. ComfyUI 未连接（`ctx.comfy.health()` false）→ 400「请先配置 ComfyUI 地址」。
5. 提交 → waitForDone → 下载 media[0] 到临时文件（保留扩展名，importAssetFile 按扩展名判 kind）→ 入库 → 更新对象 status=done + assetId。
6. 任何失败 → status=failed + error 写回对象，返回 200 + design（前端据此展示失败可重试）。

- [ ] **Step 1: 写失败测试**

追加到 `src/api/design-api.test.ts`（在文件末尾加 describe；需要引入 mock ComfyUI 服务器——参照 `src/generation/queue.test.ts` 模式，用 Fastify 起本地 mock 服务器并把 `comfyBaseUrl` 指向它）：

在文件顶部追加 imports：

```ts
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { readFileSync, existsSync } from 'node:fs';
```

在 `afterEach` 后追加独立的 describe（自建 mock 服务器，避免与 CRUD 用例共享 app）：

```ts
describe('API designs generate', () => {
  let mock: ReturnType<typeof Fastify>;
  let a2: Awaited<ReturnType<typeof buildApp>>;
  let dir2: string;
  let baseUrl: string;
  // mock ComfyUI history 响应体（可变：个别用例覆盖为无输出）
  let historyBody: () => Record<string, unknown>;

  beforeEach(async () => {
    // mock ComfyUI：system_stats / prompt / history / view
    mock = Fastify({ logger: false });
    mock.get('/system_stats', async () => ({}));
    mock.post('/prompt', async () => ({ prompt_id: 'pid-1' }));
    // history 响应由闭包变量决定（Fastify 不允许同路径重复注册，改由用例改写闭包）
    historyBody = () => ({
      'pid-1': {
        outputs: { '9': { images: [{ filename: 'out_1.png', subfolder: '', type: 'output' }] } },
      },
    });
    mock.get('/history/:pid', async (req: FastifyRequest, reply: FastifyReply) => {
      const { pid } = req.params as { pid: string };
      reply.header('content-type', 'application/json');
      return reply.send({ [pid]: historyBody()['pid-1'] });
    });
    mock.get('/view', async (_req: FastifyRequest, reply: FastifyReply) => {
      reply.header('content-type', 'image/png');
      return reply.send(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    });
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const addr = mock.server.address();
    baseUrl = `http://127.0.0.1:${(addr as { port: number }).port}`;

    dir2 = mkdtempSync(join(tmpdir(), 'director-design-gen-'));
    mkdirSync(join(dir2, 'mmh3'), { recursive: true });
    a2 = buildApp({ projectDir: dir2, comfyBaseUrl: baseUrl });
  });
  afterEach(async () => {
    await a2.close();
    await mock.close().catch(() => {}); // 个别用例已关闭 mock，重复 close 容忍
    rmSync(dir2, { recursive: true, force: true });
  });

  it('生成成功：状态 done + 素材入库 + assetId 写回', async () => {
    const created = await a2.inject({
      method: 'POST', url: '/api/designs',
      payload: { kind: 'character', name: '精灵骑士' },
    });
    const id = created.json().design.id;
    await a2.inject({
      method: 'PUT', url: `/api/designs/${id}`,
      payload: { patch: { style: '吉卜力风', description: '银发绿眸的精灵骑士', template: 'test-t2i' } },
    });
    const res = await a2.inject({ method: 'POST', url: `/api/designs/${id}/generate` });
    expect(res.statusCode).toBe(200);
    const design = res.json().design;
    expect(design.status).toBe('done');
    expect(design.assetId).toBeTruthy();
    // 素材已入库且为 img
    const assets = listAssets();
    const asset = assets.find((x) => x.id === design.assetId);
    expect(asset?.kind).toBe('img');
    expect(asset?.name).toMatch(/^design-.*\.png$/);
  });

  it('模板缺 ${prompt} 变量返回 400', async () => {
    // 写一个缺 prompt 的模板
    writeFileSync(join(wfDir, 'no-prompt.template.json'), JSON.stringify({
      '1': { class_type: 'KSampler', inputs: { seed: '${seed}' } },
    }), 'utf8');
    const created = await a2.inject({
      method: 'POST', url: '/api/designs',
      payload: { kind: 'scene', name: '迷雾森林' },
    });
    const id = created.json().design.id;
    await a2.inject({
      method: 'PUT', url: `/api/designs/${id}`,
      payload: { patch: { style: '写实', template: 'no-prompt' } },
    });
    const res = await a2.inject({ method: 'POST', url: `/api/designs/${id}/generate` });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('${prompt}');
  });

  it('描述与风格都为空返回 400', async () => {
    const created = await a2.inject({
      method: 'POST', url: '/api/designs',
      payload: { kind: 'prop', name: '地图' },
    });
    const id = created.json().design.id;
    const res = await a2.inject({ method: 'POST', url: `/api/designs/${id}/generate` });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('请先填写');
  });

  it('ComfyUI 未连接返回 400', async () => {
    await mock.close().catch(() => {}); // 关掉 mock → health 检查失败
    const created = await a2.inject({
      method: 'POST', url: '/api/designs',
      payload: { kind: 'character', name: '哥布林' },
    });
    const id = created.json().design.id;
    await a2.inject({
      method: 'PUT', url: `/api/designs/${id}`,
      payload: { patch: { style: '暗黑', description: '绿皮哥布林', template: 'test-t2i' } },
    });
    const res = await a2.inject({ method: 'POST', url: `/api/designs/${id}/generate` });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('ComfyUI');
    // 状态保持 draft（未进入 generating）
    const list = await a2.inject({ method: 'GET', url: '/api/designs' });
    expect(list.json().designs[0].status).toBe('draft');
  });

  it('生成失败（history 无输出）→ failed + error 写回', async () => {
    // 改写闭包：history 返回空 outputs（不能重复注册路由，Fastify 会抛错）
    historyBody = () => ({ 'pid-1': { outputs: {} } });
    const created = await a2.inject({
      method: 'POST', url: '/api/designs',
      payload: { kind: 'character', name: '精灵' },
    });
    const id = created.json().design.id;
    await a2.inject({
      method: 'PUT', url: `/api/designs/${id}`,
      payload: { patch: { style: '吉卜力风', description: '精灵', template: 'test-t2i' } },
    });
    const res = await a2.inject({ method: 'POST', url: `/api/designs/${id}/generate` });
    expect(res.statusCode).toBe(200);
    expect(res.json().design.status).toBe('failed');
    expect(res.json().design.error).toBeTruthy();
  });
});

describe('API 素材文件端点', () => {
  it('GET /api/assets/:id/file 返回图片字节流', async () => {
    // 先入库一张图（HOME 已隔离到 fakeHome）
    const src = join(fakeHome, 'src.png');
    writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'utf8');
    const rec = importAssetFile(src);
    const res = await a.inject({ method: 'GET', url: `/api/assets/${rec.id}/file` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.rawPayload.length).toBe(4);
  });

  it('GET /api/assets/:id/file 未知 id 返回 404', async () => {
    const res = await a.inject({ method: 'GET', url: '/api/assets/nope/file' });
    expect(res.statusCode).toBe(404);
  });
});
```

文件顶部 import 需要补 `importAssetFile, listAssets`：

```ts
import { importAssetFile, listAssets } from '../assets/assets-store.js';
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/api/design-api.test.ts`
Expected: FAIL — generate 路由 404 / file 端点 404。

- [ ] **Step 3: 实现生成端点**

在 `src/api/routes.ts` 的 design CRUD 之后追加：

```ts
// 生成参考图：同步等待 ComfyUI 完成 → 下载 → 素材库入库 → 状态写回对象。
// 模板规则：必须含 ${prompt}；允许变量 seed/width/height/steps/cfg/negative_prompt；
// 未知变量返回 400 并列出（引导用户调整自备模板）。
app.post('/api/designs/:id/generate', async (req, reply) => {
  const { id } = req.params as { id: string };
  const designs = listDesigns(ctx.projectDir);
  const design = designs.find((d) => d.id === id);
  if (!design) {
    return reply.code(404).send({ code: 'NODE_NOT_FOUND', message: `设计对象不存在: ${id}` });
  }
  if (design.status === 'generating') {
    return reply.code(400).send({ code: 'INVALID_PATCH', message: '该对象正在生成中' });
  }
  // 提示词 = 风格 + 描述（先于模板校验：描述缺失是最根本的请求方错误）
  const prompt = [design.style, design.description].filter((s) => s.trim()).join(', ').trim();
  if (!prompt) {
    return reply.code(400).send({ code: 'INVALID_PATCH', message: '请先填写风格或视觉描述' });
  }
  // 模板变量校验（模板不存在 / 缺 ${prompt} / 未知变量 → 400，不写状态）
  const wfDir = process.env.DIRECTOR_WORKFLOWS_DIR ?? join(process.cwd(), 'workflows');
  const templatePath = join(wfDir, `${design.template}.template.json`);
  let templateText: string;
  try {
    templateText = readFileSync(templatePath, 'utf8');
  } catch {
    return reply.code(400).send({ code: 'INVALID_PATCH', message: `模板不存在: ${design.template}` });
  }
  const vars = [...templateText.matchAll(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)].map((m) => m[1]!);
  const SUPPORTED = new Set(['prompt', 'seed', 'width', 'height', 'steps', 'cfg', 'negative_prompt']);
  const unknown = [...new Set(vars)].filter((v) => !SUPPORTED.has(v));
  if (!vars.includes('prompt')) {
    return reply.code(400).send({ code: 'INVALID_PATCH', message: '模板必须包含 ${prompt} 变量（文生图提示词入口）' });
  }
  if (unknown.length > 0) {
    return reply.code(400).send({ code: 'INVALID_PATCH', message: `模板包含不支持的变量: ${unknown.join(', ')}（支持: ${[...SUPPORTED].join(', ')}）` });
  }
  // ComfyUI 连接检查：未连接直接 400，不排队空转
  if (!(await ctx.comfy.health())) {
    return reply.code(400).send({ code: 'INVALID_PATCH', message: '请先配置 ComfyUI 地址（点击顶栏 COMFYUI 徽章）' });
  }
  // 标记生成中 → 提交 → 等待 → 下载 → 入库
  updateDesign(ctx.projectDir, id, { status: 'generating' });
  try {
    const workflow = buildWorkflow(design.template, {
      prompt,
      seed: Math.floor(Math.random() * 2 ** 31),
      width: 1024, height: 1024, steps: 30, cfg: 7, negative_prompt: '',
    });
    const promptId = await ctx.comfy.submit(workflow, randomUUID());
    const out = await ctx.comfy.waitForDone(promptId);
    if (out.media.length === 0) {
      throw new DirectorError('INVALID_PATCH', '生成完成但无输出媒体');
    }
    // 下载到临时文件（保留原始扩展名：importAssetFile 按扩展名判 kind）
    const tmpDir = mkdtempSync(join(tmpdir(), 'director-design-'));
    const ext = extname(out.media[0]!.filename) || '.png';
    const tmpPath = join(tmpDir, `design-${id}${ext}`);
    try {
      await ctx.comfy.download(out.media[0]!, tmpPath);
      const asset = importAssetFile(tmpPath);
      // error 用空串而非 undefined：updateDesign 对 undefined 视为“不更新”，空串才能清除旧错误
      const designDone = updateDesign(ctx.projectDir, id, {
        status: 'done', assetId: asset.id, error: '',
      });
      return { design: designDone };
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const designFailed = updateDesign(ctx.projectDir, id, { status: 'failed', error: message });
    return { design: designFailed };
  }
});

// 素材文件字节流（图片参考图预览 / 文本内容）：content-type 按扩展名
app.get('/api/assets/:id/file', async (req, reply) => {
  const { id } = req.params as { id: string };
  let rec: AssetRecord;
  try {
    rec = listAssets().find((x) => x.id === id) ?? (() => { throw new DirectorError('NODE_NOT_FOUND', `素材不存在: ${id}`); })();
  } catch (err) {
    if (err instanceof DirectorError) return reply.code(404).send({ code: err.code, message: err.message });
    throw err;
  }
  const type = rec.ext === '.png' ? 'image/png'
    : rec.ext === '.jpg' || rec.ext === '.jpeg' ? 'image/jpeg'
    : rec.ext === '.webp' ? 'image/webp'
    : rec.ext === '.gif' ? 'image/gif'
    : rec.ext === '.mp4' ? 'video/mp4'
    : rec.ext === '.webm' ? 'video/webm'
    : 'text/plain; charset=utf-8';
  reply.header('content-type', type);
  return reply.send(readFileSync(assetFilePath(id)));
});
```

**注意**：`/api/assets/:id/file` 直接读 `~/.director/assets` 路径与 assets-store 的 `assetDir()` 重复——保持一致，改为复用 store：在 `src/assets/assets-store.ts` 导出 `assetFilePath(id): string`：

（上面路由代码已使用 `assetFilePath(id)`；同时确认 listAssets 返回的 AssetRecord 含 `ext` 字段——是的，见 `src/types.ts` AssetRecord。）

```ts
// 素材绝对路径（图片预览/下载用）；未知 id 抛 NODE_NOT_FOUND
export function assetFilePath(id: string): string {
  const rec = findAsset(id);
  return join(assetDir(), `${rec.id}${rec.ext}`);
}
```

路由改用：

```ts
app.get('/api/assets/:id/file', async (req, reply) => {
  const { id } = req.params as { id: string };
  let rec: AssetRecord;
  try {
    rec = listAssets().find((x) => x.id === id) ?? (() => { throw new DirectorError('NODE_NOT_FOUND', `素材不存在: ${id}`); })();
  } catch (err) {
    if (err instanceof DirectorError) return reply.code(404).send({ code: err.code, message: err.message });
    throw err;
  }
  const type = rec.ext === '.png' ? 'image/png'
    : rec.ext === '.jpg' || rec.ext === '.jpeg' ? 'image/jpeg'
    : rec.ext === '.webp' ? 'image/webp'
    : rec.ext === '.gif' ? 'image/gif'
    : rec.ext === '.mp4' ? 'video/mp4'
    : rec.ext === '.webm' ? 'video/webm'
    : 'text/plain; charset=utf-8';
  reply.header('content-type', type);
  return reply.send(readFileSync(assetFilePath(id)));
});
```

routes.ts imports 需补：`extname`（`node:path`）、`buildWorkflow`（`../comfy/workflow.js`）、`assetFilePath`（`../assets/assets-store.js`）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/api/design-api.test.ts`
Expected: PASS（CRUD 4 + generate 5 + file 2 = 11 个用例全绿）

- [ ] **Step 5: 回归**

Run: `pnpm test`
Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add src/api/routes.ts src/api/design-api.test.ts src/assets/assets-store.ts
git commit -m "feat(design): 参考图生成端点（ComfyUI→素材库）与素材文件预览端点"
```

---

### Task 6: 前端 hash 路由 + 顶栏 tab 三视图切换

**Files:**
- Create: `web/src/router.ts`
- Modify: `web/src/App.tsx`（顶栏加 tab；路由条件渲染三视图；canvas 保持现有布局）
- Modify: `web/src/App.test.tsx`（mock 新 API + tab 切换断言）
- Modify: `web/src/App.css`（role-tabs 样式）

**Interfaces:**
- Produces（Task 7/8 消费）:
  - `useHashRoute(): 'story-teller' | 'object-designer' | 'canvas'`（监听 hashchange；无 hash 默认 canvas）
  - `App` 顶栏渲染 `<nav className="role-tabs">`，含三个 `<a href="#/...">` tab，data-testid 分别为 `tab-story-teller` / `tab-object-designer` / `tab-canvas`
  - canvas 视图的 main/footer 包在 `route === 'canvas'` 条件内（保持现有 data-testid 不变）

- [ ] **Step 1: 写失败测试**

修改 `web/src/App.test.tsx`：在全局 fetch mock 中补新 API 分支，并新增 describe：

在 mock fetch 的 `if (String(url).includes('/api/assets'))` 分支后追加：

```ts
if (String(url).includes('/api/story')) {
  return new Response(JSON.stringify({ story: { step: 0, answers: {}, completedAt: null } }), { status: 200 });
}
if (String(url).includes('/api/designs')) {
  return new Response(JSON.stringify({ designs: [] }), { status: 200 });
}
if (String(url).includes('/api/workflows')) {
  return new Response(JSON.stringify({ workflows: ['test-t2i'] }), { status: 200 });
}
```

（注意顺序：`/api/assets` 分支用 includes 会吞掉 `/api/assets/...` 其他 URL——保持现有顺序在 `assets` 分支之后再判断 story/designs/workflows 无冲突。**但** `/api/story` 的 includes 必须放在 `/api/projects`、`/api/project/switch` 之前？现有顺序是先 snapshots → comfy/health → project/switch → projects → agent/models → assets。story/designs/workflows 与这些不重叠，放 assets 后即可。）

新增 describe（文件末尾）：

```ts
describe('角色路由 tab', () => {
  it('顶栏渲染三个角色 tab，默认高亮画布', async () => {
    render(<App />);
    expect(screen.getByTestId('tab-story-teller')).toBeInTheDocument();
    expect(screen.getByTestId('tab-object-designer')).toBeInTheDocument();
    expect(screen.getByTestId('tab-canvas')).toBeInTheDocument();
    expect(screen.getByTestId('tab-canvas').className).toContain('active');
    // 默认路由渲染画布
    expect(screen.getByTestId('canvas')).toBeInTheDocument();
  });

  it('点击故事向导 tab 切换到向导视图（URL hash 同步）', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('tab-story-teller'));
    await waitFor(() => expect(screen.getByTestId('story-teller-view')).toBeInTheDocument());
    expect(screen.getByTestId('tab-story-teller').className).toContain('active');
    // 画布隐藏
    expect(screen.queryByTestId('canvas')).not.toBeInTheDocument();
    // hash 已更新
    expect(window.location.hash).toBe('#/story-teller');
  });

  it('hash 初始化直接进入对应视图', async () => {
    window.location.hash = '#/object-designer';
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('object-designer-view')).toBeInTheDocument());
    window.location.hash = '';
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run web/src/App.test.tsx`
Expected: FAIL — tab 不存在（新 UI 未实现）。

- [ ] **Step 3: 实现 router.ts**

创建 `web/src/router.ts`：

```ts
import { useEffect, useState } from 'react';

// 角色路由：hash 形式 #/story-teller、#/object-designer、#/canvas（默认）
export type RoleRoute = 'story-teller' | 'object-designer' | 'canvas';

export function parseRoleRoute(hash: string): RoleRoute {
  if (hash === '#/story-teller') return 'story-teller';
  if (hash === '#/object-designer') return 'object-designer';
  return 'canvas';
}

export function useHashRoute(): RoleRoute {
  const [route, setRoute] = useState<RoleRoute>(() => parseRoleRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoleRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
```

- [ ] **Step 4: 实现 App.tsx 改造**

1. 顶部 import 追加：

```ts
import { useHashRoute } from './router';
```

2. 组件内（`export default function App()` 首行）加：

```ts
const route = useHashRoute();
```

3. 顶栏 `<div className="logo">...</div>` 之后插入 role-tabs：

```tsx
<nav className="role-tabs" data-testid="role-tabs">
  <a href="#/story-teller" className={`role-tab${route === 'story-teller' ? ' active' : ''}`} data-testid="tab-story-teller">故事向导</a>
  <a href="#/object-designer" className={`role-tab${route === 'object-designer' ? ' active' : ''}`} data-testid="tab-object-designer">物体设计</a>
  <a href="#/canvas" className={`role-tab${route === 'canvas' ? ' active' : ''}`} data-testid="tab-canvas">画布</a>
</nav>
```

4. 现有 `<main className="main">…</main>` + 底部 splitter + `<footer>` 三块包进条件渲染：

```tsx
{route === 'canvas' ? (
  <>
    <main className="main" data-testid="main-canvas">
      {/* 现有 left / splitter / section.canvas / splitter / right 全部原样保留 */}
    </main>
    <div className={`splitter splitter-h ...`}>...</div>
    <footer className="footer" style={{ height: footerH }}>...</footer>
  </>
) : route === 'story-teller' ? (
  <StoryTellerView projectName={graph?.projectName ?? ''} />
) : (
  <ObjectDesignerView projectName={graph?.projectName ?? ''} />
)}
```

5. 占位视图（Task 7/8 替换为真实实现——本任务先建最小占位，保证 App.test 的 `story-teller-view` / `object-designer-view` testid 通过）：

创建 `web/src/views/StoryTellerView.tsx`：

```tsx
// story-teller 向导视图（Task 7 实现完整向导；本文件由 Task 6 创建占位）
export function StoryTellerView(props: { projectName: string }) {
  return <div className="role-view" data-testid="story-teller-view">故事向导（开发中…）</div>;
}
```

创建 `web/src/views/ObjectDesignerView.tsx`：

```tsx
// object-designer 设计器视图（Task 8 实现完整设计器；本文件由 Task 6 创建占位）
export function ObjectDesignerView(props: { projectName: string }) {
  return <div className="role-view" data-testid="object-designer-view">物体设计器（开发中…）</div>;
}
```

6. App.tsx import 两个视图组件。

- [ ] **Step 5: 实现 App.css 样式**

在 `web/src/App.css` 顶栏区段追加：

```css
/* 角色路由 tab（故事向导 / 物体设计 / 画布） */
.role-tabs { display: flex; align-items: center; gap: 2px; margin-left: 4px; }
.role-tab {
  padding: 5px 12px; font-size: 12px; color: var(--text-dim);
  border: 1px solid transparent; border-radius: 5px; text-decoration: none;
  letter-spacing: .05em; transition: all .15s;
}
.role-tab:hover { color: var(--text); background: var(--bg); }
.role-tab.active { color: var(--amber); border-color: var(--border-2); background: var(--bg); font-weight: 600; }
.role-view { flex: 1; min-height: 0; overflow: auto; background: var(--bg); }
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm vitest run web/src/App.test.tsx`
Expected: PASS（原有用例 + 新增 3 个 tab 用例全绿）

- [ ] **Step 7: Commit**

```bash
git add web/src/router.ts web/src/App.tsx web/src/App.test.tsx web/src/App.css web/src/views/StoryTellerView.tsx web/src/views/ObjectDesignerView.tsx
git commit -m "feat(web): 顶栏角色路由（hash 三视图切换）"
```

---

### Task 7: 前端 StoryTeller 向导视图

**Files:**
- Create: `web/src/views/roles.ts`（角色提示词常量）
- Modify: `web/src/views/StoryTellerView.tsx`（占位 → 完整实现）
- Modify: `web/src/api/client.ts`（story 方法）
- Modify: `web/src/types.ts`（StoryProgress 镜像类型）
- Modify: `web/src/App.css`（向导样式）
- Test: `web/src/views/StoryTeller.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 6 的 `useHashRoute`（不需要）、Task 1 的 `STORY_STEPS`（前端镜像常量）、现有 `agentChat`
- Produces: `StoryTellerView` 组件（data-testid `story-teller-view`），内部步骤条 + 问题 + textarea + AI 建议按钮 + 上一步/下一步 + 完成
- client 新增:
  - `getStory(): Promise<StoryProgress>`
  - `saveStory(patch: { step?: number; answers?: Record<string, string> }): Promise<StoryProgress>`
  - `completeStory(): Promise<{ asset: AssetRecord; story: StoryProgress }>`

- [ ] **Step 1: 写失败测试**

创建 `web/src/views/StoryTeller.test.tsx`：

```tsx
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StoryTellerView } from './StoryTellerView';

const STORY_API = { story: { step: 0, answers: {}, completedAt: null } };

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/api/story/complete')) {
      return new Response(JSON.stringify({
        asset: { id: 'a1', kind: 'txt', name: 'story_demo.md', ext: '.md', size: 1, importedAt: 1 },
        story: { ...STORY_API.story, completedAt: '2026-08-15T00:00:00.000Z' },
      }), { status: 201 });
    }
    if (u.includes('/api/story')) {
      // PUT 合并更新共享 mock 数据（step / answers），返回更新后进度——模拟真实后端合并写
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as { step?: number; answers?: Record<string, string> };
        STORY_API.story = {
          ...STORY_API.story,
          ...(body.step !== undefined ? { step: body.step } : {}),
          answers: { ...STORY_API.story.answers, ...(body.answers ?? {}) },
        };
      }
      return new Response(JSON.stringify(STORY_API), { status: 200 });
    }
    if (u.includes('/api/agent/chat')) {
      // 流式 agent：直接返回一个 SSE 帧 + DONE
      return new Response(
        'data: {"chunk":"建议文本"}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe('StoryTellerView', () => {
  beforeEach(() => {
    // 重置共享 mock 数据（用例之间隔离）
    STORY_API.story = { step: 0, answers: {}, completedAt: null };
  });

  it('渲染第一步问题与进度', async () => {
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText(/故事主题是什么/)).toBeInTheDocument());
    expect(screen.getByText(/第 1\/6 步/)).toBeInTheDocument();
  });

  it('下一步校验必填：空输入阻止前进', async () => {
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText(/故事主题是什么/)).toBeInTheDocument());
    fireEvent.click(screen.getByText('下一步 →'));
    // 仍在第一步
    expect(screen.getByText(/故事主题是什么/)).toBeInTheDocument();
    expect(screen.getByText('请填写后再继续')).toBeInTheDocument();
  });

  it('填写后下一步进入第二步（自动保存调用 PUT）', async () => {
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText(/故事主题是什么/)).toBeInTheDocument());
    const textarea = screen.getByTestId('story-answer');
    fireEvent.change(textarea, { target: { value: '精灵与哥布林' } });
    fireEvent.click(screen.getByText('下一步 →'));
    await waitFor(() => expect(screen.getByText(/主角是谁/)).toBeInTheDocument());
    // PUT 已调用（保存主题答案）
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/story'),
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('AI 建议按钮流式追加建议到文本框', async () => {
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText(/故事主题是什么/)).toBeInTheDocument());
    fireEvent.click(screen.getByText('✨ AI 建议'));
    await waitFor(() => expect(screen.getByTestId('story-answer')).toHaveValue('建议文本'));
  });

  it('完成后显示完成状态', async () => {
    STORY_API.story = { step: 5, answers: { theme: 't', protagonist: 'p', antagonist: 'a', scenes: 's', ending: 'e' }, completedAt: null };
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText(/结局如何/)).toBeInTheDocument());
    const textarea = screen.getByTestId('story-answer');
    fireEvent.change(textarea, { target: { value: '圆满结局' } });
    fireEvent.click(screen.getByText('完成故事'));
    await waitFor(() => expect(screen.getByText(/已完成 · 已生成故事文档/)).toBeInTheDocument());
  });
});
```

（注意最后一个用例改全局 mock 数据，beforeEach 里重置——在 beforeEach 顶部 `STORY_API.story = { step: 0, ... }` 恢复默认。）

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run web/src/views/StoryTeller.test.tsx`
Expected: FAIL — 组件是占位。

- [ ] **Step 3: 前端镜像类型 + client 方法**

`web/src/types.ts` 追加：

```ts
// story-teller 向导进度（镜像后端 src/story/store.ts）
export interface StoryProgress {
  step: number;
  answers: Record<string, string>;
  completedAt: string | null;
}
```

`web/src/api/client.ts` 追加：

```ts
// —— story-teller 向导 ——
async getStory(): Promise<StoryProgress> {
  const r = await req<{ story: StoryProgress }>('/api/story');
  return r.story;
},

async saveStory(patch: { step?: number; answers?: Record<string, string> }): Promise<StoryProgress> {
  const r = await req<{ story: StoryProgress }>('/api/story', {
    method: 'PUT', body: JSON.stringify(patch),
  });
  return r.story;
},

async completeStory(): Promise<{ asset: AssetRecord; story: StoryProgress }> {
  return await req<{ asset: AssetRecord; story: StoryProgress }>('/api/story/complete', {
    method: 'POST', body: JSON.stringify({}),
  });
},
```

client.ts 顶部 import 补 `StoryProgress`、`AssetRecord`（client 现在没定义 AssetRecord 类型——`web/src/types.ts` 补）：

```ts
// 素材记录（镜像后端 src/types.ts AssetRecord）
export interface AssetRecord {
  id: string;
  kind: 'txt' | 'img' | 'vid';
  name: string;
  ext: string;
  size: number;
  importedAt: number;
}
```

- [ ] **Step 4: 角色提示词常量**

创建 `web/src/views/roles.ts`：

```ts
// 角色提示词：发送给 /api/agent/chat 的 message 前缀（复用现有 SSE 桥，零后端改动）
export const STORY_TELLER_SYSTEM = `你是导演工作台的「故事向导」角色。你的任务是帮助用户完善正在创作的视频故事细节。
请基于用户当前步骤的问题与已有答案，给出具体、可落地的补充建议或润色。
要求：
1. 直接输出建议内容本身，不要复述用户已有文字，不要寒暄；
2. 建议要具体（给出可写的细节），不要空泛；
3. 控制在 150 字以内；
4. 用中文回答。`;

export const OBJECT_DESIGNER_SYSTEM = `你是导演工作台的「物体设计师」角色。你的任务是帮用户把故事中的场景/人物/物品描述优化成可用的文生图提示词。
输入：对象名称、风格、现有描述。
要求：
1. 输出优化后的完整视觉描述（可直接作为文生图 prompt），包含主体、外貌/材质、光影、构图要点；
2. 融入用户指定的风格；
3. 只输出描述本身，不要解释、不要引号；
4. 控制在 120 字以内；
5. 用中文回答。`;
```

- [ ] **Step 5: 实现 StoryTellerView**

重写 `web/src/views/StoryTellerView.tsx`：

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { client } from '../api/client';
import type { StoryProgress } from '../types';
import { agentChat } from '../api/agent';
import { STORY_TELLER_SYSTEM } from './roles';

// story-teller 向导步骤（镜像后端 src/story/steps.ts，前端渲染与校验用）
export const STORY_STEPS = [
  { id: 'theme', question: '故事主题是什么？', hint: '一句话主题（如「精灵与哥布林的战争与和解」）', required: true },
  { id: 'protagonist', question: '主角是谁？', hint: '身份、性格、目标', required: true },
  { id: 'support', question: '配角有哪些？', hint: '每个配角一句话（可留空）', required: false },
  { id: 'antagonist', question: '冲突来自哪里？', hint: '对手/障碍/内在矛盾', required: true },
  { id: 'scenes', question: '故事发生在哪些场景？', hint: '每个场景一句（可作为物体设计器的种子）', required: true },
  { id: 'ending', question: '结局如何？', hint: '开放/圆满/反转', required: true },
] as const;

// 防抖保存：输入停止 500ms 后 PUT
export function StoryTellerView(props: { projectName: string }) {
  const [story, setStory] = useState<StoryProgress>({ step: 0, answers: {}, completedAt: null });
  const [draft, setDraft] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const step = STORY_STEPS[Math.min(story.step, STORY_STEPS.length - 1)]!;
  const isLast = story.step === STORY_STEPS.length - 1;

  // 项目切换/挂载时加载进度
  useEffect(() => {
    let disposed = false;
    setLoaded(false);
    setError('');
    void client.getStory().then((s) => {
      if (disposed) return;
      setStory(s);
      setDraft(s.answers[STORY_STEPS[Math.min(s.step, STORY_STEPS.length - 1)]!.id] ?? '');
      setLoaded(true);
    }).catch(() => {
      if (!disposed) { setError('加载故事进度失败'); setLoaded(true); }
    });
    return () => { disposed = true; };
  }, [props.projectName]);

  // 防抖自动保存草稿
  const persist = useCallback((nextStory: StoryProgress, nextDraft: string) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void client.saveStory({ answers: { [step.id]: nextDraft } }).then((s) => {
        setStory(s); setSaved(true);
        setTimeout(() => setSaved(false), 1200);
      }).catch(() => setError('保存失败，请重试'));
    }, 500);
  }, [step.id]);

  // 立即保存当前草稿（清防抖 timer）：切步/完成前调用，避免草稿停留在 timer 里丢失
  const flushDraft = (nextDraft: string) => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    void client.saveStory({ answers: { [step.id]: nextDraft } }).then((s) => {
      setStory(s); setSaved(true);
      setTimeout(() => setSaved(false), 1200);
    }).catch(() => setError('保存失败，请重试'));
  };

  // 切换到某一步（保存 step 并加载该步草稿）
  const goto = (idx: number) => {
    const target = STORY_STEPS[Math.min(Math.max(idx, 0), STORY_STEPS.length - 1)]!;
    void client.saveStory({ step: idx }).then((s) => {
      setStory(s);
      setDraft(s.answers[target.id] ?? '');
      setError('');
    }).catch(() => setError('保存失败，请重试'));
  };

  const next = () => {
    if (step.required && !draft.trim()) {
      setError('请填写后再继续');
      return;
    }
    setError('');
    flushDraft(draft); // 立即保存当前草稿（不等防抖）
    goto(story.step + 1);
  };

  const aiSuggest = () => {
    setAiBusy(true);
    const answersText = Object.entries(story.answers)
      .map(([id, v]) => `${STORY_STEPS.find((s) => s.id === id)?.question ?? id}：${v}`)
      .join('\n');
    const prompt = `${STORY_TELLER_SYSTEM}\n\n当前步骤问题：${step.question}\n已填写内容：\n${answersText || '（暂无）'}`;
    void agentChat(prompt, [], (chunk) => {
      setDraft((d) => d + chunk);
    }).catch(() => setError('AI 建议失败，请重试')).finally(() => setAiBusy(false));
  };

  const complete = async () => {
    if (step.required && !draft.trim()) { setError('请填写后再继续'); return; }
    setError('');
    // 先保存最后一步草稿（直接 await，确保入库时答案完整）
    await client.saveStory({ answers: { [step.id]: draft } }).catch(() => {});
    try {
      // 用 complete 返回值更新（含 completedAt），不额外 GET
      const r = await client.completeStory();
      setStory(r.story);
      setSaved(true);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '完成失败，请重试');
    }
  };

  if (!loaded) return <div className="role-view" data-testid="story-teller-view"><div className="story-center">加载中…</div></div>;

  return (
    <div className="role-view story-view" data-testid="story-teller-view">
      <div className="story-head">
        <div className="story-title">故事向导 · 第 {story.step + 1}/{STORY_STEPS.length} 步</div>
        <div className="story-progress">
          {STORY_STEPS.map((s, i) => (
            <span key={s.id} className={`seg${i <= story.step ? ' done' : ''}${i === story.step ? ' cur' : ''}`} />
          ))}
        </div>
      </div>
      {story.completedAt && (
        <div className="story-banner">✅ 已完成 · 已生成故事文档进素材库（{new Date(story.completedAt).toLocaleString()}）</div>
      )}
      <div className="story-card">
        <div className="story-q">❓ {step.question}</div>
        <div className="story-hint">{step.hint}</div>
        <textarea
          className="ne-input story-answer" data-testid="story-answer"
          value={draft}
          placeholder="在这里填写…"
          onChange={(e) => { setDraft(e.target.value); persist(story, e.target.value); }}
          rows={6}
        />
        <div className="story-actions">
          <button className="btn-ghost" disabled={aiBusy} onClick={aiSuggest}>✨ AI 建议</button>
          <span className="story-save-hint">{saved ? '已保存 ✓' : ''}</span>
        </div>
        <div className="story-nav">
          <button className="btn-ghost" disabled={story.step === 0} onClick={() => goto(story.step - 1)}>← 上一步</button>
          {isLast ? (
            <button className="btn-primary" onClick={() => void complete()}>完成故事</button>
          ) : (
            <button className="btn-primary" onClick={next}>下一步 →</button>
          )}
        </div>
        {error && <div className="story-error">{error}</div>}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: 样式**

`web/src/App.css` 追加：

```css
/* ===== story-teller 向导 ===== */
.story-view { display: flex; flex-direction: column; padding: 24px 32px; gap: 16px; }
.story-center { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-faint); }
.story-head { display: flex; align-items: center; gap: 16px; }
.story-title { font-size: 14px; font-weight: 600; }
.story-progress { display: flex; gap: 4px; flex: 1; max-width: 420px; }
.story-progress .seg { height: 5px; flex: 1; border-radius: 3px; background: var(--border); transition: background .2s; }
.story-progress .seg.done { background: var(--ok); }
.story-progress .seg.cur { background: var(--amber); }
.story-banner { padding: 10px 14px; border: 1px solid var(--ok); border-radius: 6px; background: rgba(46, 160, 67, .08); color: var(--ok); font-size: 13px; }
.story-card { max-width: 720px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 24px; display: flex; flex-direction: column; gap: 14px; }
.story-q { font-size: 16px; font-weight: 600; }
.story-hint { font-size: 12px; color: var(--text-faint); }
.story-answer { width: 100%; resize: vertical; }
.story-actions { display: flex; align-items: center; gap: 12px; }
.story-save-hint { font-size: 11px; color: var(--ok); }
.story-nav { display: flex; justify-content: space-between; margin-top: 6px; }
.story-error { color: var(--rec); font-size: 12px; }
```

- [ ] **Step 7: 运行测试确认通过**

Run: `pnpm vitest run web/src/views/StoryTeller.test.tsx web/src/App.test.tsx`
Expected: 全部 PASS

- [ ] **Step 8: Commit**

```bash
git add web/src/views/roles.ts web/src/views/StoryTellerView.tsx web/src/views/StoryTeller.test.tsx web/src/api/client.ts web/src/types.ts web/src/App.css
git commit -m "feat(story): story-teller 向导视图（步骤/自动保存/AI 建议/完成入库）"
```

---

### Task 8: 前端 ObjectDesigner 设计器视图

**Files:**
- Modify: `web/src/views/ObjectDesignerView.tsx`（占位 → 完整实现）
- Modify: `web/src/api/client.ts`（designs/workflows 方法）
- Modify: `web/src/types.ts`（DesignObject / DesignKind 镜像）
- Modify: `web/src/App.css`（设计器样式）
- Test: `web/src/views/ObjectDesigner.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 3 的 DesignObject 模型（前端镜像）、Task 4 的 workflows API、Task 5 的 generate API 与素材 file 端点、现有 `agentChat`
- Produces: `ObjectDesignerView` 组件（data-testid `object-designer-view`）
- client 新增:
  - `listDesigns(): Promise<DesignObject[]>`
  - `createDesign(input: { kind: DesignKind; name: string }): Promise<DesignObject>`
  - `updateDesign(id: string, patch: Partial<...>): Promise<DesignObject>`
  - `deleteDesign(id: string): Promise<void>`
  - `generateDesign(id: string): Promise<DesignObject>`
  - `listWorkflows(): Promise<string[]>`

- [ ] **Step 1: 写失败测试**

创建 `web/src/views/ObjectDesigner.test.tsx`：

```tsx
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ObjectDesignerView } from './ObjectDesignerView';

let designs: unknown[] = [];

beforeEach(() => {
  designs = [];
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (u.includes('/api/workflows')) {
      return new Response(JSON.stringify({ workflows: ['test-t2i', 'anime-img'] }), { status: 200 });
    }
    // 注意：generate 是 POST /api/designs/:id/generate，必须先于 create（POST /api/designs）匹配
    if (u.includes('/api/designs') && method === 'POST' && u.includes('/generate')) {
      const id = u.split('/')[u.split('/').length - 2];
      designs = designs.map((d: Record<string, unknown>) => d.id === id ? { ...d, status: 'done', assetId: 'a1' } : d);
      return new Response(JSON.stringify({ design: designs.find((d: Record<string, unknown>) => d.id === id) }), { status: 200 });
    }
    if (u.includes('/api/designs') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { kind: string; name: string };
      const d = { id: 'd1', kind: body.kind, name: body.name, description: '', style: '', template: 'test-t2i', status: 'draft', createdAt: 1 };
      designs = [...designs, d];
      return new Response(JSON.stringify({ design: d }), { status: 201 });
    }
    if (u.includes('/api/designs') && method === 'PUT') {
      const id = u.split('/').pop();
      const patch = (JSON.parse(String(init?.body)) as { patch: Record<string, unknown> }).patch;
      designs = designs.map((d: Record<string, unknown>) => d.id === id ? { ...d, ...patch } : d);
      return new Response(JSON.stringify({ design: designs.find((d: Record<string, unknown>) => d.id === id) }), { status: 200 });
    }
    if (u.includes('/api/designs')) {
      return new Response(JSON.stringify({ designs }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe('ObjectDesignerView', () => {
  it('三类分组 + 空态', async () => {
    render(<ObjectDesignerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText('人物')).toBeInTheDocument());
    expect(screen.getByText('场景')).toBeInTheDocument();
    expect(screen.getByText('物品')).toBeInTheDocument();
    expect(screen.getByText(/暂无设计/)).toBeInTheDocument();
  });

  it('新建对象出现在列表并可选中编辑', async () => {
    render(<ObjectDesignerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText('人物')).toBeInTheDocument());
    fireEvent.click(screen.getByText('＋ 新建'));
    // 新建弹层
    const input = screen.getByPlaceholderText('对象名称');
    fireEvent.change(input, { target: { value: '精灵骑士' } });
    fireEvent.click(screen.getByText('创建'));
    await waitFor(() => expect(screen.getByText('精灵骑士')).toBeInTheDocument());
  });

  it('选中对象后表单显示并可编辑描述', async () => {
    designs = [{ id: 'd1', kind: 'character', name: '精灵骑士', description: '', style: '', template: 'test-t2i', status: 'draft', createdAt: 1 }];
    render(<ObjectDesignerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText('精灵骑士')).toBeInTheDocument());
    fireEvent.click(screen.getByText('精灵骑士'));
    await waitFor(() => expect(screen.getByTestId('design-name')).toHaveValue('精灵骑士'));
    fireEvent.change(screen.getByTestId('design-desc'), { target: { value: '银发绿眸' } });
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/designs/d1'),
      expect.objectContaining({ method: 'PUT' }),
    ));
  });

  it('生成参考图：状态流转 done 后显示缩略图', async () => {
    designs = [{ id: 'd1', kind: 'scene', name: '迷雾森林', description: '雾气弥漫', style: '吉卜力风', template: 'test-t2i', status: 'draft', createdAt: 1 }];
    render(<ObjectDesignerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText('迷雾森林')).toBeInTheDocument());
    fireEvent.click(screen.getByText('迷雾森林'));
    await waitFor(() => expect(screen.getByText('⚙ 生成参考图')).toBeInTheDocument());
    fireEvent.click(screen.getByText('⚙ 生成参考图'));
    await waitFor(() => expect(screen.getByAltText('参考图')).toBeInTheDocument());
    expect((screen.getByAltText('参考图') as HTMLImageElement).src).toContain('/api/assets/a1/file');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run web/src/views/ObjectDesigner.test.tsx`
Expected: FAIL — 组件是占位。

- [ ] **Step 3: 前端镜像类型 + client 方法**

`web/src/types.ts` 追加：

```ts
// object-designer 设计对象（镜像后端 src/design/store.ts）
export type DesignKind = 'character' | 'scene' | 'prop';
export type DesignStatus = 'draft' | 'generating' | 'done' | 'failed';

export interface DesignObject {
  id: string;
  kind: DesignKind;
  name: string;
  description: string;
  style: string;
  template: string;
  status: DesignStatus;
  assetId?: string;
  error?: string;
  createdAt: number;
}
```

`web/src/api/client.ts` 追加：

```ts
// —— object-designer 设计器 ——
async listDesigns(): Promise<DesignObject[]> {
  const r = await req<{ designs: DesignObject[] }>('/api/designs');
  return r.designs;
},

async createDesign(input: { kind: DesignKind; name: string }): Promise<DesignObject> {
  const r = await req<{ design: DesignObject }>('/api/designs', {
    method: 'POST', body: JSON.stringify(input),
  });
  return r.design;
},

async updateDesign(id: string, patch: Partial<Pick<DesignObject, 'name' | 'description' | 'style' | 'template'>>): Promise<DesignObject> {
  const r = await req<{ design: DesignObject }>(`/api/designs/${id}`, {
    method: 'PUT', body: JSON.stringify({ patch }),
  });
  return r.design;
},

async deleteDesign(id: string): Promise<void> {
  await req(`/api/designs/${id}?confirm=true`, { method: 'DELETE' });
},

async generateDesign(id: string): Promise<DesignObject> {
  const r = await req<{ design: DesignObject }>(`/api/designs/${id}/generate`, {
    method: 'POST', body: JSON.stringify({}),
  });
  return r.design;
},

async listWorkflows(): Promise<string[]> {
  const r = await req<{ workflows: string[] }>('/api/workflows');
  return r.workflows;
},
```

import 补 `DesignKind, DesignObject, StoryProgress, AssetRecord`。

- [ ] **Step 4: 实现 ObjectDesignerView**

重写 `web/src/views/ObjectDesignerView.tsx`：

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { client } from '../api/client';
import type { DesignKind, DesignObject } from '../types';
import { agentChat } from '../api/agent';
import { OBJECT_DESIGNER_SYSTEM } from './roles';

const KIND_LABEL: Record<DesignKind, string> = {
  character: '人物', scene: '场景', prop: '物品',
};
const KIND_ICON: Record<DesignKind, string> = { character: '👤', scene: '🏞', prop: '🎒' };
const STYLE_PRESETS = ['吉卜力风', '写实', '赛博朋克', '水墨', '皮克斯 3D', '暗黑奇幻'];

export function ObjectDesignerView(props: { projectName: string }) {
  const [designs, setDesigns] = useState<DesignObject[]>([]);
  const [activeKind, setActiveKind] = useState<DesignKind>('character');
  const [selected, setSelected] = useState<DesignObject | null>(null);
  const [workflows, setWorkflows] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    void client.listDesigns().then((list) => {
      setDesigns(list);
      setSelected((sel) => {
        if (!sel) return null;
        return list.find((d) => d.id === sel.id) ?? null;
      });
      setLoaded(true);
    }).catch(() => { setLoaded(true); setError('加载设计列表失败'); });
  }, []);

  useEffect(() => {
    refresh();
    void client.listWorkflows().then(setWorkflows).catch(() => setWorkflows([]));
  }, [props.projectName, refresh]);

  const create = () => {
    if (!newName.trim()) return;
    void client.createDesign({ kind: activeKind, name: newName.trim() }).then((d) => {
      setDesigns((prev) => [...prev, d]);
      setSelected(d);
      setNewName('');
      setCreating(false);
    }).catch((err) => setError(err instanceof Error ? err.message : '创建失败'));
  };

  // 防抖保存表单字段
  const persist = (patch: Partial<Pick<DesignObject, 'name' | 'description' | 'style' | 'template'>>) => {
    if (!selected) return;
    const id = selected.id;
    setSelected((s) => (s ? { ...s, ...patch } : s));
    setDesigns((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void client.updateDesign(id, patch).catch(() => setError('保存失败，请重试'));
    }, 500);
  };

  const remove = () => {
    if (!selected) return;
    if (!window.confirm(`删除设计对象「${selected.name}」？`)) return;
    const id = selected.id;
    void client.deleteDesign(id).then(() => {
      setDesigns((prev) => prev.filter((d) => d.id !== id));
      setSelected(null);
    }).catch((err) => setError(err instanceof Error ? err.message : '删除失败'));
  };

  const aiOptimize = () => {
    if (!selected) return;
    setAiBusy(true);
    const prompt = `${OBJECT_DESIGNER_SYSTEM}\n\n对象名称：${selected.name}\n风格：${selected.style || '（未指定）'}\n现有描述：${selected.description || '（暂无）'}`;
    void agentChat(prompt, [], (chunk) => {
      // 流式追加到描述框
      setSelected((s) => (s ? { ...s, description: s.description + chunk } : s));
      setDesigns((prev) => prev.map((d) => (d.id === selected.id ? { ...d, description: d.description + chunk } : d)));
    }).catch(() => setError('AI 优化失败，请重试')).finally(() => setAiBusy(false));
  };

  const generate = () => {
    if (!selected) return;
    setError('');
    setSelected((s) => (s ? { ...s, status: 'generating' } : s));
    void client.generateDesign(selected.id).then((d) => {
      setDesigns((prev) => prev.map((x) => (x.id === d.id ? d : x)));
      setSelected(d);
    }).catch((err) => {
      setSelected((s) => (s ? { ...s, status: 'failed', error: err instanceof Error ? err.message : '生成失败' } : s));
      setError(err instanceof Error ? err.message : '生成失败');
    });
  };

  if (!loaded) return <div className="role-view" data-testid="object-designer-view"><div className="story-center">加载中…</div></div>;

  const kinds: DesignKind[] = ['character', 'scene', 'prop'];

  return (
    <div className="role-view designer-view" data-testid="object-designer-view">
      <div className="designer-head">
        <div className="story-title">物体设计器 · {designs.length} 个设计 · {designs.filter((d) => d.status === 'done').length} 张参考图</div>
      </div>
      <div className="designer-body">
        <div className="designer-list">
          {kinds.map((k) => {
            const items = designs.filter((d) => d.kind === k);
            return (
              <div key={k} className="designer-group">
                <div className={`designer-kind${activeKind === k ? ' active' : ''}`} onClick={() => setActiveKind(k)}>
                  {KIND_ICON[k]} {KIND_LABEL[k]} ({items.length})
                </div>
                <div className="designer-items">
                  {items.map((d) => (
                    <div
                      key={d.id}
                      className={`designer-item${selected?.id === d.id ? ' active' : ''}`}
                      onClick={() => setSelected(d)}
                    >
                      <span>{d.status === 'done' ? '✅' : d.status === 'failed' ? '❌' : d.status === 'generating' ? '⏳' : '·'} {d.name}</span>
                      {d.assetId && <span className="designer-thumb-mini" style={{ backgroundImage: `url(/api/assets/${d.assetId}/file)` }} />}
                    </div>
                  ))}
                  {items.length === 0 && <div className="designer-empty">暂无设计</div>}
                </div>
              </div>
            );
          })}
          <button className="btn-ghost designer-add" onClick={() => setCreating(true)}>＋ 新建</button>
        </div>
        <div className="designer-form">
          {selected ? (
            <>
              <div className="designer-form-head">
                <span>{KIND_ICON[selected.kind]} {KIND_LABEL[selected.kind]}</span>
                <span className={`designer-status st-${selected.status}`}>
                  {selected.status === 'draft' ? '草稿' : selected.status === 'generating' ? '生成中…' : selected.status === 'done' ? '已生成' : '失败'}
                </span>
              </div>
              <label className="designer-label">名称
                <input className="ne-input" data-testid="design-name" value={selected.name}
                  onChange={(e) => persist({ name: e.target.value })} />
              </label>
              <label className="designer-label">风格
                <input className="ne-input" list="style-presets" value={selected.style}
                  placeholder="自由输入或选择常用风格"
                  onChange={(e) => persist({ style: e.target.value })} />
                <datalist id="style-presets">
                  {STYLE_PRESETS.map((s) => <option key={s} value={s} />)}
                </datalist>
              </label>
              <label className="designer-label">视觉描述
                <textarea className="ne-input" data-testid="design-desc" rows={5} value={selected.description}
                  placeholder="描述外观、材质、光影…"
                  onChange={(e) => persist({ description: e.target.value })} />
              </label>
              <label className="designer-label">文生图模板
                <select className="ne-input" value={selected.template}
                  onChange={(e) => persist({ template: e.target.value })}>
                  <option value="">（选择模板…）</option>
                  {workflows.map((w) => <option key={w} value={w}>{w}</option>)}
                </select>
                {workflows.length === 0 && <div className="designer-tip">workflows/ 目录暂无模板，请放入 *.template.json（需含 $&#123;prompt&#125; 变量）</div>}
              </label>
              <div className="designer-actions">
                <button className="btn-ghost" disabled={aiBusy} onClick={aiOptimize}>✨ AI 优化描述</button>
                <button className="btn-primary" disabled={selected.status === 'generating' || !selected.template} onClick={generate}>⚙ 生成参考图</button>
              </div>
              {selected.status === 'failed' && selected.error && (
                <div className="story-error">生成失败：{selected.error}</div>
              )}
              {selected.status === 'done' && selected.assetId && (
                <div className="designer-preview">
                  <img src={`/api/assets/${selected.assetId}/file`} alt="参考图" data-testid="design-preview-img" />
                </div>
              )}
              <button className="btn-ghost designer-del" onClick={remove}>删除对象</button>
            </>
          ) : (
            <div className="designer-empty">← 选择或新建一个对象开始设计</div>
          )}
        </div>
      </div>
      {error && <div className="story-error designer-error">{error}</div>}
      {creating && (
        <div className="dialog-mask" onClick={() => setCreating(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-title">新建{KIND_LABEL[activeKind]}</div>
            <div className="dialog-body">
              <input className="ne-input" placeholder="对象名称" value={newName}
                autoFocus onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
            </div>
            <div className="dialog-actions">
              <button className="btn-ghost" onClick={() => setCreating(false)}>取消</button>
              <button className="btn-primary" onClick={create} disabled={!newName.trim()}>创建</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: 样式**

`web/src/App.css` 追加：

```css
/* ===== object-designer 设计器 ===== */
.designer-view { display: flex; flex-direction: column; padding: 24px 32px; gap: 16px; }
.designer-head { font-size: 14px; font-weight: 600; }
.designer-body { display: flex; gap: 24px; flex: 1; min-height: 0; }
.designer-list { flex: 0 0 260px; display: flex; flex-direction: column; gap: 14px; overflow: auto; }
.designer-group { display: flex; flex-direction: column; gap: 6px; }
.designer-kind { font-size: 13px; font-weight: 600; color: var(--text-dim); cursor: pointer; padding: 2px 4px; border-radius: 4px; }
.designer-kind.active { color: var(--amber); }
.designer-items { display: flex; flex-direction: column; gap: 4px; padding-left: 6px; }
.designer-item {
  display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 6px;
  border: 1px solid var(--border); font-size: 12px; cursor: pointer; transition: all .15s;
}
.designer-item:hover { border-color: var(--border-2); }
.designer-item.active { border-color: var(--amber); background: rgba(232, 163, 61, .06); }
.designer-thumb-mini { width: 22px; height: 22px; border-radius: 4px; background-size: cover; background-position: center; border: 1px solid var(--border-2); }
.designer-empty { color: var(--text-faint); font-size: 12px; padding: 8px; }
.designer-add { align-self: flex-start; }
.designer-form { flex: 1; max-width: 560px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 20px 24px; display: flex; flex-direction: column; gap: 12px; overflow: auto; }
.designer-form-head { display: flex; justify-content: space-between; align-items: center; font-size: 13px; font-weight: 600; }
.designer-status { font-size: 11px; padding: 2px 8px; border-radius: 10px; border: 1px solid var(--border-2); color: var(--text-dim); }
.designer-status.st-done { color: var(--ok); border-color: var(--ok); }
.designer-status.st-failed { color: var(--rec); border-color: var(--rec); }
.designer-status.st-generating { color: var(--amber); border-color: var(--amber); }
.designer-label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-dim); }
.designer-label .ne-input { width: 100%; }
.designer-actions { display: flex; gap: 10px; }
.designer-tip { font-size: 11px; color: var(--text-faint); }
.designer-preview { border: 1px solid var(--border-2); border-radius: 8px; overflow: hidden; }
.designer-preview img { width: 100%; display: block; }
.designer-del { align-self: flex-start; }
.designer-error { padding: 0 32px; }
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm vitest run web/src/views/ObjectDesigner.test.tsx web/src/App.test.tsx`
Expected: 全部 PASS

- [ ] **Step 7: 全量回归**

Run: `pnpm test`
Expected: 全绿（后端 + 前端）

- [ ] **Step 8: 手动冒烟（可选，需 ComfyUI）**

```bash
# 1. 准备一个自备文生图模板（示例，含 ${prompt}）
cat > workflows/my-t2i.template.json <<'EOF'
{
  "1": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "sd_xl_base_1.0.safetensors" } },
  "2": { "class_type": "CLIPTextEncode", "inputs": { "text": "${prompt}", "clip": ["1", 1] } },
  "3": { "class_type": "EmptyLatentImage", "inputs": { "width": "${width}", "height": "${height}", "batch_size": 1 } },
  "4": { "class_type": "KSampler", "inputs": { "seed": "${seed}", "steps": "${steps}", "cfg": "${cfg}", "sampler_name": "euler", "scheduler": "normal", "denoise": 1, "model": ["1", 0], "positive": ["2", 0], "negative": ["2", 0], "latent_image": ["3", 0] } },
  "5": { "class_type": "VAEDecode", "inputs": { "samples": ["4", 0], "vae": ["1", 2] } },
  "6": { "class_type": "SaveImage", "inputs": { "filename_prefix": "design_ref", "images": ["5", 0] } }
}
EOF
pnpm dev
# 2. 浏览器打开 http://127.0.0.1:5173/#/object-designer
#    新建「人物→精灵骑士」，风格填吉卜力风，描述填细节，模板选 my-t2i → ⚙ 生成参考图
# 3. 完成后素材库应出现设计参考图；左侧面板素材库可见
```

- [ ] **Step 9: Commit**

```bash
git add web/src/views/ObjectDesignerView.tsx web/src/views/ObjectDesigner.test.tsx web/src/api/client.ts web/src/types.ts web/src/App.css
git commit -m "feat(design): object-designer 设计器视图（对象 CRUD/AI 优化/参考图生成）"
```

---

## 自审清单（计划完成后对照 spec）

1. **Spec 覆盖**：
   - 架构（方案 A + hash 路由 + agent 桥复用）→ Task 2/4/5/6 ✓
   - story-teller 六步向导 + 自动保存 + AI 建议 + 完成入库 → Task 1/2/7 ✓
   - object-designer 三类对象 + 表单 + AI 优化 + ComfyUI 生成 + 入库 → Task 3/4/5/8 ✓
   - 素材库预览（参考图缩略图）→ Task 5 `/api/assets/:id/file` + Task 8 `<img>` ✓
   - 错误处理矩阵（损坏兜底/ComfyUI 断开/模板缺失/生成失败/切换项目重新拉取）→ 各任务测试覆盖 ✓
   - 测试策略与验收标准 → 每任务 TDD + 最终全量回归 ✓

2. **占位符扫描**：所有步骤含完整代码与命令，无 TBD。

3. **类型一致性**：`DesignObject` / `DesignKind` / `DesignStatus`、`StoryProgress`、`StoryStep` 前后端同名同构；client 方法签名与路由行为一一对应；`saveStory` 的 step 钳制、`buildWorkflow` 第三参数与 `DIRECTOR_WORKFLOWS_DIR` 环境变量在 Task 4 中一致。

## 验收标准（spec 第 8 节）

1. `pnpm test` 全部通过（现有 + 新增约 30 个用例）。
2. `pnpm dev` 启动后：顶栏三 tab 切换正常、URL hash 同步、刷新保持路由。
3. story-teller 填完 6 步 → 素材库出现 `story_<项目名>.md`。
4. object-designer 自备模板（示例模板见 Task 8 Step 8）→ 生成 → 素材库出现参考图。
