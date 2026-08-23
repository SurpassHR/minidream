import { describe, expect, it } from 'vitest';
import { buildWorkflowGraph, createParamFromGraphField } from './workflow-graph.js';
import { validateParamMappings } from './workflow-plugin-api.js';

// 3 个 KSamplerAdvanced：steps/cfg 是共享采样参数（applyTo 指向其他采样节点），
// add_noise 是重复出现的普通字段（不生成 applyTo）。
const multiSamplerWorkflow = {
  '478': {
    class_type: 'KSamplerAdvanced',
    inputs: { add_noise: 'enable', steps: 12, cfg: 1, sampler_name: 'er_sde', scheduler: 'simple' },
  },
  '542': {
    class_type: 'KSamplerAdvanced',
    inputs: { add_noise: 'enable', steps: 12, cfg: 1, sampler_name: 'dpmpp_sde', scheduler: 'simple' },
  },
  '545': {
    class_type: 'KSamplerAdvanced',
    inputs: { add_noise: 'enable', steps: 12, cfg: 1, sampler_name: 'er_sde', scheduler: 'simple' },
  },
  '531': { class_type: 'RandomNoise', inputs: { noise_seed: 42 } },
};

describe('validateParamMappings applyTo 契约', () => {
  it('共享采样字段按工作流结构生成 applyTo，普通重复字段不生成', () => {
    const graph = buildWorkflowGraph(multiSamplerWorkflow, {});
    const steps = graph.nodes.find(n => n.nodeId === '478')!.fields.find(f => f.field === 'steps')!;
    const addNoise = graph.nodes.find(n => n.nodeId === '478')!.fields.find(f => f.field === 'add_noise')!;

    expect(steps.applyTo?.sort()).toEqual(['542', '545']);
    expect(addNoise.applyTo).toBeUndefined();
  });

  it('勾选普通重复字段后保存校验通过（不再误报 applyTo 结构不符）', () => {
    const graph = buildWorkflowGraph(multiSamplerWorkflow, {});
    const manifest = {
      id: 'multi',
      name: 'multi',
      inputs: [] as never[],
      outputs: [] as never[],
      params: [
        createParamFromGraphField(graph.nodes.find(n => n.nodeId === '478')!.fields.find(f => f.field === 'add_noise')!),
        createParamFromGraphField(graph.nodes.find(n => n.nodeId === '478')!.fields.find(f => f.field === 'steps')!),
      ],
    };
    expect(validateParamMappings(manifest, graph)).toBeNull();
  });

  it('共享字段 applyTo 被篡改时仍拒绝', () => {
    const graph = buildWorkflowGraph(multiSamplerWorkflow, {});
    const field = graph.nodes.find(n => n.nodeId === '478')!.fields.find(f => f.field === 'steps')!;
    const param = createParamFromGraphField(field);
    param.applyTo = ['999'];
    const manifest = { id: 'multi', name: 'multi', inputs: [] as never[], outputs: [] as never[], params: [param] };
    expect(validateParamMappings(manifest, graph)).toMatch(/applyTo/);
  });
});
