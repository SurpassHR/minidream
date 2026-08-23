import { describe, expect, it } from 'vitest';
import { serializeWorkflowForLlm } from './workflow-plugin-api.js';
import type { WorkflowSpec } from './workflow.js';

describe('workflow LLM contract', () => {
  it('暴露 description 与参数，同时过滤 hidden 和底层映射字段', () => {
    const spec: WorkflowSpec = {
      id: 'demo',
      name: 'Demo',
      description: '用于测试的工作流',
      inputs: [
        { id: 'prompt', kind: 'text', label: '提示词', description: '描述主体', nodeId: '1', field: 'text', classType: 'CLIPTextEncode' },
        { id: 'internal', kind: 'text', label: '内部提示', description: '不可见', nodeId: '2', field: 'text', classType: 'Text', hidden: true },
      ],
      params: [{ id: 'steps', label: '步数', description: '控制细节和耗时', nodeId: '3', field: 'steps', type: 'INT', default: 20 }],
      outputs: [{ id: 'image', kind: 'image', label: '图片', description: '最终结果', nodeId: '4', classType: 'SaveImage' }],
    };

    const result = serializeWorkflowForLlm(spec);
    expect(result).toMatchObject({ description: '用于测试的工作流' });
    expect(result.inputs).toEqual([expect.objectContaining({ id: 'prompt', description: '描述主体' })]);
    expect(result.params).toEqual([expect.objectContaining({ id: 'steps', description: '控制细节和耗时', default: 20 })]);
    expect(result.outputs).toEqual([expect.objectContaining({ id: 'image', description: '最终结果' })]);
    expect(JSON.stringify(result)).not.toContain('nodeId');
    expect(JSON.stringify(result)).not.toContain('field');
    expect(JSON.stringify(result)).not.toContain('内部提示');
  });
});
