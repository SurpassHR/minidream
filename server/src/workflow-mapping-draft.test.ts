import { describe, expect, it } from 'vitest';
import { setNodeBypass, validateWorkflowDraft, workflowInterfaceParams } from '../../web/src/components/workflowMappingDraft.js';
import type { WorkflowManifest } from '../../web/src/api.js';

describe('workflow interface summary', () => {
  it('keeps only visible LLM-facing parameters', () => {
    const manifest = {
      id: 'demo',
      name: 'Demo',
      source: { type: 'imported', workflowFile: 'workflows/demo.json' },
      inputs: [],
      params: [
        { id: 'steps-1', label: 'Steps', nodeId: '1', field: 'steps', type: 'INT', default: 20, llm: true },
        { id: 'cfg-1', label: 'CFG', nodeId: '1', field: 'cfg', type: 'FLOAT', default: 7, llm: false },
        { id: 'hidden-1', label: 'Hidden', nodeId: '1', field: 'hidden', type: 'STRING', default: 'x', llm: true, hidden: true },
        { id: 'bypass-1', label: 'Bypass', nodeId: '1', field: '', type: 'BOOLEAN', default: false, bypass: true },
      ],
      outputs: [],
    } satisfies WorkflowManifest;

    expect(workflowInterfaceParams(manifest).map(item => item.id)).toEqual(['steps-1']);
  });

  it('bypass 参数允许 field 为空，而普通参数仍要求字段', () => {
    const manifest = {
      id: 'demo',
      name: 'Demo',
      source: { type: 'imported', workflowFile: 'workflows/demo.json' },
      inputs: [],
      params: [{ id: 'bypass-17', label: 'Bypass', nodeId: '17', field: '', type: 'BOOLEAN', default: true, bypass: true }],
      outputs: [{ id: 'images-1', kind: 'image', label: 'Image', nodeId: '1', classType: 'SaveImage' }],
    } satisfies WorkflowManifest;
    expect(validateWorkflowDraft(manifest)).toBeNull();
    expect(validateWorkflowDraft({
      ...manifest,
      params: [{ ...manifest.params[0]!, id: 'steps-17', field: '', bypass: false, type: 'INT' }],
    })).toEqual({ code: 'fieldRequired', group: 'params', id: 'steps-17' });
  });

  it('切换节点 bypass 只更新内部开关，不把 bypass 暴露为接口参数', () => {
    const manifest = {
      id: 'demo',
      name: 'Demo',
      source: { type: 'imported', workflowFile: 'workflows/demo.json' },
      inputs: [],
      params: [{ id: 'steps-1', label: 'Steps', nodeId: '1', field: 'steps', type: 'INT', default: 20, llm: true }],
      outputs: [],
    } satisfies WorkflowManifest;

    const bypassed = setNodeBypass(manifest, '1', true);
    expect(bypassed.params.find(item => item.bypass && item.nodeId === '1')).toMatchObject({ default: true, field: '' });
    expect(workflowInterfaceParams(bypassed).map(item => item.id)).toEqual(['steps-1']);

    const restored = setNodeBypass(bypassed, '1', false);
    expect(restored.params.find(item => item.bypass && item.nodeId === '1')?.default).toBe(false);
  });
});
