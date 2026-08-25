import { describe, expect, it } from 'vitest';
import { applyPluginSuggestions, buildPluginAnalysis, parsePluginSuggestions, serializeAnalysisForLlm } from './plugin-creator.js';
import type { WorkflowSpec } from './workflow.js';
import type { WorkflowGraph } from './workflow-graph.js';

const spec: WorkflowSpec = {
  id: 'demo', name: 'Demo', description: 'demo workflow',
  inputs: [{ id: 'text-1', kind: 'text', label: '提示词', nodeId: '1', field: 'text', classType: 'CLIPTextEncode' }],
  params: [
    { id: 'steps-2', label: '步数', nodeId: '2', field: 'steps', type: 'INT', default: 20, llm: true },
    { id: 'sampler_name-2', label: '采样器', nodeId: '2', field: 'sampler_name', type: 'combo', default: 'euler', llm: false },
    { id: 'seed-3', label: '种子', nodeId: '3', field: 'seed', type: 'SEED', default: 1, hidden: true },
  ],
  outputs: [{ id: 'images-4', kind: 'image', label: '图片', nodeId: '4', classType: 'SaveImage' }],
};

const graph: WorkflowGraph = {
  nodes: [{ nodeId: '2', classType: 'KSampler', title: 'Sampler', x: 0, y: 0, fields: [
    { nodeId: '2', field: 'steps', type: 'INT', value: 20, connected: false, selectable: true, selected: true },
    { nodeId: '2', field: 'sampler_name', type: 'COMBO', value: 'euler', connected: false, selectable: true, selected: false },
    { nodeId: '2', field: 'model', type: 'MODEL', connected: true, selectable: false, selected: false },
  ]}],
  edges: [],
};

describe('buildPluginAnalysis', () => {
  it('builds immutable input/output and widget recommendations', () => {
    const result = buildPluginAnalysis({ spec, graph, format: 'ui' });
    expect(result.workflow).toMatchObject({ format: 'ui', nodeCount: 1 });
    expect(result.purpose).toMatchObject({ name: 'Demo', description: 'demo workflow' });
    expect(result.inputs[0]).toMatchObject({ confidence: 0.9, recommended: true });
    expect(result.outputs[0]).toMatchObject({ confidence: 0.95, recommended: true });
    expect(result.widgets).toEqual(expect.arrayContaining([
      expect.objectContaining({ exposure: 'llm', field: expect.objectContaining({ field: 'steps' }) }),
      expect.objectContaining({ exposure: 'fixed', field: expect.objectContaining({ field: 'sampler_name' }) }),
    ]));
    expect(result.widgets).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ field: expect.objectContaining({ field: 'model' }) }),
    ]));
    expect(result.response.recommendedPromptVisibility).toBe(true);
  });

  it('does not mutate the graph or spec', () => {
    const beforeSpec = JSON.stringify(spec);
    const beforeGraph = JSON.stringify(graph);
    buildPluginAnalysis({ spec, graph });
    expect(JSON.stringify(spec)).toBe(beforeSpec);
    expect(JSON.stringify(graph)).toBe(beforeGraph);
  });

  it('produces a stable fingerprint for equivalent input', () => {
    const one = buildPluginAnalysis({ spec, graph });
    const two = buildPluginAnalysis({ spec: { ...spec }, graph: { ...graph } });
    expect(one.workflow.sourceFingerprint).toBe(two.workflow.sourceFingerprint);
  });

  it('为标量连线字段生成候选并追溯上游源头', () => {
    const linkedGraph: WorkflowGraph = {
      nodes: [
        { nodeId: '10', classType: 'MiniMaxH3ImageToVideo', title: 'H3 I2V', x: 0, y: 0, fields: [
          { nodeId: '10', field: 'width', type: 'INT', connected: true, selectable: false, selected: false },
        ] },
        { nodeId: '11', classType: 'UnifiedResizeImageMask', title: 'Resize', x: 0, y: 0, fields: [
          { nodeId: '11', field: 'image', type: 'IMAGE', connected: true, selectable: false, selected: false },
          { nodeId: '11', field: 'long_side_target', type: 'INT', value: 1152, connected: false, selectable: true, selected: true },
        ] },
      ],
      edges: [{ sourceNode: '11', sourceField: 'image', targetNode: '10', targetField: 'width' }],
    };
    // 多级链条（width ← Resize ← LoadImage）也继续向上追溯，但源头按近远排序
    linkedGraph.nodes.push({ nodeId: '12', classType: 'LoadImage', title: 'Load', x: 0, y: 0, fields: [
      { nodeId: '12', field: 'image', type: 'IMAGE', connected: true, selectable: false, selected: false },
      { nodeId: '12', field: 'upload', type: 'COMBO', value: 'a.png', connected: false, selectable: true, selected: false },
    ] });
    linkedGraph.edges.push({ sourceNode: '12', sourceField: 'image', targetNode: '11', targetField: 'image' });
    const result = buildPluginAnalysis({ spec, graph: linkedGraph });
    const width = result.widgets.find(item => item.field.field === 'width');
    expect(width).toBeDefined();
    expect(width!.exposure).toBe('review');
    expect(width!.sources).toEqual([
      expect.objectContaining({ nodeId: '11', fields: ['long_side_target'] }),
      expect.objectContaining({ nodeId: '12', fields: ['upload'] }),
    ]);
    expect(width!.reason).toContain('long_side_target');
    // 非标量连线（IMAGE/MODEL）不生成候选
    expect(result.widgets.find(item => item.field.type === 'IMAGE')).toBeUndefined();
    // 序列化包含源头提示，供 LLM 映射
    const facts = serializeAnalysisForLlm(result);
    expect(facts).toContain('"sources"');
  });
});

describe('parsePluginSuggestions', () => {
  it('解析裸 JSON、围栏 JSON 与前后杂讯', () => {
    const raw = { purpose: { name: 'X' } };
    expect(parsePluginSuggestions(JSON.stringify(raw))).toMatchObject({ purpose: { name: 'X' } });
    expect(parsePluginSuggestions('```json\n' + JSON.stringify(raw) + '\n```')).toMatchObject({ purpose: { name: 'X' } });
    expect(parsePluginSuggestions('分析结果如下：\n' + JSON.stringify(raw) + '\n完毕')).toMatchObject({ purpose: { name: 'X' } });
  });

  it('非 JSON 输出抛错', () => {
    expect(() => parsePluginSuggestions('这不是 JSON')).toThrow();
  });
});

describe('applyPluginSuggestions', () => {
  it('合并合法建议并丢弃非法引用', () => {
    const base = buildPluginAnalysis({ spec, graph });
    const { analysis, warnings } = applyPluginSuggestions(base, {
      purpose: { description: '采样与出图' },
      inputs: {
        'text-1': { description: '正向提示词', recommended: true },
        'ghost-input': { description: '不存在' },
      },
      widgets: [
        { nodeId: '2', field: 'steps', exposure: 'llm', reason: '常用参数' },
        { nodeId: '2', field: 'model', exposure: 'llm', reason: '连接字段不可暴露' },
        { nodeId: '9', field: 'nope', exposure: 'llm' },
        { nodeId: '2', field: 'sampler_name', exposure: 'bogus' as any },
      ],
      response: {
        blocks: [
          { source: 'result.image', timing: 'complete', format: 'plain' },
          { source: 'tool.path', timing: 'always', format: 'code' },
        ],
      },
    });
    expect(analysis.purpose.description).toBe('采样与出图');
    const byId = Object.fromEntries(analysis.inputs.map(item => [item.candidate.id, item]));
    expect(byId['text-1']?.candidate.description).toBe('正向提示词');
    const widgetByKey = Object.fromEntries(analysis.widgets.map(item => [`${item.field.nodeId}.${item.field.field}`, item]));
    expect(widgetByKey['2.steps']).toMatchObject({ exposure: 'llm', reason: '常用参数' });
    expect(widgetByKey['2.sampler_name']?.exposure).toBe('fixed'); // 非法曝光被丢弃，保持原值
    expect(warnings.join('\n')).toContain('ghost-input');
    expect(warnings.join('\n')).toContain('2.model');
    expect(warnings.join('\n')).toContain('9.nope');
    expect(warnings.join('\n')).toContain('tool.path');
    expect(analysis.response.blocks).toEqual([{ source: 'result.image', timing: 'complete', format: 'plain' }]);
  });

  it('拒绝把连线字段标为 llm，保持其 review 状态', () => {
    const linkedGraph: WorkflowGraph = {
      nodes: [{ nodeId: '10', classType: 'X', title: 'X', x: 0, y: 0, fields: [
        { nodeId: '10', field: 'width', type: 'INT', connected: true, selectable: false, selected: false },
      ] }],
      edges: [],
    };
    const base = buildPluginAnalysis({ spec, graph: linkedGraph });
    const { analysis, warnings } = applyPluginSuggestions(base, {
      widgets: [{ nodeId: '10', field: 'width', exposure: 'llm' }],
    });
    const width = analysis.widgets.find(item => item.field.field === 'width');
    expect(width?.exposure).toBe('review');
    expect(warnings.join('\n')).toContain('连线字段');
  });

  it('不修改基础分析对象', () => {
    const base = buildPluginAnalysis({ spec, graph });
    const before = JSON.stringify(base);
    applyPluginSuggestions(base, { purpose: { name: '新名字' }, widgets: [{ nodeId: '2', field: 'steps', exposure: 'hidden' }] });
    expect(JSON.stringify(base)).toBe(before);
  });

  it('serializeAnalysisForLlm 不含原始实现细节', () => {
    const facts = serializeAnalysisForLlm(buildPluginAnalysis({ spec, graph }));
    expect(facts).toContain('"steps"');
    expect(facts).not.toContain('"edges"');
  });
});
