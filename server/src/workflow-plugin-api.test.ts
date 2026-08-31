import express, { type Express } from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkflowPluginRouter, validateParamMappings, validateWorkflowManifest, type WorkflowPluginApiOptions } from './workflow-plugin-api.js';
import type { WorkflowOutput, WorkflowSpec } from './workflow.js';
import { readManifest, readWorkflowJson, writeManifest, type WorkflowManifestRecord } from './workflow-plugin-store.js';
import { readPluginSkill } from './workflow-skill.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const objectInfo = {
  CLIPTextEncode: { input: { required: { text: ['STRING', { multiline: true }] } } },
  KSampler: { input: { required: {
    model: ['MODEL', {}],
    steps: ['INT', { default: 20, min: 1, max: 150, step: 1 }],
    cfg: ['FLOAT', { default: 7, min: 0, max: 30, step: 0.1 }],
  } } },
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['model.safetensors'], {}] } } },
  SaveImage: { input: { required: { images: ['IMAGE', {}], filename_prefix: ['STRING', {}] } } },
};

const uiFixture = {
  nodes: [
    { id: 1, type: 'CLIPTextEncode', pos: [10, 20], widgets_values: ['default prompt'], inputs: [] },
    { id: 2, type: 'SaveImage', pos: [300, 400], widgets_values: ['demo'], inputs: [{ name: 'images', link: 1 }] },
  ],
  links: [[1, 1, 0, 2, 0, 'IMAGE']],
};

const apiFixture = {
  '1': { class_type: 'CLIPTextEncode', inputs: { text: 'default prompt' } },
  '3': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
  '4': { class_type: 'KSampler', inputs: { model: ['3', 0], positive: ['1', 0], steps: 20, cfg: 7 } },
  '2': { class_type: 'SaveImage', inputs: { images: ['4', 0], filename_prefix: 'demo' } },
};

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-plugin-api-'));
  roots.push(root);
  return root;
}

function makeOptions(root: string): WorkflowPluginApiOptions {
  const bundledDir = path.join(root, 'bundled');
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(bundledDir, { recursive: true });
  return {
    catalog: {
      bundledDir,
      importedDir: path.join(dataRoot, 'workflows'),
      manifestDir: dataRoot,
      introspect: async (json: Record<string, any>): Promise<WorkflowSpec> => ({
        id: '',
        name: 'Detected workflow',
        inputs: [{ id: 'text-1', kind: 'text', label: 'Prompt', nodeId: '1', field: 'text', classType: 'CLIPTextEncode' }],
        params: [],
        outputs: [{ id: 'images-2', kind: 'image', label: 'Image', nodeId: '2', classType: 'SaveImage' }],
      }),
    },
    dataRoot,
    objectInfo: async () => objectInfo,
    isWorkflowEnabled: () => true,
    invalidate: () => undefined,
    skillsDir: path.join(root, 'skills'),
  };
}

async function withServer<T>(app: Express, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = await new Promise<http.Server>((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  const address = server.address() as { port: number };
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function makeApp(options: WorkflowPluginApiOptions): Express {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(createWorkflowPluginRouter(options));
  return app;
}

describe('workflow plugin API', () => {
  it('导入 API 格式工作流并创建初始 manifest', async () => {
    const root = makeRoot();
    const options = makeOptions(root);
    await withServer(makeApp(options), async baseUrl => {
      const response = await fetch(`${baseUrl}/api/plugins/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'demo.json', workflow: apiFixture }),
      });
      expect(response.status).toBe(200);
      expect((readManifest(options.catalog.manifestDir, 'demo')).status).toBe('valid');
      expect(readWorkflowJson(options.dataRoot, 'demo')).toEqual(apiFixture);
      const body = await response.json() as { plugin: WorkflowSpec & { hasManifest: boolean } };
      expect(body.plugin).toMatchObject({ id: 'demo', hasManifest: true });
      expect(body.plugin.inputs).toEqual([expect.objectContaining({ id: 'text-1', hidden: true })]);
      expect(body.plugin.outputs).toEqual([expect.objectContaining({ id: 'images-2', hidden: true })]);
    });
  });

  it('保存节点位置时同步更新 imported UI 源 JSON', async () => {
    const root = makeRoot();
    const options = makeOptions(root);
    await withServer(makeApp(options), async baseUrl => {
      const imported = await fetch(`${baseUrl}/api/plugins/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'ui-demo.json', workflow: uiFixture }),
      });
      const importedBody = await imported.text();
      expect(imported.status, importedBody).toBe(200);
      const current = (JSON.parse(importedBody) as { plugin: WorkflowSpec }).plugin;

      const response = await fetch(`${baseUrl}/api/plugins/ui-demo/configure`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          manifest: current,
          nodePositions: { '1': { x: 120, y: 240 } },
        }),
      });
      expect(response.status).toBe(200);
      expect(readWorkflowJson(options.dataRoot, 'ui-demo')?.nodes).toEqual([
        { id: 1, type: 'CLIPTextEncode', pos: [120, 240], widgets_values: ['default prompt'], inputs: [] },
        { id: 2, type: 'SaveImage', pos: [300, 400], widgets_values: ['demo'], inputs: [{ name: 'images', link: 1 }] },
      ]);

      const graphResponse = await fetch(`${baseUrl}/api/plugins/ui-demo/graph`);
      expect(graphResponse.status).toBe(200);
      const graph = (await graphResponse.json() as { graph: { nodes: Array<{ nodeId: string; x: number; y: number }> } }).graph;
      expect(graph.nodes.find(node => node.nodeId === '1')).toMatchObject({ x: 120, y: 240 });
    });
  });

  it('保存 API 格式工作流节点位置并在 graph 中恢复', async () => {
    const root = makeRoot();
    const options = makeOptions(root);
    await withServer(makeApp(options), async baseUrl => {
      const importResponse = await fetch(`${baseUrl}/api/plugins/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'api-position-demo.json', workflow: apiFixture }),
      });
      expect(importResponse.status).toBe(200);
      const current = (await importResponse.json() as { plugin: WorkflowSpec }).plugin;

      const response = await fetch(`${baseUrl}/api/plugins/api-position-demo/configure`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: current, nodePositions: { '1': { x: 640, y: 360 } }, positionsOnly: true }),
      });
      expect(response.status).toBe(200);
      expect(readWorkflowJson(options.dataRoot, 'api-position-demo')?._minidream_node_positions).toEqual({ '1': { x: 640, y: 360 } });

      const graphResponse = await fetch(`${baseUrl}/api/plugins/api-position-demo/graph`);
      const graph = (await graphResponse.json() as { graph: { nodes: Array<{ nodeId: string; x: number; y: number }> } }).graph;
      expect(graph.nodes.find(node => node.nodeId === '1')).toMatchObject({ x: 640, y: 360 });
    });
  });

  it('仅保存节点位置时不被旧的失效参数映射拦截', async () => {
    const root = makeRoot();
    const options = makeOptions(root);
    await withServer(makeApp(options), async baseUrl => {
      const importResponse = await fetch(`${baseUrl}/api/plugins/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'stale-manifest.json', workflow: apiFixture }),
      });
      expect(importResponse.status).toBe(200);
      const current = (await importResponse.json() as { plugin: WorkflowSpec }).plugin;
      const stale = {
        ...current,
        params: [{ id: 'strength_model-145', label: 'strength_model', nodeId: '145', field: 'strength_model', type: 'FLOAT', default: 1 }],
      } as WorkflowManifestRecord;
      writeManifest(options.catalog.manifestDir, stale);

      const response = await fetch(`${baseUrl}/api/plugins/stale-manifest/configure`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: stale, nodePositions: { '1': { x: 120, y: 80 } }, positionsOnly: true }),
      });
      expect(response.status).toBe(200);
      expect(readWorkflowJson(options.dataRoot, 'stale-manifest')?._minidream_node_positions).toEqual({ '1': { x: 120, y: 80 } });
    });
  });

  it('重复 ID 返回 409，显式 overwrite 才替换 imported 源', async () => {
    const root = makeRoot();
    const options = makeOptions(root);
    await withServer(makeApp(options), async baseUrl => {
      const request = (workflow: Record<string, any>, overwrite?: boolean) => fetch(`${baseUrl}/api/plugins/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'demo.json', workflow, ...(overwrite ? { overwrite } : {}) }),
      });
      expect((await request(apiFixture)).status).toBe(200);
      expect((await request({ ...apiFixture, '1': { ...apiFixture['1'], inputs: { text: 'changed' } } })).status).toBe(409);
      expect((await request({ ...apiFixture, '1': { ...apiFixture['1'], inputs: { text: 'changed' } } }, true)).status).toBe(200);
      expect(readWorkflowJson(options.dataRoot, 'demo')?.['1']?.inputs?.text).toBe('changed');
    });
  });

  it('允许保存时移除输入输出候选，但必须保留至少一个可用输出', async () => {
    const root = makeRoot();
    const options = makeOptions(root);
    await withServer(makeApp(options), async baseUrl => {
      const importResponse = await fetch(`${baseUrl}/api/plugins/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'editable-interface.json', workflow: apiFixture }),
      });
      expect(importResponse.status).toBe(200);
      const current = (await importResponse.json() as { plugin: WorkflowSpec }).plugin;

      const withoutInput = {
        ...current,
        inputs: [],
        outputs: current.outputs.map(output => ({ ...output, hidden: false })),
      };
      const removedInput = await fetch(`${baseUrl}/api/plugins/editable-interface`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(withoutInput),
      });
      expect(removedInput.status).toBe(200);

      const saved = (readManifest(options.catalog.manifestDir, 'editable-interface') as any).manifest as WorkflowSpec;
      expect(saved.inputs).toEqual([]);
      expect(saved.outputs.some(output => !output.hidden)).toBe(true);

      const withoutOutput = { ...saved, outputs: [] };
      const removedOutput = await fetch(`${baseUrl}/api/plugins/editable-interface`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(withoutOutput),
      });
      expect(removedOutput.status).toBe(400);
      expect((await removedOutput.json() as { error: string }).error).toContain('至少保留一个');
    });
  });

  it('拒绝引用不存在节点的 manifest，并保留之前的有效清单', async () => {
    const root = makeRoot();
    const options = makeOptions(root);
    await withServer(makeApp(options), async baseUrl => {
      const importResponse = await fetch(`${baseUrl}/api/plugins/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'demo.json', workflow: apiFixture }),
      });
      expect(importResponse.status).toBe(200);
      const current = (await importResponse.json() as { plugin: WorkflowSpec }).plugin;
      const invalid = { ...current, inputs: [{ ...current.inputs[0], nodeId: 'missing' }] };
      const response = await fetch(`${baseUrl}/api/plugins/demo`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(invalid),
      });
      expect(response.status).toBe(400);
      expect((await response.json() as { error: string }).error).toMatch(/inputs.*结构.*nodeId/);
      expect((readManifest(options.catalog.manifestDir, 'demo')).status).toBe('valid');
    });
  });

  it('返回 graph 并允许新增普通 widget 参数，但拒绝连接字段和伪造类型', async () => {
    const root = makeRoot();
    const options = makeOptions(root);
    await withServer(makeApp(options), async baseUrl => {
      const imported = await fetch(`${baseUrl}/api/plugins/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'demo.json', workflow: apiFixture }),
      });
      expect(imported.status).toBe(200);
      const graphResponse = await fetch(`${baseUrl}/api/plugins/demo/graph`);
      expect(graphResponse.status).toBe(200);
      const graphBody = await graphResponse.json() as { graph: { nodes: Array<{ nodeId: string; fields: Array<{ field: string; selectable: boolean; connected: boolean }> }> } };
      const sampler = graphBody.graph.nodes.find(node => node.nodeId === '4')!;
      expect(sampler.fields.find(field => field.field === 'cfg')).toMatchObject({ selectable: true, connected: false });
      expect(sampler.fields.find(field => field.field === 'model')).toMatchObject({ selectable: false, connected: true });

      const current = (await (await fetch(`${baseUrl}/api/plugins`)).json() as WorkflowSpec[]).find(plugin => plugin.id === 'demo')!;
      const selected = {
        ...current,
        params: [{ id: 'cfg-4', label: 'CFG', nodeId: '4', field: 'cfg', type: 'FLOAT', default: 7 }],
      };
      const save = await fetch(`${baseUrl}/api/plugins/demo`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(selected),
      });
      expect(save.status).toBe(200);

      const connectionAttempt = await fetch(`${baseUrl}/api/plugins/demo`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...selected, params: [{ ...selected.params[0], field: 'model', id: 'model-4', type: 'STRING' }] }),
      });
      expect(connectionAttempt.status).toBe(400);
      expect((await connectionAttempt.json() as { error: string }).error).toMatch(/连接|widget|selectable/);
    });
  });

  it('允许删除参数但拒绝修改参数的节点结构或类型', async () => {
    const root = makeRoot();
    const options = makeOptions(root);
    await withServer(makeApp(options), async baseUrl => {
      await fetch(`${baseUrl}/api/plugins/import`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'demo.json', workflow: apiFixture }),
      });
      const current = (await (await fetch(`${baseUrl}/api/plugins`)).json() as WorkflowSpec[]).find(plugin => plugin.id === 'demo')!;
      const selected = { ...current, params: [{ id: 'cfg-4', label: 'CFG', nodeId: '4', field: 'cfg', type: 'FLOAT', default: 7 }] };
      expect((await fetch(`${baseUrl}/api/plugins/demo`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(selected) })).status).toBe(200);
      expect((await fetch(`${baseUrl}/api/plugins/demo`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...selected, params: [] }) })).status).toBe(200);
      expect((await fetch(`${baseUrl}/api/plugins/demo`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...selected, params: [{ ...selected.params[0], type: 'INT' }] }) })).status).toBe(400);
    });
  });

  it('导入插件时生成 skill 文件，manifest 保存不自动更新，显式重新生成后更新，DELETE 时删除', async () => {
    const root = makeRoot();
    const options = makeOptions(root);
    await withServer(makeApp(options), async baseUrl => {
      const imported = await fetch(`${baseUrl}/api/plugins/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'demo.json', workflow: apiFixture }),
      });
      expect(imported.status).toBe(200);
      expect(readPluginSkill('demo', options.skillsDir!)).toMatch(/^---\nname: demo/);

      const current = (await (await fetch(`${baseUrl}/api/plugins`)).json() as WorkflowSpec[]).find(p => p.id === 'demo')!;
      const edited = { ...current, params: [{ id: 'steps-4', label: 'Steps', nodeId: '4', field: 'steps', type: 'INT', default: 20, llm: true }] };
      const saved = await fetch(`${baseUrl}/api/plugins/demo`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(edited),
      });
      expect(saved.status).toBe(200);
      expect(readPluginSkill('demo', options.skillsDir!)).not.toMatch(/steps-4/);

      const regenerated = await fetch(`${baseUrl}/api/plugins/demo/skill/regenerate`, { method: 'POST' });
      expect(regenerated.status).toBe(200);
      expect(readPluginSkill('demo', options.skillsDir!)).toMatch(/steps-4/);

      const deleted = await fetch(`${baseUrl}/api/plugins/demo`, { method: 'DELETE' });
      expect(deleted.status).toBe(200);
      expect(fs.existsSync(path.join(options.skillsDir!, 'demo', 'SKILL.md'))).toBe(false);
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
      expect(readPluginSkill('demo', options.skillsDir!)).toMatch(/^---\nname: demo/);
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

  it('PUT /api/plugins/:id/skill 保存自定义内容且不被 manifest 保存覆盖', async () => {
    const root = makeRoot();
    const options = makeOptions(root);
    await withServer(makeApp(options), async baseUrl => {
      await fetch(`${baseUrl}/api/plugins/import`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'demo.json', workflow: apiFixture }),
      });
      const generated = readPluginSkill('demo', options.skillsDir!)!;
      const custom = `${generated}\n\n用户修改的内容`;
      const saved = await fetch(`${baseUrl}/api/plugins/demo/skill`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: custom }),
      });
      expect(saved.status).toBe(200);
      expect(await (await fetch(`${baseUrl}/api/plugins/demo/skill`)).text()).toBe(custom);

      // 保存 manifest 不应覆盖从自动版编辑而来的自定义版本
      const current = (await (await fetch(`${baseUrl}/api/plugins`)).json() as WorkflowSpec[]).find(p => p.id === 'demo')!;
      const resave = await fetch(`${baseUrl}/api/plugins/demo`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...current, name: '改名' }),
      });
      expect(resave.status).toBe(200);
      expect(readPluginSkill('demo', options.skillsDir!)).toBe(custom);
      expect(await (await fetch(`${baseUrl}/api/plugins/demo/skill`)).text()).toBe(custom);
    });
  });

  it('POST /api/plugins/:id/skill/generate 调用注入的生成器并写入自定义内容', async () => {
    const root = makeRoot();
    const options = makeOptions(root);
    const generateSkill = vi.fn(async (spec: WorkflowSpec) => `# LLM skill for ${spec.id}\n\n生成内容`);
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use(createWorkflowPluginRouter({ ...options, generateSkill }));
    await withServer(app, async baseUrl => {
      await fetch(`${baseUrl}/api/plugins/import`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'demo.json', workflow: apiFixture }),
      });
      const res = await fetch(`${baseUrl}/api/plugins/demo/skill/generate`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; content: string };
      expect(body.ok).toBe(true);
      expect(body.content).toContain('LLM skill for demo');
      expect(generateSkill).toHaveBeenCalledWith(expect.objectContaining({ id: 'demo' }));
      expect(readPluginSkill('demo', options.skillsDir!)).toBe(body.content);
    });
  });

  it('POST /skill/generate 未配置生成器时返回错误', async () => {
    const root = makeRoot();
    const options = makeOptions(root);
    await withServer(makeApp(options), async baseUrl => {
      await fetch(`${baseUrl}/api/plugins/import`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'demo.json', workflow: apiFixture }),
      });
      const res = await fetch(`${baseUrl}/api/plugins/demo/skill/generate`, { method: 'POST' });
      expect(res.status).toBe(501);
    });
  });

  it('POST /api/plugins/:id/skill/chat 传入 widget、当前 Skill 和历史，但只返回预览不落盘', async () => {
    const root = makeRoot();
    const options = makeOptions(root);
    const chatSkill = vi.fn(async (spec: WorkflowSpec, currentSkill: string, history: Array<{ role: 'user' | 'assistant'; content: string }>, message: string) => ({
      reply: `已调整 ${spec.id}：${message}`,
      skill: `${currentSkill}\n## 对话调整\n\n- ${history.length} 条历史`,
    }));
    const app = makeApp({ ...options, chatSkill });
    await withServer(app, async baseUrl => {
      await fetch(`${baseUrl}/api/plugins/import`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'demo.json', workflow: apiFixture }),
      });
      const before = readPluginSkill('demo', options.skillsDir!);
      const response = await fetch(`${baseUrl}/api/plugins/demo/skill/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: '隐藏 prompt 预览',
          currentSkill: `${before}\n\n未保存的手工调整`,
          history: [
            { role: 'user', content: '先讨论回复格式' },
            { role: 'assistant', content: '当前 prompt 可见' },
          ],
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        reply: '已调整 demo：隐藏 prompt 预览',
        skill: expect.stringContaining('2 条历史'),
      });
      expect(chatSkill).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'demo', params: [] }),
        `${before}\n\n未保存的手工调整`,
        [
          { role: 'user', content: '先讨论回复格式' },
          { role: 'assistant', content: '当前 prompt 可见' },
        ],
        '隐藏 prompt 预览',
      );
      expect(readPluginSkill('demo', options.skillsDir!)).toBe(before);
    });
  });

  it('GET/PUT /api/plugins/:id/response 读取兼容协议并保存自定义协议', async () => {
    const root = makeRoot();
    const options = makeOptions(root);
    await withServer(makeApp(options), async baseUrl => {
      await fetch(`${baseUrl}/api/plugins/import`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'demo.json', workflow: apiFixture }),
      });
      const initial = await fetch(`${baseUrl}/api/plugins/demo/response`);
      expect(initial.status).toBe(200);
      const initialBody = await initial.json() as { protocol: { version: number; result: { display: string } } };
      expect(initialBody.protocol.version).toBe(1);
      expect(initialBody.protocol.result.display).toBe('outside-bubble');

      const custom = {
        version: 1,
        thinking: { enabled: true, container: 'collapsible', format: 'plain', defaultOpen: false },
        blocks: [{ id: 'prompt', type: 'field', source: 'generation.prompt', label: '提示词', container: 'collapsible', format: 'code', language: 'text', timing: 'submit' }],
        result: { display: 'outside-bubble' },
      };
      const saved = await fetch(`${baseUrl}/api/plugins/demo/response`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ protocol: custom }),
      });
      expect(saved.status).toBe(200);
      expect((await (await fetch(`${baseUrl}/api/plugins/demo/response`)).json() as { protocol: typeof custom }).protocol).toEqual(custom);

      const invalid = await fetch(`${baseUrl}/api/plugins/demo/response`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ protocol: { ...custom, blocks: [{ ...custom.blocks[0], source: 'param.missing' }] } }),
      });
      expect(invalid.status).toBe(400);
    });
  });

  it('回复协议保存后再保存 manifest 仍保持自定义内容', async () => {
    const root = makeRoot();
    const options = makeOptions(root);
    await withServer(makeApp(options), async baseUrl => {
      await fetch(`${baseUrl}/api/plugins/import`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'demo.json', workflow: apiFixture }),
      });
      const current = (await (await fetch(`${baseUrl}/api/plugins`)).json() as WorkflowSpec[]).find(p => p.id === 'demo')!;
      const selected = {
        ...current,
        params: [{ id: 'steps-4', label: 'Steps', nodeId: '4', field: 'steps', type: 'INT', default: 20, llm: true }],
      };
      expect((await fetch(`${baseUrl}/api/plugins/demo`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(selected) })).status).toBe(200);
      const protocol = {
        version: 1,
        thinking: { enabled: true, container: 'collapsible', format: 'plain', defaultOpen: false },
        blocks: [
          { id: 'steps', type: 'field', source: 'param.steps-4', label: 'Steps', container: 'collapsible', format: 'code', language: 'text', timing: 'submit' },
          { id: 'template', type: 'template', template: '尺寸：{{param.steps-4}}', container: 'text', format: 'plain', timing: 'always' },
        ],
        result: { display: 'outside-bubble' },
      };
      expect((await fetch(`${baseUrl}/api/plugins/demo/response`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ protocol }) })).status).toBe(200);
      expect((await fetch(`${baseUrl}/api/plugins/demo`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...selected, description: 'changed' }) })).status).toBe(200);
      expect((await (await fetch(`${baseUrl}/api/plugins/demo/response`)).json() as { protocol: typeof protocol }).protocol).toEqual(protocol);
    });
  });

  it('POST /api/plugins/:id/skill/chat 缺少消息时返回 400', async () => {
    const root = makeRoot();
    const options = makeOptions(root);
    const chatSkill = vi.fn();
    await withServer(makeApp({ ...options, chatSkill }), async baseUrl => {
      await fetch(`${baseUrl}/api/plugins/import`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'demo.json', workflow: apiFixture }),
      });
      const response = await fetch(`${baseUrl}/api/plugins/demo/skill/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '  ' }),
      });
      expect(response.status).toBe(400);
      expect(chatSkill).not.toHaveBeenCalled();
    });
  });

  it('重识别返回合并结果但不自动写入 manifest', async () => {
    const root = makeRoot();
    const options = makeOptions(root);
    await withServer(makeApp(options), async baseUrl => {
      const imported = await fetch(`${baseUrl}/api/plugins/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'demo.json', workflow: apiFixture }),
      });
      const current = (await imported.json() as { plugin: WorkflowSpec }).plugin;
      const edited = { ...current, inputs: [{ ...current.inputs[0], description: '手工描述', label: '自定义输入' }] };
      const save = await fetch(`${baseUrl}/api/plugins/demo`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(edited),
      });
      expect(save.status).toBe(200);
      const before = readManifest(options.catalog.manifestDir, 'demo');
      const result = await fetch(`${baseUrl}/api/plugins/demo/redetect`, { method: 'POST' });
      expect(result.status).toBe(200);
      expect((await result.json() as WorkflowSpec).inputs[0]).toMatchObject({ description: '手工描述', label: '自定义输入' });
      expect(readManifest(options.catalog.manifestDir, 'demo')).toEqual(before);
    });
  });

  it('validateParamMappings 放行节点屏蔽（bypass）参数（无真实字段）', () => {
    const graph = {
      nodes: [
        { nodeId: '5404', title: 'First Frame', classType: 'LoadImage', x: 0, y: 0, fields: [
          { nodeId: '5404', field: 'image', type: 'COMBO', selectable: true, connected: false, selected: true, options: ['a.png'], value: 'a.png' },
        ] },
      ],
    };
    const manifest: WorkflowSpec = {
      id: 'demo',
      name: 'Demo',
      inputs: [],
      params: [
        { id: 'image-5404', label: 'image', nodeId: '5404', field: 'image', type: 'combo', default: 'a.png' },
        { id: 'bypass-5404', label: '跳过First Frame', nodeId: '5404', field: '', type: 'BOOLEAN', default: false, bypass: true },
      ],
      outputs: [],
    };
    expect(validateParamMappings(manifest, graph as any)).toBeNull();
    // 普通参数仍校验字段存在（节点不存在同样报字段错误）
    const broken: WorkflowSpec = {
      ...manifest,
      params: [{ id: 'bad-1', label: 'x', nodeId: '9999', field: 'nope', type: 'INT', default: 1, bypass: false }],
    };
    expect(validateParamMappings(broken, graph as any)).toMatch(/指向不存在字段：9999\.nope/);
  });

  it('analyze 只返回配置建议预览，不写入任何文件', async () => {
    const root = makeRoot();
    const options = makeOptions(root);
    await withServer(makeApp(options), async baseUrl => {
      const imported = await fetch(`${baseUrl}/api/plugins/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'demo.json', workflow: apiFixture }),
      });
      expect(imported.status).toBe(200);

      const snapshot = (): string[] => (fs.readdirSync(root, { recursive: true }) as string[])
        .filter(entry => entry.endsWith('.json') || entry.endsWith('.md'))
        .sort()
        .map(entry => `${entry}:${fs.readFileSync(path.join(root, entry), 'utf8')}`);
      const before = snapshot();

      const result = await fetch(`${baseUrl}/api/plugins/demo/analyze`, { method: 'POST' });
      expect(result.status).toBe(200);
      const body = await result.json() as {
        ok: boolean;
        analysis: {
          workflow: { format: string; nodeCount: number };
          inputs: Array<{ candidate: { id: string }; recommended: boolean }>;
          outputs: Array<{ candidate: { id: string }; recommended: boolean }>;
          widgets: Array<{ exposure: string; field: { field: string } }>;
        };
      };
      expect(body.ok).toBe(true);
      expect(body.analysis.workflow.format).toBe('api');
      expect(body.analysis.workflow.nodeCount).toBe(4);
      expect(body.analysis.inputs[0]?.candidate.id).toBe('text-1');
      expect(body.analysis.outputs[0]?.candidate.id).toBe('images-2');
      // KSampler.steps 未在 manifest 中 → review；连接字段不进入 widget 建议
      const exposures = Object.fromEntries(body.analysis.widgets.map(w => [w.field.field, w.exposure]));
      expect(exposures['steps']).toBe('review');
      expect(exposures['model']).toBeUndefined();

      expect(snapshot()).toEqual(before);
    });
  });

  it('analyze 对未知插件返回 404', async () => {
    const root = makeRoot();
    const options = makeOptions(root);
    await withServer(makeApp(options), async baseUrl => {
      const result = await fetch(`${baseUrl}/api/plugins/nope/analyze`, { method: 'POST' });
      expect(result.status).toBe(404);
    });
  });

  it('analyze 合并 LLM 建议并丢弃非法引用；LLM 失败时回退基础分析', async () => {
    const options = makeOptions(makeRoot());
    const analyzeLlm = vi.fn(async () => ({
      purpose: { description: 'LLM 描述' },
      widgets: [{ nodeId: '4', field: 'steps', exposure: 'llm' as const, reason: '常用' }],
    }));
    await withServer(makeApp({ ...options, analyzeLlm }), async baseUrl => {
      await fetch(`${baseUrl}/api/plugins/import`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'demo.json', workflow: apiFixture }),
      });
      const result = await fetch(`${baseUrl}/api/plugins/demo/analyze`, { method: 'POST' });
      expect(result.status).toBe(200);
      const body = await result.json() as { analysis: { purpose: { description: string }; widgets: Array<{ exposure: string; field: { field: string } }> } };
      expect(body.analysis.purpose.description).toBe('LLM 描述');
      expect(body.analysis.widgets.find(w => w.field.field === 'steps')?.exposure).toBe('llm');

      // useLlm:false 跳过 LLM
      analyzeLlm.mockClear();
      await fetch(`${baseUrl}/api/plugins/demo/analyze`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ useLlm: false }),
      });
      expect(analyzeLlm).not.toHaveBeenCalled();
    });
  });

  it('analyze LLM 失败时仍返回基础分析并附警告', async () => {
    const options = makeOptions(makeRoot());
    await withServer(makeApp({ ...options, analyzeLlm: async () => { throw new Error('boom'); } }), async baseUrl => {
      await fetch(`${baseUrl}/api/plugins/import`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'demo.json', workflow: apiFixture }),
      });
      const result = await fetch(`${baseUrl}/api/plugins/demo/analyze`, { method: 'POST' });
      expect(result.status).toBe(200);
      const body = await result.json() as { analysis: { inputs: unknown[] }; warnings: string[] };
      expect(body.analysis.inputs.length).toBeGreaterThan(0);
      expect(body.warnings.join(' ')).toContain('boom');
    });
  });

  it('保存时自动移除旧版已连接的 text 输入映射', async () => {
    const root = makeRoot();
    const options = makeOptions(root);
    options.objectInfo = async () => ({
      ...objectInfo,
      'Text Multiline': { input: { required: { text: ['STRING'] } } },
      CLIPLoader: { input: { required: { clip_name: ['STRING'] } } },
    });
    const connectedWorkflow = {
      '1': { class_type: 'CLIPTextEncode', inputs: { text: ['5', 0], clip: ['3', 1] } },
      '2': { class_type: 'SaveImage', inputs: { images: ['4', 0], filename_prefix: 'demo' } },
      '3': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
      '4': { class_type: 'KSampler', inputs: { model: ['3', 0], positive: ['1', 0], steps: 20, cfg: 7 } },
      '5': { class_type: 'Text Multiline', inputs: { text: 'default prompt' } },
    };
    await withServer(makeApp(options), async baseUrl => {
      const imported = await fetch(`${baseUrl}/api/plugins/import`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'legacy-connected-text.json', workflow: connectedWorkflow }),
      });
      expect(imported.status).toBe(200);
      const current = (await imported.json() as { plugin: WorkflowSpec }).plugin;
      const stale = {
        ...current,
        name: '修复旧配置',
        inputs: [{ id: 'text-1', kind: 'text' as const, label: '提示词', nodeId: '1', field: 'text', classType: 'CLIPTextEncode' }],
      } as WorkflowManifestRecord;
      writeManifest(options.catalog.manifestDir, stale);

      const saved = await fetch(`${baseUrl}/api/plugins/legacy-connected-text`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(stale),
      });
      const savedBody = await saved.text();
      expect(saved.status, savedBody).toBe(200);
      const persisted = readManifest(options.catalog.manifestDir, 'legacy-connected-text');
      expect(persisted.status).toBe('valid');
      if (persisted.status === 'valid') {
        expect(persisted.manifest.inputs).toEqual([]);
        expect(persisted.manifest.name).toBe('修复旧配置');
      }
    });
  });

  it('仅保存节点位置时也会清理旧版已连接的 text 输入映射', async () => {
    const root = makeRoot();
    const options = makeOptions(root);
    options.objectInfo = async () => ({
      ...objectInfo,
      'Text Multiline': { input: { required: { text: ['STRING'] } } },
      CLIPLoader: { input: { required: { clip_name: ['STRING'] } } },
    });
    const connectedWorkflow = {
      '1': { class_type: 'CLIPTextEncode', inputs: { text: ['5', 0], clip: ['3', 1] } },
      '2': { class_type: 'SaveImage', inputs: { images: ['4', 0], filename_prefix: 'demo' } },
      '3': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
      '4': { class_type: 'KSampler', inputs: { model: ['3', 0], positive: ['1', 0], steps: 20, cfg: 7 } },
      '5': { class_type: 'Text Multiline', inputs: { text: 'default prompt' } },
    };
    await withServer(makeApp(options), async baseUrl => {
      const imported = await fetch(`${baseUrl}/api/plugins/import`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'legacy-position-text.json', workflow: connectedWorkflow }),
      });
      expect(imported.status).toBe(200);
      const current = (await imported.json() as { plugin: WorkflowSpec }).plugin;
      const stale = {
        ...current,
        inputs: [{ id: 'text-1', kind: 'text' as const, label: '提示词', nodeId: '1', field: 'text', classType: 'CLIPTextEncode' }],
      } as WorkflowManifestRecord;
      writeManifest(options.catalog.manifestDir, stale);

      const saved = await fetch(`${baseUrl}/api/plugins/legacy-position-text/configure`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: stale, nodePositions: { '1': { x: 200, y: 100 } }, positionsOnly: true }),
      });
      const savedBody = await saved.text();
      expect(saved.status, savedBody).toBe(200);
      const persisted = readManifest(options.catalog.manifestDir, 'legacy-position-text');
      expect(persisted.status).toBe('valid');
      if (persisted.status === 'valid') expect(persisted.manifest.inputs).toEqual([]);
    });
  });

  it('允许广义输入输出接口，并拒绝内部输出类型', async () => {
    const workflow = {
      '1': { class_type: 'CustomSource', inputs: { text: 'hello', count: 3, enabled: true } },
      '2': { class_type: 'CustomSink', inputs: { source: ['1', 0] } },
    };
    const info = {
      CustomSource: { input: { required: { text: ['STRING'], count: ['INT'], enabled: ['BOOLEAN'] } }, output: ['STRING', 'INT', 'BOOLEAN'] },
      CustomSink: { input: { required: { source: ['STRING'] } }, output: ['MODEL'] },
    };
    const valid = {
      id: 'generic', name: 'Generic', inputs: [
        { id: 'count', kind: 'number' as const, label: 'Count', nodeId: '1', field: 'count', classType: 'CustomSource' },
        { id: 'enabled', kind: 'boolean' as const, label: 'Enabled', nodeId: '1', field: 'enabled', classType: 'CustomSource' },
      ], params: [], outputs: [
        { id: 'result', kind: 'text' as const, label: 'Result', nodeId: '1', classType: 'CustomSource', slot: 0, type: 'STRING' },
      ],
    } satisfies WorkflowSpec;
    expect(await validateWorkflowManifest(valid, workflow, info, true)).toBeNull();
    expect(await validateWorkflowManifest({ ...valid, outputs: [{ ...valid.outputs[0]!, kind: 'text', nodeId: '2', slot: 0, type: 'MODEL' }] }, workflow, info, true)).toMatch(/不存在|类型|输出/);
  });

  it('提供通用输入输出候选，并拒绝已连接输入与错误输出端口', async () => {
    const root = makeRoot();
    const options = makeOptions(root);
    const customWorkflow = {
      '1': { class_type: 'CustomSource', inputs: { text: 'hello', count: 3 } },
      '2': { class_type: 'CustomSink', inputs: { source: ['1', 0] } },
    };
    fs.writeFileSync(path.join(options.catalog.bundledDir, 'custom.json'), JSON.stringify(customWorkflow), 'utf8');
    options.objectInfo = async () => ({
      CustomSource: { input: { required: { text: ['STRING'], count: ['INT'] } }, output: ['STRING', 'INT'] },
      CustomSink: { input: { required: { source: ['STRING'], extra: ['STRING'] } }, output: ['MODEL'] },
    });
    await withServer(makeApp(options), async baseUrl => {
      const response = await fetch(`${baseUrl}/api/plugins/custom/interface-candidates`);
      expect(response.status).toBe(200);
      const body = await response.json() as { candidates: { inputs: Array<{ nodeId: string; field: string }>; outputs: Array<{ nodeId: string; slot: number; type: string }> } };
      expect(body.candidates.inputs).toEqual(expect.arrayContaining([
        expect.objectContaining({ nodeId: '1', field: 'text' }),
        expect.objectContaining({ nodeId: '1', field: 'count' }),
        expect.objectContaining({ nodeId: '2', field: 'extra' }),
      ]));
      expect(body.candidates.inputs).not.toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: '2', field: 'source' })]));

      const valid = {
        id: 'custom', name: 'Custom', inputs: [], params: [],
        outputs: [{ id: 'result', kind: 'text' as const, label: 'Result', nodeId: '1', classType: 'CustomSource', slot: 0, type: 'STRING' }],
      } satisfies WorkflowSpec;
      expect(await validateWorkflowManifest(valid, customWorkflow, await options.objectInfo!(), true)).toBeNull();
      expect(await validateWorkflowManifest({ ...valid, outputs: [{ ...valid.outputs[0]!, slot: 1 }] }, customWorkflow, await options.objectInfo!(), true)).toMatch(/端口|类型/);
      expect(await validateWorkflowManifest({ ...valid, inputs: [{ id: 'source', kind: 'text' as const, label: 'Source', nodeId: '2', field: 'source', classType: 'CustomSink' }] }, customWorkflow, await options.objectInfo!(), true)).toMatch(/连接|输入/);
    });
  });

  it('保存配置使用非执行校验，不调用 ComfyUI 的 /prompt 或 /queue', async () => {
    const root = makeRoot();
    const options = makeOptions(root);
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/prompt') || url.includes('/queue')) {
        throw new Error(`保存校验不得调用 ComfyUI 执行接口：${url}`);
      }
      return originalFetch(input, init);
    });
    try {
      await withServer(makeApp(options), async baseUrl => {
        const imported = await fetch(`${baseUrl}/api/plugins/import`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ filename: 'demo.json', workflow: apiFixture }),
        });
        const current = (await imported.json() as { plugin: WorkflowSpec }).plugin;
        const draft = { ...current, name: '非执行校验后的配置' };

        const response = await fetch(`${baseUrl}/api/plugins/demo/configure`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ manifest: draft }),
        });
        const responseBody = await response.clone().text();
        expect(response.status, responseBody).toBe(200);
        const saved = readManifest(options.catalog.manifestDir, 'demo');
        expect(saved.status).toBe('valid');
        if (saved.status === 'valid') expect(saved.manifest.name).toBe('非执行校验后的配置');
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('configure 校验通过后保存完整配置，并按覆盖标志联动 Skill/response', async () => {
    const root = makeRoot();
    const options = makeOptions(root);
    const generateSkill = vi.fn(async (spec: WorkflowSpec) => `# LLM skill for ${spec.id}\n\n生成内容`);
    await withServer(makeApp({ ...options, generateSkill }), async baseUrl => {
      const imported = await fetch(`${baseUrl}/api/plugins/import`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'demo.json', workflow: apiFixture }),
      });
      const current = (await imported.json() as { plugin: WorkflowSpec }).plugin;
      const draft = {
        ...current,
        name: '自定义插件名',
        params: [{ id: 'steps-4', label: '步数', nodeId: '4', field: 'steps', type: 'INT' as const, default: 20, llm: true }],
      };
      const result = await fetch(`${baseUrl}/api/plugins/demo/configure`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: draft, overwriteSkill: true, overwriteResponse: true }),
      });
      expect(result.status).toBe(200);
      const body = await result.json() as { ok: boolean; plugin: WorkflowSpec };
      expect(body.ok).toBe(true);
      expect(body.plugin.name).toBe('自定义插件名');
      expect(body.plugin.params[0]).toMatchObject({ id: 'steps-4', type: 'INT' });
      const saved = readManifest(options.catalog.manifestDir, 'demo');
      expect(saved.status).toBe('valid');
      if (saved.status === 'valid') {
        expect(saved.manifest.params.map(p => p.id)).toEqual(['steps-4']);
      }
      // overwriteSkill → LLM 自定义版本落盘；overwriteResponse → 默认协议重写
      expect(fs.readFileSync(path.join(root, 'skills', 'demo', 'SKILL.md'), 'utf8')).toContain('LLM skill for demo');
      expect(fs.existsSync(path.join(root, 'skills', 'demo', 'response.json'))).toBe(true);
    });
  });

  it('configure 校验失败时 manifest、Skill 与 response 均保持原样', async () => {
    const root = makeRoot();
    const options = makeOptions(root);
    await withServer(makeApp(options), async baseUrl => {
      const imported = await fetch(`${baseUrl}/api/plugins/import`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'demo.json', workflow: apiFixture }),
      });
      const current = (await imported.json() as { plugin: WorkflowSpec }).plugin;

      const snapshot = (): string[] => (fs.readdirSync(root, { recursive: true }) as string[])
        .filter(entry => entry.endsWith('.json') || entry.endsWith('.md'))
        .sort()
        .map(entry => `${entry}:${fs.readFileSync(path.join(root, entry), 'utf8')}`);
      const before = snapshot();

      // 参数指向不存在字段 → 400 且无任何文件变化
      const badField = {
        ...current,
        params: [{ id: 'bad-4', label: 'x', nodeId: '4', field: 'nope', type: 'INT' as const, default: 1 }],
      };
      const badResponse = await fetch(`${baseUrl}/api/plugins/demo/configure`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: badField, overwriteSkill: true, overwriteResponse: true }),
      });
      expect(badResponse.status).toBe(400);
      expect(snapshot()).toEqual(before);

      // 输入结构被修改 → 结构校验拒绝
      const badStructure = { ...current, inputs: [{ ...current.inputs[0], kind: 'image' as const }] };
      const structureResponse = await fetch(`${baseUrl}/api/plugins/demo/configure`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: badStructure }),
      });
      expect(structureResponse.status).toBe(400);
      expect(snapshot()).toEqual(before);

      // manifest.id 与 URL 不一致 → 400
      const mismatch = await fetch(`${baseUrl}/api/plugins/demo/configure`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: { ...current, id: 'other' } }),
      });
      expect(mismatch.status).toBe(400);
      expect(snapshot()).toEqual(before);
    });
  });

  it('configure 不带覆盖标志时保留自定义 Skill 与回复协议', async () => {
    const root = makeRoot();
    const options = makeOptions(root);
    const generateSkill = vi.fn(async (spec: WorkflowSpec) => `# LLM for ${spec.id}`);
    await withServer(makeApp({ ...options, generateSkill }), async baseUrl => {
      const imported = await fetch(`${baseUrl}/api/plugins/import`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'demo.json', workflow: apiFixture }),
      });
      const current = (await imported.json() as { plugin: WorkflowSpec }).plugin;

      // 写入自定义 Skill 与自定义回复协议
      await fetch(`${baseUrl}/api/plugins/demo/skill`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '# 完全自定义\n\n内容' }),
      });
      const protocol = (await (await fetch(`${baseUrl}/api/plugins/demo/response`)).json() as { protocol: { blocks: Array<{ id: string; label?: string }> } }).protocol;
      const promptBlock = protocol.blocks.find(block => block.id === 'generation-prompt')!;
      promptBlock.label = '自定义标签';
      await fetch(`${baseUrl}/api/plugins/demo/response`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ protocol }),
      });

      // 确认保存但不带覆盖标志：manifest 更新，自定义文件原样保留
      const draft = { ...current, name: '新名字' };
      const result = await fetch(`${baseUrl}/api/plugins/demo/configure`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: draft }),
      });
      expect(result.status).toBe(200);
      expect(generateSkill).not.toHaveBeenCalled();
      expect(readPluginSkill('demo', path.join(root, 'skills'))).toContain('完全自定义');
      const savedProtocol = JSON.parse(fs.readFileSync(path.join(root, 'skills', 'demo', 'response.json'), 'utf8')) as { blocks: Array<{ id: string; label?: string }> };
      expect(savedProtocol.blocks.find(block => block.id === 'generation-prompt')?.label).toBe('自定义标签');
      const saved = readManifest(options.catalog.manifestDir, 'demo');
      if (saved.status === 'valid') expect(saved.manifest.name).toBe('新名字');
    });
  });
});
