import { describe, expect, it } from 'vitest';
import { filterHistoryOutputs, pruneDeadNodes } from './workflow.js';

describe('arbitrary workflow manual mappings', () => {
  it('按 manifest 声明的输出节点保留未知输出类及其依赖链', () => {
    const api = {
      '1': { class_type: 'CustomPromptNode', inputs: { text: 'prompt' } },
      '2': { class_type: 'CustomOutputNode', inputs: { source: ['1', 0] } },
    };
    const kept = pruneDeadNodes(api, ['2']);
    expect(Object.keys(kept)).toEqual(['1', '2']);
    expect(Object.keys(filterHistoryOutputs({ outputs: [{ id: 'custom-2', kind: 'text', label: '结果', nodeId: '2', classType: 'CustomOutputNode' }] } as any, {
      '2': { text: ['done'] },
      '3': { text: ['internal'] },
    }))).toEqual(['2']);
  });
});
