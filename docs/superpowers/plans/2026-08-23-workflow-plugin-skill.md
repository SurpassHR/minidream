# 工作流插件 Skill 机制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为每个工作流插件自动生成 `.pi/skills/<plugin-id>/SKILL.md`，新增 MCP 工具 `workflow.skill` 按需提供插件的可控制参数与使用规则，并在导演 Agent 启动参数中补 `--no-context-files` 关闭 AGENTS.md 上下文注入。

**Architecture:** 新模块 `server/src/workflow-skill.ts` 从统一 WorkflowSpec（`buildSpecsCached()`，覆盖内置+导入）纯函数生成 markdown 并落盘；MCP server 增加 `workflow.skill` 工具（运行时内省、即时生成，不依赖落盘文件）；插件路由在导入/保存/删除时同步 skill 文件并新增预览 API；bridge 补 `--no-context-files`。

**Tech Stack:** TypeScript / Node ESM / Express / Vitest / React（前端预览）

**Spec:** `docs/superpowers/specs/2026-08-23-workflow-plugin-skill-design.md`

## Global Constraints

- 过滤口径与 `workflow.list` 一致：只纳入 `!hidden && llm !== false` 的输入/参数/输出。
- skill 文件落盘位置：`.pi/skills/<plugin-id>/SKILL.md`（`server/src/workflow-skill.ts` 中 `PLUGIN_SKILLS_DIR = path.resolve(__dirname, '../../.pi/skills')`）。
- 写入采用 tmp + rename 原子写；插件 ID 合法性与 `workflow-plugin-store.ts` 一致（`/^[a-z0-9][a-z0-9_-]{0,63}$/`）。
- 文件头部必须带自动生成标记：`> 本文件由 server/src/workflow-skill.ts 自动生成，勿手工编辑。`
- 导演 Agent 知识来源收敛为：director-copilot skill + `--append-system-prompt` + MCP 工具；`--no-context-files` 只加在 `runAgentStream`（标题生成的 `appendSkillIsolationArgs(args, false)` 调用不加）。
- 验证命令：`cd server && pnpm exec tsc --noEmit`、`cd server && pnpm exec vitest run`、`cd web && pnpm exec tsc --noEmit && pnpm run build`。
- 每个任务独立 commit，消息用中文遵循仓库 Conventional Commits 风格。

---

### Task 1: Skill 生成器与文件读写（`server/src/workflow-skill.ts` + 测试）

**Files:**
- Create: `server/src/workflow-skill.ts`
- Test: `server/src/workflow-skill.test.ts`

**Interfaces:**
- Produces:
  - `PLUGIN_SKILLS_DIR: string`
  - `generatePluginSkill(spec: WorkflowSpec): string` — 纯函数，从 spec 生成 markdown，无 IO
  - `pluginSkillPath(id: string, root?: string): string` — 校验 id 后返回文件路径
  - `writePluginSkill(spec: WorkflowSpec, root?: string): string` — 生成+原子写，返回内容；失败抛错
  - `deletePluginSkill(id: string, root?: string): void` — 删除文件（不存在则静默）
  - `readPluginSkill(id: string, root?: string): string | null`
  - `ensurePluginSkills(specs: WorkflowSpec[], root?: string): void` — 仅对缺失文件幂等补齐

- [ ] **Step 1: 写失败测试**

创建 `server/src/workflow-skill.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkflowSpec } from './workflow.js';
import { PLUGIN_SKILLS_DIR, deletePluginSkill, ensurePluginSkills, generatePluginSkill, pluginSkillPath, readPluginSkill, writePluginSkill } from './workflow-skill.js';

const baseSpec = (over: Partial<WorkflowSpec> = {}): WorkflowSpec => ({
  id: 'test_plugin',
  name: '测试插件',
  description: '用于测试的插件',
  inputs: [
    { id: 'text-1', kind: 'text', label: '提示词', nodeId: '1', field: 'text', classType: 'CLIPTextEncode', primary: true },
    { id: 'image-2', kind: 'image', label: '参考图', nodeId: '2', field: 'image', classType: 'LoadImage', required: true },
    { id: 'hidden-text', kind: 'text', label: '内部文本', nodeId: '9', field: 'text', classType: 'CLIPTextEncode', hidden: true },
  ],
  params: [
    { id: 'steps-3', label: '采样步数', nodeId: '3', field: 'steps', type: 'INT', default: 20, min: 1, max: 150, step: 1, description: '越大细节越多' },
    { id: 'sampler-4', label: '采样器', nodeId: '4', field: 'sampler_name', type: 'combo', default: 'euler', options: ['euler', 'dpmpp_2m'], description: '采样器选择' },
    { id: 'lora-5', label: 'LoRA（多选）', nodeId: '5', field: 'lora', type: 'combo', default: [], multiple: true, strengthable: true, min: -2, max: 2, step: 0.1, applyTo: ['6', '7'] },
    { id: 'internal-cfg', label: '内部 CFG', nodeId: '4', field: 'cfg', type: 'FLOAT', default: 7, llm: false },
    { id: 'hidden-param', label: '隐藏参数', nodeId: '3', field: 'seed', type: 'SEED', default: 42, hidden: true },
  ],
  outputs: [
    { id: 'images-8', kind: 'image', label: '最终图片', nodeId: '8', classType: 'SaveImage' },
    { id: 'hidden-out', kind: 'text', label: '内部输出', nodeId: '9', classType: 'PreviewAny', hidden: true },
  ],
  ...over,
});

describe('generatePluginSkill', () => {
  it('包含 frontmatter 与自动生成标记', () => {
    const md = generatePluginSkill(baseSpec());
    expect(md).toMatch(/^---\nname: test_plugin/);
    expect(md).toContain('自动生成');
  });

  it('只暴露未隐藏且 llm !== false 的输入/参数/输出', () => {
    const md = generatePluginSkill(baseSpec());
    expect(md).toContain('steps-3');
    expect(md).toContain('sampler-4');
    expect(md).toContain('lora-5');
    expect(md).not.toContain('internal-cfg');
    expect(md).not.toContain('hidden-param');
    expect(md).not.toContain('hidden-text');
    expect(md).not.toContain('hidden-out');
    expect(md).not.toContain('内部文本');
  });

  it('参数标注类型/默认值/范围/选项/applyTo 联动', () => {
    const md = generatePluginSkill(baseSpec());
    expect(md).toMatch(/steps-3.*整数/);
    expect(md).toMatch(/默认 20/);
    expect(md).toMatch(/1 ~ 150，步长 1/);
    expect(md).toMatch(/euler、dpmpp_2m/);
    expect(md).toMatch(/多选（每项可调强度）/);
    expect(md).toMatch(/同时作用于节点 6、7/);
    expect(md).toMatch(/越大细节越多/);
  });

  it('文本输入标注 primary，必传参考图生成使用规则', () => {
    const md = generatePluginSkill(baseSpec());
    expect(md).toMatch(/提示词/);
    expect(md).toMatch(/primary/);
    expect(md).toMatch(/必须按顺序传入 1 张参考图/);
  });

  it('无文本输入时推导"不接受提示词"规则', () => {
    const md = generatePluginSkill(baseSpec({ inputs: baseSpec().inputs.filter(i => i.kind !== 'text') }));
    expect(md).toMatch(/不接受提示词/);
  });

  it('combo 选项超过 8 个时截断展示', () => {
    const md = generatePluginSkill(baseSpec({
      params: [{ id: 'combo-1', label: '模型', nodeId: '1', field: 'model', type: 'combo', default: 'a', options: Array.from({ length: 12 }, (_, i) => `model${i}.safetensors`) }],
    }));
    expect(md).toMatch(/model0\.safetensors/);
    expect(md).toMatch(/…/);
    expect(md).not.toContain('model11.safetensors');
  });
});

describe('skill 文件读写', () => {
  it('writePluginSkill 原子写入并返回内容；readPluginSkill 读回', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-test-'));
    try {
      const spec = baseSpec();
      const content = writePluginSkill(spec, root);
      expect(readPluginSkill(spec.id, root)).toBe(content);
      expect(fs.existsSync(path.join(root, spec.id, 'SKILL.md'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('deletePluginSkill 删除文件，缺失时静默', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-test-'));
    try {
      writePluginSkill(baseSpec(), root);
      deletePluginSkill('test_plugin', root);
      expect(fs.existsSync(path.join(root, 'test_plugin', 'SKILL.md'))).toBe(false);
      expect(() => deletePluginSkill('test_plugin', root)).not.toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('ensurePluginSkills 只补齐缺失文件，不覆盖已有内容', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-test-'));
    try {
      const a = baseSpec();
      const b = baseSpec({ id: 'plugin_b' });
      writePluginSkill(a, root);
      const edited = '手工内容';
      fs.writeFileSync(pluginSkillPath(a.id, root), edited, 'utf8');
      ensurePluginSkills([a, b], root);
      expect(fs.readFileSync(pluginSkillPath(a.id, root), 'utf8')).toBe(edited);
      expect(fs.existsSync(pluginSkillPath(b.id, root))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('非法插件 ID 拒绝写入', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-test-'));
    try {
      expect(() => writePluginSkill(baseSpec({ id: '../evil' }), root)).toThrow(/非法工作流插件 ID/);
      expect(() => pluginSkillPath('a b', root)).toThrow(/非法工作流插件 ID/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

it('PLUGIN_SKILLS_DIR 指向仓库 .pi/skills', () => {
  expect(PLUGIN_SKILLS_DIR).toMatch(/\.pi\/skills$/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && pnpm exec vitest run src/workflow-skill.test.ts`
Expected: FAIL（`Cannot find module './workflow-skill.js'`）。

- [ ] **Step 3: 实现 `server/src/workflow-skill.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkflowSpec } from './workflow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_SKILLS_DIR = path.resolve(__dirname, '../../.pi/skills');

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function assertPluginId(id: string): void {
  if (!ID_RE.test(id)) throw new Error(`非法工作流插件 ID: ${id}`);
}

const KIND_LABEL: Record<string, string> = { image: '图像', video: '视频', text: '文本' };
const TYPE_LABEL: Record<string, string> = {
  INT: '整数', FLOAT: '浮点数', BOOLEAN: '布尔', SEED: '随机种子', STRING: '文本', combo: '下拉选项',
};

function formatDefault(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return '空列表';
    return `[${value.map(v => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v))).join(', ')}]`;
  }
  if (value === undefined || value === null || value === '') return '未设置';
  return String(value);
}

function paramLines(params: WorkflowSpec['params']): string {
  const visible = params.filter(p => !p.hidden && p.llm !== false);
  if (visible.length === 0) return '无（该工作流的 widget 由模板固定，不可由 LLM 调整）';
  return visible.map(p => {
    const bits: string[] = [`id \`${p.id}\``, `类型 ${TYPE_LABEL[p.type] ?? p.type}`];
    if (p.multiple) bits.push(p.strengthable ? '多选（每项可调强度）' : '多选');
    if (p.default !== undefined && p.default !== null && p.default !== '') bits.push(`默认 ${formatDefault(p.default)}`);
    if (p.min !== undefined) bits.push(`范围 ${p.min} ~ ${p.max ?? '∞'}${p.step ? `，步长 ${p.step}` : ''}`);
    if (p.type === 'combo' && p.options?.length) {
      const shown = p.options.slice(0, 8).join('、');
      bits.push(`可选：${shown}${p.options.length > 8 ? '…' : ''}`);
    }
    if (p.applyTo?.length) bits.push(`同时作用于节点 ${p.applyTo.join('、')}`);
    return `- **${p.label || p.field}**（${bits.join('；')}）${p.description ? `\n  - ${p.description}` : ''}`;
  }).join('\n');
}

function deriveRules(spec: WorkflowSpec): string[] {
  const rules: string[] = [];
  const textInputs = spec.inputs.filter(i => i.kind === 'text' && !i.hidden);
  const imageInputs = spec.inputs.filter(i => i.kind === 'image' && !i.hidden);
  const videoInputs = spec.inputs.filter(i => i.kind === 'video' && !i.hidden);
  if (textInputs.length === 0) {
    rules.push('本工作流不接受提示词，仅用于图像放大/增强等处理任务；必须通过 `images` 传入参考素材。');
  }
  const requiredImages = imageInputs.filter(i => i.required || !String(i.defaultValue ?? '').trim());
  if (requiredImages.length > 0) {
    rules.push(`必须按顺序传入 ${requiredImages.length} 张参考图（\`generation.submit\` 的 \`images\` 参数）。`);
  }
  const requiredVideos = videoInputs.filter(i => i.required || !String(i.defaultValue ?? '').trim());
  if (requiredVideos.length > 0) {
    rules.push(`必须按顺序传入 ${requiredVideos.length} 个参考视频（\`generation.submit\` 的 \`videos\` 参数）。`);
  }
  if (rules.length === 0) rules.push('按提示词直接生成即可，无额外素材要求。');
  return rules;
}

/** 从 WorkflowSpec 生成插件 SKILL.md（纯函数，无 IO）。过滤口径与 workflow.list 一致：!hidden && llm !== false。 */
export function generatePluginSkill(spec: WorkflowSpec): string {
  assertPluginId(spec.id);
  const description = (spec.description ?? `工作流插件 ${spec.id}`).trim().replace(/\s+/g, ' ');
  const inputs = spec.inputs.filter(i => !i.hidden);
  const inputLines = inputs.map(i => {
    const bits: string[] = [`类型 ${KIND_LABEL[i.kind] ?? i.kind}`];
    if (i.kind === 'text' && i.primary) bits.push('提示词占位节点（primary，注入主提示词）');
    if (i.kind !== 'text' && (i.required || !String(i.defaultValue ?? '').trim())) bits.push('必传');
    if (i.defaultValue !== undefined && String(i.defaultValue).trim()) bits.push('默认值非空（模板内置）');
    return `- **${i.label}**（${bits.join('；')}）${i.description ? `\n  - ${i.description}` : ''}`;
  }).join('\n');
  const outputs = spec.outputs.filter(o => !o.hidden);
  const outputLines = outputs.map(o => `- **${o.label}**（${KIND_LABEL[o.kind] ?? o.kind}）${o.description ? `\n  - ${o.description}` : ''}`).join('\n');

  return [
    '---',
    `name: ${spec.id}`,
    `description: ${description.slice(0, 100)}`,
    '---',
    '',
    `# ${spec.name || spec.id}`,
    '',
    '> 本文件由 server/src/workflow-skill.ts 自动生成，勿手工编辑；修改插件 manifest 或重新识别后会自动重新生成。',
    '',
    '## 用途',
    '',
    description,
    '',
    '## 输入',
    '',
    inputs.length > 0 ? inputLines : '无（工作流不接收外部输入）。',
    '',
    '## 可控制参数',
    '',
    '以下参数可由 LLM 通过 `generation.submit` 的 `params` 调整（键为参数 id）：',
    '',
    paramLines(spec.params),
    '',
    '## 输出',
    '',
    outputs.length > 0 ? outputLines : '无。',
    '',
    '## 使用规则',
    '',
    ...deriveRules(spec).map(rule => `- ${rule}`),
    '',
  ].join('\n');
}

export function pluginSkillPath(id: string, root: string = PLUGIN_SKILLS_DIR): string {
  assertPluginId(id);
  return path.join(root, id, 'SKILL.md');
}

/** 生成并原子写入 SKILL.md，返回内容。 */
export function writePluginSkill(spec: WorkflowSpec, root: string = PLUGIN_SKILLS_DIR): string {
  const content = generatePluginSkill(spec);
  const file = pluginSkillPath(spec.id, root);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
  return content;
}

export function deletePluginSkill(id: string, root: string = PLUGIN_SKILLS_DIR): void {
  const file = pluginSkillPath(id, root);
  if (existsSync(file)) fs.rmSync(file, { force: true });
}

export function readPluginSkill(id: string, root: string = PLUGIN_SKILLS_DIR): string | null {
  const file = pluginSkillPath(id, root);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/** 启动幂等补齐：只写缺失的 skill 文件，不覆盖已有内容。 */
export function ensurePluginSkills(specs: WorkflowSpec[], root: string = PLUGIN_SKILLS_DIR): void {
  for (const spec of specs) {
    if (!existsSync(pluginSkillPath(spec.id, root))) {
      try {
        writePluginSkill(spec, root);
      } catch (error) {
        console.error(`[workflow-skill] 生成 ${spec.id} 失败:`, error);
      }
    }
  }
}
```

注意：`fs.rmSync` 需在文件顶部 import 中补充（`existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync`）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && pnpm exec vitest run src/workflow-skill.test.ts`
Expected: PASS（全部用例）。

- [ ] **Step 5: 类型检查**

Run: `cd server && pnpm exec tsc --noEmit`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add server/src/workflow-skill.ts server/src/workflow-skill.test.ts
git commit -m "feat: 新增工作流插件 Skill 生成器——从 manifest 生成可控制参数/输入输出/使用规则的 markdown"
```

---

### Task 2: MCP 工具 `workflow.skill`（`server/src/mcp/server.ts` + 测试）

**Files:**
- Modify: `server/src/mcp/server.ts`（`MCP_TOOLS` 数组、`handleToolCall` switch、顶部 import）
- Test: `server/src/mcp/server.test.ts`

**Interfaces:**
- Consumes: `generatePluginSkill` from `../workflow-skill.js`（Task 1）；`buildSpecsCached`（已导入）；`workflowEnabled`（`handleToolCall` 作用域内已定义）。
- Produces: MCP 工具 `workflow.skill`，入参 `workflowId`，返回 `{ content: [{ type: 'text', text: <markdown> }] }` 或 `isError: true`。

- [ ] **Step 1: 写失败测试**

在 `server/src/mcp/server.test.ts` 的 `describe('Director MCP Server')` 内追加（顶层 fixture：`mcpServer`、`taskQueue` 已在 `beforeEach` 中创建并 `start()`，直接复用 `mcpServer.handleRpcMessage`）：

```ts
it('workflow.skill 返回插件的详细使用说明', async () => {
  const res = (await mcpServer.handleRpcMessage({
    jsonrpc: '2.0',
    id: 60,
    method: 'tools/call',
    params: { name: 'workflow.skill', arguments: { workflowId: 'image_krea2_turbo_t2i' } },
  })) as any;
  expect(res.result.isError).toBeFalsy();
  const text = res.result.content[0].text as string;
  expect(text).toMatch(/^---\nname: image_krea2_turbo_t2i/);
  expect(text).toMatch(/可控制参数/);
  expect(text).toMatch(/text-551/);
  expect(text).toMatch(/text-555/);
});

it('workflow.skill 拒绝未启用或未知的插件', async () => {
  const filtered = createMcpServer({ taskQueue, port: 0, isWorkflowEnabled: id => id !== 'image_krea2_turbo_t2i' });
  try {
    const disabled = (await filtered.handleRpcMessage({
      jsonrpc: '2.0', id: 61, method: 'tools/call',
      params: { name: 'workflow.skill', arguments: { workflowId: 'image_krea2_turbo_t2i' } },
    })) as any;
    expect(disabled.result.isError).toBe(true);
    expect(JSON.stringify(disabled.result.content)).toMatch(/未启用/);

    const missing = (await filtered.handleRpcMessage({
      jsonrpc: '2.0', id: 62, method: 'tools/call',
      params: { name: 'workflow.skill', arguments: { workflowId: 'no_such_plugin' } },
    })) as any;
    expect(missing.result.isError).toBe(true);
    expect(JSON.stringify(missing.result.content)).toMatch(/未找到/);
  } finally {
    await filtered.close();
  }
});

it('tools/list 暴露 workflow.skill', async () => {
  const res = (await mcpServer.handleRpcMessage({ jsonrpc: '2.0', id: 63, method: 'tools/list', params: {} })) as any;
  const names = res.result.tools.map((t: any) => t.name);
  expect(names).toContain('workflow.skill');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && pnpm exec vitest run src/mcp/server.test.ts`
Expected: FAIL（`workflow.skill` 未定义，返回"未知工具"错误）。

- [ ] **Step 3: 实现**

在 `server/src/mcp/server.ts`：

顶部 import 增加：
```ts
import { generatePluginSkill } from '../workflow-skill.js';
```

`MCP_TOOLS` 数组增加（放在 `workflow.list` 之后）：
```ts
{
  name: 'workflow.skill',
  description: '获取某个工作流插件的详细使用说明（Skill）：可控制的 widget 参数（含默认值/范围/选项/applyTo 联动）、输入素材要求与使用规则。选定 workflowId 后如需了解该插件的完整可调参数，调用本工具；不要把这些原始内容转贴给用户。',
  inputSchema: {
    type: 'object',
    properties: {
      workflowId: {
        type: 'string',
        description: '工作流插件 ID（来自 workflow.list）',
      },
    },
    required: ['workflowId'],
  },
},
```

`handleToolCall` switch 增加 case（放在 `workflow.list` case 之后）：
```ts
case 'workflow.skill': {
  if (typeof args.workflowId !== 'string' || !args.workflowId.trim()) {
    return {
      content: [{ type: 'text', text: '错误: workflowId 为必填参数' }],
      isError: true,
    };
  }
  const spec = (await buildSpecsCached()).find(s => s.id === args.workflowId);
  if (!spec) {
    return {
      content: [{ type: 'text', text: `未找到工作流: ${args.workflowId}` }],
      isError: true,
    };
  }
  if (!workflowEnabled(spec.id)) {
    return {
      content: [{ type: 'text', text: `插件「${spec.id}」未启用，无法获取其 Skill` }],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: generatePluginSkill(spec) }],
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && pnpm exec vitest run src/mcp/server.test.ts`
Expected: PASS。

- [ ] **Step 5: 类型检查**

Run: `cd server && pnpm exec tsc --noEmit`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add server/src/mcp/server.ts server/src/mcp/server.test.ts
git commit -m "feat: MCP 新增 workflow.skill 工具——按需返回插件详细使用说明"
```

---

### Task 3: 插件路由 Skill API 与生命周期同步（`server/src/workflow-plugin-api.ts` + 测试）

**Files:**
- Modify: `server/src/workflow-plugin-api.ts`
- Test: `server/src/workflow-plugin-api.test.ts`

**Interfaces:**
- Consumes: `writePluginSkill`、`deletePluginSkill`、`readPluginSkill`、`PLUGIN_SKILLS_DIR` from `../workflow-skill.js`（Task 1）；`buildCatalogSpecs`（已导入）。
- Produces:
  - `WorkflowPluginApiOptions` 增加可选 `skillsDir?: string`（默认 `PLUGIN_SKILLS_DIR`）。
  - `GET /api/plugins/:id/skill` → `text/markdown`（文件存在读文件，否则即时生成并落盘后返回）。
  - `POST /api/plugins/:id/skill/regenerate` → `{ ok: true }`。
  - 导入（import）、保存（PUT）、删除（DELETE）时同步写/删 skill 文件。

- [ ] **Step 1: 写失败测试**

在 `server/src/workflow-plugin-api.test.ts` 追加 import 与用例：

```ts
import { readPluginSkill } from './workflow-skill.js';
```

（`fs`、`path` 已导入，`fs.existsSync` 直接用。）

在 `makeOptions` 返回对象中增加 `skillsDir: path.join(root, 'skills')`（若 `WorkflowPluginApiOptions` 类型尚未定义该字段，本步先运行确认类型报错即为预期失败）。

追加用例（describe 内）：

```ts
it('导入插件时生成 skill 文件，PUT 后重新生成，DELETE 时删除', async () => {
  const root = makeRoot();
  const options = makeOptions(root);
  await withServer(makeApp(options), async baseUrl => {
    const imported = await fetch(`${baseUrl}/api/plugins/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'demo.json', workflow: apiFixture }),
    });
    expect(imported.status).toBe(200);
    expect(readPluginSkill('demo', options.skillsDir)).toMatch(/^---\nname: demo/);

    const current = (await (await fetch(`${baseUrl}/api/plugins`)).json() as WorkflowSpec[]).find(p => p.id === 'demo')!;
    const edited = { ...current, params: [{ id: 'steps-4', label: 'Steps', nodeId: '4', field: 'steps', type: 'INT', default: 20, llm: true }] };
    const saved = await fetch(`${baseUrl}/api/plugins/demo`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(edited),
    });
    expect(saved.status).toBe(200);
    expect(readPluginSkill('demo', options.skillsDir)).toMatch(/steps-4/);

    const deleted = await fetch(`${baseUrl}/api/plugins/demo`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(fs.existsSync(path.join(options.skillsDir, 'demo', 'SKILL.md'))).toBe(false);
  });
});

it('GET /api/plugins/:id/skill 返回 markdown，regenerate 强制重写', async () => {
  const root = makeRoot();
  const options = makeOptions(root);
  await withServer(makeApp(options), async baseUrl => {
    await fetch(`${baseUrl}/api/plugins/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'demo.json', workflow: apiFixture }),
    });
    const skillRes = await fetch(`${baseUrl}/api/plugins/demo/skill`);
    expect(skillRes.status).toBe(200);
    expect(skillRes.headers.get('content-type')).toMatch(/text\/markdown/);
    expect(await skillRes.text()).toMatch(/^---\nname: demo/);

    const regen = await fetch(`${baseUrl}/api/plugins/demo/skill/regenerate`, { method: 'POST' });
    expect(regen.status).toBe(200);
    expect(await regen.json()).toEqual({ ok: true });
    expect(readPluginSkill('demo', options.skillsDir)).toMatch(/^---\nname: demo/);
  });
});

it('未知插件的 skill 接口返回 404', async () => {
  const root = makeRoot();
  const options = makeOptions(root);
  await withServer(makeApp(options), async baseUrl => {
    const res = await fetch(`${baseUrl}/api/plugins/no_such/skill`);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && pnpm exec vitest run src/workflow-plugin-api.test.ts`
Expected: FAIL（`WorkflowPluginApiOptions` 无 `skillsDir` 类型报错 + 路由 404/缺少同步逻辑）。

- [ ] **Step 3: 实现**

`server/src/workflow-plugin-api.ts`：

顶部 import 增加：
```ts
import { PLUGIN_SKILLS_DIR, deletePluginSkill, readPluginSkill, writePluginSkill } from './workflow-skill.js';
```

接口增加字段：
```ts
export interface WorkflowPluginApiOptions {
  ...
  /** skill 文件落盘目录（默认仓库 .pi/skills） */
  skillsDir?: string;
}
```

路由内部增加辅助函数（放在 `createWorkflowPluginRouter` 内、主逻辑前）：
```ts
const skillsDir = options.skillsDir ?? PLUGIN_SKILLS_DIR;
const skillSpec = async (id: string): Promise<WorkflowSpec | null> =>
  (await buildCatalogSpecs(options.catalog)).find(spec => spec.id === id) ?? null;
```

导入成功处（`writeManifest` 之后、`res.json` 之前）增加：
```ts
try {
  writePluginSkill(manifest, skillsDir);
} catch (error) {
  console.error(`[workflow-skill] 生成 ${id} 失败:`, error);
}
```

PUT 保存成功处（`writeManifest` 之后、`res.json` 之前）增加：
```ts
try {
  const spec = await skillSpec(id);
  if (spec) writePluginSkill(spec, skillsDir);
} catch (error) {
  console.error(`[workflow-skill] 重新生成 ${id} 失败:`, error);
}
```

DELETE 处（`deleteManifest` 之后、`res.json` 之前）增加：
```ts
try {
  deletePluginSkill(id, skillsDir);
} catch (error) {
  console.error(`[workflow-skill] 删除 ${id} skill 失败:`, error);
}
```

在 `match` 正则块之前增加 skill 路由块（放在 `if (req.method === 'POST' && req.path === '/api/plugins/import')` 之后）：

```ts
const skillMatch = req.path.match(/^\/api\/plugins\/([^/]+)\/skill(?:\/regenerate)?$/);
if (skillMatch) {
  const id = decodeURIComponent(skillMatch[1]!);
  const spec = await skillSpec(id);
  if (!spec) {
    jsonError(res, 404, `未找到工作流插件：${id}`);
    return;
  }
  if (req.method === 'GET') {
    const existing = readPluginSkill(id, skillsDir);
    if (existing) {
      res.type('text/markdown').send(existing);
    } else {
      const content = writePluginSkill(spec, skillsDir);
      res.type('text/markdown').send(content);
    }
    return;
  }
  if (req.method === 'POST') {
    writePluginSkill(spec, skillsDir);
    res.json({ ok: true });
    return;
  }
}
```

注意：`skillSpec` 闭包需要 `buildCatalogSpecs`（文件顶部已从 `./workflow-catalog.js` 导入）；确认 `WorkflowSpec` 类型已导入（是）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && pnpm exec vitest run src/workflow-plugin-api.test.ts`
Expected: PASS（新增 3 用例 + 既有用例全过）。

- [ ] **Step 5: 类型检查**

Run: `cd server && pnpm exec tsc --noEmit`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add server/src/workflow-plugin-api.ts server/src/workflow-plugin-api.test.ts
git commit -m "feat: 插件路由同步 skill 文件——导入/保存重新生成、删除清理，新增 skill 预览与重新生成 API"
```

---

### Task 4: 启动幂等补齐（`server/src/index.ts`）

**Files:**
- Modify: `server/src/index.ts`（顶部 import 区 + `migrateLegacyPluginConfig` 之后）

**Interfaces:**
- Consumes: `ensurePluginSkills`（Task 1）、`buildSpecsCached`（已导入）。

- [ ] **Step 1: 实现**

顶部 import（`workflow-plugin-store.js` import 之后）增加：
```ts
import { ensurePluginSkills } from './workflow-skill.js';
```

`migrateLegacyPluginConfig(...).catch(...)` 块之后、`draftStore` 定义之前增加：
```ts
// 为每个工作流插件（内置+导入）幂等补齐自动生成的 SKILL.md；
// 缺失才写入，不影响已有文件；失败不阻断启动。
await ensurePluginSkills(await buildSpecsCached());
```

- [ ] **Step 2: 类型检查 + 全量测试**

Run: `cd server && pnpm exec tsc --noEmit && pnpm exec vitest run`
Expected: 无错误，全部通过。

- [ ] **Step 3: 验证生成产物（冒烟）**

Run: `cd server && timeout 8 pnpm exec tsx src/index.ts`（启动 8 秒后自动被杀，期间执行启动补全）
Run: `ls .pi/skills/`
Expected: 出现 `image_krea2_turbo_t2i/SKILL.md` 等各插件的自动生成目录与文件。

- [ ] **Step 4: Commit**

```bash
git add server/src/index.ts
git commit -m "feat: 启动时为全部工作流插件幂等补齐自动生成的 SKILL.md"
```

---

### Task 5: 导演隔离——`--no-context-files`（`server/src/agent/bridge.ts` + 测试）

**Files:**
- Modify: `server/src/agent/bridge.ts`（`runAgentStream` args 数组）
- Test: `server/src/agent/bridge.test.ts`

**Interfaces:**
- Produces: `runAgentStream` spawn 的 pi 参数包含 `--no-context-files`。

- [ ] **Step 1: 写失败测试**

在 `server/src/agent/bridge.test.ts` 的「使用 v1 的 JSON 增量模式并在 agent_end 后立即终止 Pi」用例中，`expect(spawnArgs).toContain('--no-skills');` 之后追加：

```ts
expect(spawnArgs).toContain('--no-context-files');
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && pnpm exec vitest run src/agent/bridge.test.ts`
Expected: FAIL（`--no-context-files` 不在参数中）。

- [ ] **Step 3: 实现**

`server/src/agent/bridge.ts` 的 `runAgentStream` 中，`appendSkillIsolationArgs(args, true);` 之后追加：

```ts
  // 关闭 AGENTS.md/CLAUDE.md 上下文文件自动发现：导演 Agent 的知识来源
  // 收敛为 director-copilot skill + --append-system-prompt + MCP 工具，
  // 避免全局/项目 AGENTS.md 注入宿主编码环境规则。
  args.push('--no-context-files');
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && pnpm exec vitest run src/agent/bridge.test.ts`
Expected: PASS。

- [ ] **Step 5: 类型检查**

Run: `cd server && pnpm exec tsc --noEmit`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add server/src/agent/bridge.ts server/src/agent/bridge.test.ts
git commit -m "feat: 导演 Agent 启动参数补 --no-context-files——隔离全局/项目 AGENTS.md 上下文注入"
```

---

### Task 6: 协议同步（director-copilot SKILL.md + agentSystemPrompt + AGENTS.md 备忘）

**Files:**
- Modify: `.pi/skills/director-copilot/SKILL.md`
- Modify: `server/src/index.ts`（`agentSystemPrompt` 数组）
- Modify: `AGENTS.md`

- [ ] **Step 1: 更新 director-copilot SKILL.md**

「## 工作流选择」章节末尾追加：

```markdown
- 选定工作流后如需了解该插件的完整可控制参数（含默认值/范围/选项/联动）与输入素材要求，调用 `workflow.skill` 获取详细 skill；`workflow.list` 只提供精选摘要。
```

「## MCP 工具」章节追加：

```markdown
- `workflow.skill`：获取某个工作流插件的详细使用说明（可控制参数与使用规则）；用简洁自然语言向用户介绍，不转贴原始内容。
```

- [ ] **Step 2: 更新 agentSystemPrompt**

`server/src/index.ts` 的 `agentSystemPrompt` 数组中，在「工作流选择与参数回答规则见 director-copilot skill：询问可用工作流或可调参数时必须先调用 workflow.list，」之后追加一行：

```ts
      '选定工作流后如需了解该插件的详细可调参数与输入要求，调用 workflow.skill 获取；只介绍真实存在的参数。',
```

- [ ] **Step 3: 更新 AGENTS.md 开发备忘**

在「## Director-Copilot Skill 维护」章节末尾追加：

```markdown
## 工作流插件 Skill 自动生成

- 每个工作流插件（内置+导入）自动生成 `.pi/skills/<plugin-id>/SKILL.md`（`server/src/workflow-skill.ts`），内容为可控制参数（默认值/范围/选项/applyTo 联动）、输入输出与使用规则，过滤口径与 `workflow.list` 一致（`!hidden && llm !== false`）。
- 生成时机：启动幂等补齐、插件导入/保存 manifest 时重新生成、删除插件时删除；`GET /api/plugins/:id/skill` 预览、`POST /api/plugins/:id/skill/regenerate` 强制重写。
- MCP `workflow.skill` 按需返回某插件的详细 skill，`workflow.list` 保持精简摘要（两级结构）。
- 导演 Agent 启动参数含 `--no-context-files`：全局/项目 AGENTS.md 不再注入，知识来源仅 director-copilot skill + `--append-system-prompt` + MCP 工具。
- 插件参数契约变更（params/inputs/llm 标记等）会经生成器自动反映到 skill，无需手工同步；但 MCP 工具契约变化仍须按上节同步 director-copilot skill。
```

- [ ] **Step 4: 验证**

Run: `cd server && pnpm exec tsc --noEmit`
Expected: 无错误（agentSystemPrompt 为字符串数组，类型安全）。

- [ ] **Step 5: Commit**

```bash
git add .pi/skills/director-copilot/SKILL.md server/src/index.ts AGENTS.md
git commit -m "docs: 同步 workflow.skill 协议到 director-copilot skill、agentSystemPrompt 与 AGENTS.md 备忘"
```

---

### Task 7: 前端 Skill 预览（`web/src/api.ts` + `WorkflowMappingModal.tsx` + CSS）

**Files:**
- Modify: `web/src/api.ts`（新增 `fetchPluginSkill`、`regeneratePluginSkill`）
- Modify: `web/src/components/WorkflowMappingModal.tsx`
- Modify: `web/src/components/WorkflowMappingModal.css`

**Interfaces:**
- Consumes: `GET /api/plugins/:id/skill`（Task 3）。

- [ ] **Step 1: 实现 api.ts**

在 `web/src/api.ts` 的 `redetectWorkflowManifest` 之后追加：

```ts
/** 获取插件自动生成的 SKILL.md（预览用） */
export async function fetchPluginSkill(id: string): Promise<string> {
  const res = await fetch(`/api/plugins/${encodeURIComponent(id)}/skill`);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${detail.trim() || res.statusText}`);
  }
  return res.text();
}

/** 强制重新生成插件 SKILL.md */
export async function regeneratePluginSkill(id: string): Promise<{ ok: boolean }> {
  return http(`/api/plugins/${encodeURIComponent(id)}/skill/regenerate`, { method: 'POST' });
}
```

- [ ] **Step 2: 实现 WorkflowMappingModal.tsx**

import 区：`fetchWorkflowGraph` 的 import 中加入 `fetchPluginSkill`。

组件内新增状态（`redetectNotice` 之后）：
```ts
const [skillOpen, setSkillOpen] = useState(false);
const [skillContent, setSkillContent] = useState<string | null>(null);
const [skillLoading, setSkillLoading] = useState(false);
const [skillError, setSkillError] = useState<string | null>(null);
```

新增加载函数（`loadGraph` 之后）：
```ts
const loadSkill = async (id: string) => {
  setSkillOpen(true);
  setSkillLoading(true);
  setSkillError(null);
  try {
    setSkillContent(await fetchPluginSkill(id));
  } catch (e) {
    setSkillContent(null);
    setSkillError((e as Error).message);
  } finally {
    setSkillLoading(false);
  }
};
```

header actions 中、「全屏」按钮之后增加：
```tsx
<button className="settings-btn" onClick={() => void loadSkill(draft.id)}>Skill 预览</button>
```

`workflow-mapping-foot` 之后（`</div>` 闭合前）追加预览浮层：
```tsx
{skillOpen && (
  <div className="skill-preview-overlay" onClick={() => setSkillOpen(false)}>
    <div className="skill-preview-panel" onClick={event => event.stopPropagation()}>
      <header className="skill-preview-head">
        <h3>Skill 预览 · {draft.name || draft.id}</h3>
        <button className="settings-close" onClick={() => setSkillOpen(false)} aria-label="关闭">×</button>
      </header>
      <div className="skill-preview-body">
        {skillLoading && <p>加载中…</p>}
        {skillError && <p className="workflow-mapping-error">{skillError}</p>}
        {skillContent && <pre className="skill-preview-content">{skillContent}</pre>}
      </div>
    </div>
  </div>
)}
```

- [ ] **Step 3: 实现 CSS**

`web/src/components/WorkflowMappingModal.css` 末尾追加：

```css
.skill-preview-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1200;
}
.skill-preview-panel {
  width: min(720px, 90vw);
  max-height: 80vh;
  background: var(--surface, #14141f);
  border: 1px solid var(--border, #2a2a3d);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.skill-preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border, #2a2a3d);
}
.skill-preview-head h3 { margin: 0; font-size: 14px; }
.skill-preview-body {
  padding: 16px;
  overflow: auto;
}
.skill-preview-content {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.6;
}
```

- [ ] **Step 4: 构建验证**

Run: `cd web && pnpm exec tsc --noEmit && pnpm run build`
Expected: 无错误，构建通过。

- [ ] **Step 5: Commit**

```bash
git add web/src/api.ts web/src/components/WorkflowMappingModal.tsx web/src/components/WorkflowMappingModal.css
git commit -m "feat: 工作流映射弹窗增加 Skill 预览——展示自动生成的插件使用说明"
```

---

### Task 8: 全量回归

- [ ] **Step 1: 全量测试 + 类型检查 + 前端构建**

```bash
cd server && pnpm exec tsc --noEmit && pnpm exec vitest run
cd web && pnpm exec tsc --noEmit && pnpm run build
```

Expected: 全部通过。

- [ ] **Step 2: 冒烟验证落盘产物**

Run: `cd server && timeout 8 pnpm exec tsx src/index.ts`（启动即执行 skill 补全，8 秒后自动终止）
Run: `ls .pi/skills/ && head -30 .pi/skills/image_krea2_turbo_t2i/SKILL.md`
Expected: `image_krea2_turbo_t2i` 目录存在，SKILL.md 包含 frontmatter、可控制参数（text-551 等）、使用规则。

- [ ] **Step 3: 收尾 commit（如有未提交改动）**

```bash
git status --short
```

若有遗留改动，按内容归属补 commit；无则跳过。
