import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildCatalogSpecs,
  getCatalogWorkflowJson,
  listCatalogSources,
  mergeRedetectedSpec,
  type WorkflowCatalogOptions,
} from './workflow-catalog.js';
import { writeManifest, writeWorkflowJson, type WorkflowManifestRecord } from './workflow-plugin-store.js';
import type { WorkflowSpec } from './workflow.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixtureSpec(id: string, description?: string): WorkflowSpec {
  return {
    id,
    name: id,
    description,
    inputs: [{ id: 'text-1', kind: 'text', label: 'Prompt', nodeId: '1', field: 'text', classType: 'CLIPTextEncode' }],
    params: [{ id: 'steps-2', label: 'Steps', nodeId: '2', field: 'steps', type: 'INT', default: 20 }],
    outputs: [{ id: 'images-3', kind: 'image', label: 'Image', nodeId: '3', classType: 'SaveImage' }],
  };
}

function makeOptions(root: string): WorkflowCatalogOptions {
  const bundledDir = path.join(root, 'bundled');
  const dataDir = path.join(root, 'data');
  const importedDir = path.join(dataDir, 'workflows');
  const manifestDir = dataDir;
  fs.mkdirSync(bundledDir, { recursive: true });
  fs.writeFileSync(path.join(bundledDir, 'bundled_demo.json'), JSON.stringify({ bundled: true }), 'utf8');
  writeWorkflowJson(dataDir, 'imported_demo', { imported: true });
  const introspect = async (json: Record<string, any>): Promise<WorkflowSpec> => {
    const id = json.bundled ? 'bundled_demo' : 'imported_demo';
    return fixtureSpec(id);
  };
  return { bundledDir, importedDir, manifestDir, introspect };
}

function manifest(id: string, source: WorkflowManifestRecord['source'], description: string): WorkflowManifestRecord {
  return { ...fixtureSpec(id, description), source };
}

describe('workflow catalog', () => {
  it('发现 bundled 与 imported 源，并返回 imported 原始 JSON', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-catalog-'));
    roots.push(root);
    const options = makeOptions(root);

    expect(listCatalogSources(options).map(item => item.id)).toEqual(['bundled_demo', 'imported_demo']);
    expect(getCatalogWorkflowJson(options, 'imported_demo')).toEqual({ imported: true });
  });

  it('无 manifest 自动识别，有 manifest 时使用完整清单', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-catalog-'));
    roots.push(root);
    const options = makeOptions(root);
    const before = await buildCatalogSpecs(options);
    expect(before.find(spec => spec.id === 'bundled_demo')).toMatchObject({ hasManifest: false, editable: true });

    writeManifest(options.manifestDir, manifest('bundled_demo', { type: 'bundled', workflowFile: 'bundled_demo.json' }, '手工用途'));
    const after = await buildCatalogSpecs(options);
    expect(after.find(spec => spec.id === 'bundled_demo')).toMatchObject({ description: '手工用途', hasManifest: true });
  });

  it('valid manifest 的参数/输入从源 JSON 补充节点标题（不影响用户契约）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-catalog-'));
    roots.push(root);
    const options = makeOptions(root);
    // 源 JSON 带节点标题（API 格式 _meta.title）
    fs.writeFileSync(
      path.join(options.bundledDir, 'bundled_demo.json'),
      JSON.stringify({
        '582': { class_type: 'PrimitiveInt', inputs: { value: 1024 }, _meta: { title: 'Width' } },
        '583': { class_type: 'PrimitiveInt', inputs: { value: 1024 }, _meta: { title: 'Height' } },
      }),
      'utf8',
    );
    const m = manifest('bundled_demo', { type: 'bundled', workflowFile: 'bundled_demo.json' }, '手工用途');
    m.params = [
      { id: 'value-582', label: 'value', nodeId: '582', field: 'value', type: 'INT' as const, default: 1024, llm: true },
      { id: 'value-583', label: 'value', nodeId: '583', field: 'value', type: 'INT' as const, default: 1024, llm: true },
    ];
    writeManifest(options.manifestDir, m);

    const spec = (await buildCatalogSpecs(options)).find(item => item.id === 'bundled_demo')!;
    expect(spec.params.find(p => p.id === 'value-582')?.nodeTitle).toBe('Width');
    expect(spec.params.find(p => p.id === 'value-583')?.nodeTitle).toBe('Height');
  });

  it('bundled 清单损坏时回退自动识别，imported 清单损坏时不进入执行 spec', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-catalog-'));
    roots.push(root);
    const options = makeOptions(root);
    fs.writeFileSync(path.join(options.manifestDir, 'bundled_demo.json'), '{', 'utf8');
    fs.writeFileSync(path.join(options.manifestDir, 'imported_demo.json'), '{', 'utf8');

    const specs = await buildCatalogSpecs(options);
    expect(specs.map(spec => spec.id)).toEqual(['bundled_demo']);
    expect(specs[0]?.manifestError).toMatch(/manifest JSON 无效/);
  });

  it('重识别保留匹配映射的手动描述、标签和隐藏状态，并保持映射数量', () => {
    const previous = fixtureSpec('demo');
    previous.inputs[0]!.description = '手写描述';
    previous.inputs[0]!.label = '自定义提示词';
    previous.inputs[0]!.hidden = true;
    const detected = fixtureSpec('demo');
    detected.inputs.push({ id: 'image-4', kind: 'image', label: 'Image', nodeId: '4', field: 'image', classType: 'LoadImage' });

    const merged = mergeRedetectedSpec(previous, detected);
    expect(merged.inputs[0]).toMatchObject({ description: '手写描述', label: '自定义提示词', hidden: true });
    expect(merged.inputs).toHaveLength(2);
    expect(merged.inputs.some(input => input.nodeId === '4' && input.hidden)).toBe(true);
    expect(previous.inputs).toHaveLength(1);
  });
});
