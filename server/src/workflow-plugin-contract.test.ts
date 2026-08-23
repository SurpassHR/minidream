import { describe, expect, it } from 'vitest';
import { serializeWorkflowForLlm, summarizeWorkflowsForLlm } from './workflow-plugin-api.js';
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
      params: [
        { id: 'steps', label: '步数', description: '控制细节和耗时', nodeId: '3', field: 'steps', type: 'INT', default: 20 },
        // 仅在节点视图固定值的 combo：不暴露给 LLM，但保留 default 供运行时注入
        { id: 'sampler_name-5', label: '采样器', nodeId: '5', field: 'sampler_name', type: 'combo', default: 'euler', options: ['euler', 'karras'], llm: false },
      ],
      outputs: [{ id: 'image', kind: 'image', label: '图片', description: '最终结果', nodeId: '4', classType: 'SaveImage' }],
    };

    const result = serializeWorkflowForLlm(spec);
    expect(result).toMatchObject({ description: '用于测试的工作流' });
    expect(result.inputs).toEqual([expect.objectContaining({ id: 'prompt', description: '描述主体' })]);
    expect(result.params).toEqual([expect.objectContaining({ id: 'steps', description: '控制细节和耗时', default: 20 })]);
    expect(result.params.some((param: any) => param.id === 'sampler_name-5')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('sampler_name-5');
    expect(result.outputs).toEqual([expect.objectContaining({ id: 'image', description: '最终结果' })]);
    expect(JSON.stringify(result)).not.toContain('nodeId');
    expect(JSON.stringify(result)).not.toContain('field');
    expect(JSON.stringify(result)).not.toContain('内部提示');
  });

  it('workflow.list 摘要保持简洁：保留 description，过滤默认值/范围/底层映射字段', () => {
    const spec: WorkflowSpec = {
      id: 'demo',
      name: 'Demo',
      description: '用于测试的工作流',
      inputs: [
        { id: 'prompt', kind: 'text', label: '提示词', description: '描述主体', nodeId: '1', field: 'text', classType: 'CLIPTextEncode', defaultValue: '默认提示' },
        { id: 'internal', kind: 'text', label: '内部提示', nodeId: '2', field: 'text', classType: 'Text', hidden: true },
      ],
      params: [
        { id: 'steps', label: '步数', description: '控制细节和耗时', nodeId: '3', field: 'steps', type: 'INT', default: 20, min: 1, max: 150, options: [] },
        // llm:false 的固定参数不进入摘要
        { id: 'sampler_name-5', label: '采样器', nodeId: '5', field: 'sampler_name', type: 'combo', default: 'euler', options: ['euler', 'karras'], llm: false },
      ],
      outputs: [{ id: 'image', kind: 'image', label: '图片', description: '最终结果', nodeId: '4', classType: 'SaveImage' }],
    };

    const summary = summarizeWorkflowsForLlm([spec])[0]!;
    expect(summary).toMatchObject({
      id: 'demo',
      name: 'Demo',
      description: '用于测试的工作流',
    });
    expect(summary.inputs).toEqual([{ kind: 'text', label: '提示词', description: '描述主体' }]);
    expect(summary.outputs).toEqual([{ kind: 'image', label: '图片', description: '最终结果' }]);
    expect(summary.params).toEqual([{ id: 'steps', label: '步数', type: 'INT', description: '控制细节和耗时' }]);
    expect(JSON.stringify(summary)).not.toContain('default');
    expect(JSON.stringify(summary)).not.toContain('min');
    expect(JSON.stringify(summary)).not.toContain('options');
    expect(JSON.stringify(summary)).not.toContain('nodeId');
    expect(JSON.stringify(summary)).not.toContain('field');
    expect(JSON.stringify(summary)).not.toContain('默认提示');
    expect(JSON.stringify(summary)).not.toContain('sampler_name-5');
  });
});
