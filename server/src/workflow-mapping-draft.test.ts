import { describe, expect, it } from 'vitest';
import { workflowInterfaceParams } from '../../web/src/components/workflowMappingDraft';
import type { WorkflowManifest } from '../../web/src/api';

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
});
