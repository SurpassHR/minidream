import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deleteImportedWorkflow,
  deleteManifest,
  listManifests,
  readManifest,
  writeManifest,
  writeWorkflowJson,
  type WorkflowManifestRecord,
} from './workflow-plugin-store.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-plugin-store-'));
  roots.push(root);
  return root;
}

function makeManifest(id: string): WorkflowManifestRecord {
  return {
    id,
    name: 'Demo workflow',
    description: 'A workflow for tests',
    source: { type: 'imported', workflowFile: 'workflows/demo.json' },
    inputs: [],
    params: [],
    outputs: [{ id: 'images-9', kind: 'image', label: 'Output', nodeId: '9', classType: 'SaveImage' }],
  };
}

describe('workflow plugin manifest store', () => {
  it('以原子方式写入并读取完整 manifest', () => {
    const root = makeRoot();
    const record = makeManifest('demo');

    writeManifest(root, record);

    expect(readManifest(root, 'demo')).toEqual({ status: 'valid', manifest: record });
    expect(fs.existsSync(path.join(root, 'demo.json.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'demo.json'))).toBe(true);
  });

  it('区分不存在清单与损坏清单', () => {
    const root = makeRoot();

    expect(readManifest(root, 'missing')).toEqual({ status: 'missing' });
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'broken.json'), '{', 'utf8');

    expect(readManifest(root, 'broken')).toMatchObject({ status: 'invalid' });
  });

  it('只列出合法 manifest，并拒绝路径穿越 ID', () => {
    const root = makeRoot();
    writeManifest(root, makeManifest('valid_plugin'));
    fs.writeFileSync(path.join(root, 'invalid!.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(root, 'UPPER.json'), '{}', 'utf8');

    expect(listManifests(root)).toEqual(['valid_plugin']);
    expect(() => readManifest(root, '../outside')).toThrow(/非法工作流插件 ID/);
    expect(() => writeManifest(root, makeManifest('../outside'))).toThrow(/非法工作流插件 ID/);
  });

  it('删除清单和导入工作流时不影响其他插件', () => {
    const root = makeRoot();
    const workflowsRoot = path.join(root, 'workflows');
    writeManifest(root, makeManifest('keep'));
    writeManifest(root, makeManifest('remove'));
    writeWorkflowJson(root, 'keep', { '1': { class_type: 'SaveImage', inputs: {} } });
    writeWorkflowJson(root, 'remove', { '2': { class_type: 'SaveImage', inputs: {} } });

    deleteManifest(root, 'remove');
    deleteImportedWorkflow(root, 'remove');

    expect(readManifest(root, 'remove')).toEqual({ status: 'missing' });
    expect(fs.existsSync(path.join(workflowsRoot, 'remove.json'))).toBe(false);
    expect(readManifest(root, 'keep').status).toBe('valid');
    expect(fs.existsSync(path.join(workflowsRoot, 'keep.json'))).toBe(true);
  });
});
