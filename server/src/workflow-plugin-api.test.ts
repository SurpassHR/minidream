import express, { type Express } from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkflowPluginRouter, type WorkflowPluginApiOptions } from './workflow-plugin-api.js';
import type { WorkflowSpec } from './workflow.js';
import { readManifest, readWorkflowJson } from './workflow-plugin-store.js';
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
      const body = await response.json() as { plugin: { id: string; hasManifest: boolean } };
      expect(body.plugin).toMatchObject({ id: 'demo', hasManifest: true });
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
      expect(readPluginSkill('demo', options.skillsDir!)).toMatch(/^---\nname: demo/);

      const current = (await (await fetch(`${baseUrl}/api/plugins`)).json() as WorkflowSpec[]).find(p => p.id === 'demo')!;
      const edited = { ...current, params: [{ id: 'steps-4', label: 'Steps', nodeId: '4', field: 'steps', type: 'INT', default: 20, llm: true }] };
      const saved = await fetch(`${baseUrl}/api/plugins/demo`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(edited),
      });
      expect(saved.status).toBe(200);
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
});
