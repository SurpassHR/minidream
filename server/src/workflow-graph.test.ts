import { describe, expect, it } from 'vitest';
import { buildWorkflowGraph, createParamFromGraphField } from './workflow-graph.js';

const apiWorkflow = {
  '1': { class_type: 'LoadImage', inputs: { image: 'input.png' }, _meta: { title: '参考图' } },
  '2': { class_type: 'KSampler', inputs: { model: ['3', 0], steps: 20, cfg: 7, denoise: 1 }, _meta: { title: '采样' } },
  '3': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
  '4': { class_type: 'SaveImage', inputs: { images: ['2', 0] }, _meta: { title: '输出' } },
};

const objectInfo = {
  KSampler: {
    input: {
      required: {
        model: ['MODEL'],
        steps: ['INT', { default: 20, min: 1, max: 150, step: 1 }],
        cfg: ['FLOAT', { default: 7, min: 0, max: 30, step: 0.1 }],
        denoise: ['FLOAT', { default: 1, min: 0, max: 1, step: 0.01 }],
      },
    },
  },
};

describe('workflow graph', () => {
  it('builds nodes and edges and only exposes unconnected widget fields', () => {
    const graph = buildWorkflowGraph(apiWorkflow, objectInfo);

    expect(graph.nodes).toHaveLength(4);
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceNode: '3', targetNode: '2', targetField: 'model' }),
      expect.objectContaining({ sourceNode: '2', targetNode: '4', targetField: 'images' }),
    ]));

    const sampler = graph.nodes.find(node => node.nodeId === '2')!;
    expect(sampler.fields.find(field => field.field === 'model')).toMatchObject({ connected: true, selectable: false });
    expect(sampler.fields.find(field => field.field === 'steps')).toMatchObject({
      connected: false,
      selectable: true,
      type: 'INT',
      value: 20,
      min: 1,
      max: 150,
      step: 1,
    });
  });

  it('restores selected state from the manifest', () => {
    const graph = buildWorkflowGraph(apiWorkflow, objectInfo, {
      params: [{ id: 'steps-2', label: '步数', nodeId: '2', field: 'steps', type: 'INT', default: 20 }],
    });
    const field = graph.nodes.find(node => node.nodeId === '2')!.fields.find(item => item.field === 'steps')!;
    const cfg = graph.nodes.find(node => node.nodeId === '2')!.fields.find(item => item.field === 'cfg')!;

    expect(field).toMatchObject({ selected: true, paramId: 'steps-2' });
    expect(cfg.selected).toBe(false);
  });

  it('uses UI positions and keeps API fallback layout deterministic', () => {
    const uiWorkflow = {
      nodes: [
        { id: 10, type: 'KSampler', pos: [300, 120], widgets_values: [20, 7, 1], inputs: [] },
        { id: 11, type: 'SaveImage', pos: [700, 120], widgets_values: [], inputs: [{ name: 'images', link: 1 }] },
      ],
      links: [[1, 10, 0, 11, 0, 'IMAGE']],
    };
    const uiGraph = buildWorkflowGraph(uiWorkflow, objectInfo);
    expect(uiGraph.nodes.find(node => node.nodeId === '10')).toMatchObject({ x: 300, y: 120 });

    const first = buildWorkflowGraph(apiWorkflow, objectInfo);
    const second = buildWorkflowGraph(apiWorkflow, objectInfo);
    expect(first.nodes.map(node => [node.nodeId, node.x, node.y])).toEqual(second.nodes.map(node => [node.nodeId, node.x, node.y]));
  });

  it('creates a fresh parameter from a selectable field', () => {
    const graph = buildWorkflowGraph(apiWorkflow, objectInfo);
    const field = graph.nodes.find(node => node.nodeId === '2')!.fields.find(item => item.field === 'cfg')!;
    expect(createParamFromGraphField(field)).toMatchObject({
      id: 'cfg-2',
      nodeId: '2',
      field: 'cfg',
      type: 'FLOAT',
      default: 7,
      min: 0,
      max: 30,
      step: 0.1,
      description: '',
    });
  });

  it('carries shared widget targets into a newly selected parameter', () => {
    const workflow = {
      '2': { class_type: 'KSampler', inputs: { steps: 20, cfg: 7 } },
      '5': { class_type: 'KSampler', inputs: { steps: 20, cfg: 7 } },
    };
    const graph = buildWorkflowGraph(workflow, objectInfo);
    const field = graph.nodes.find(node => node.nodeId === '2')!.fields.find(item => item.field === 'cfg')!;
    expect(createParamFromGraphField(field).applyTo).toEqual(['5']);
  });

  it('exposes Power Lora Loader as a selectable multi-combo widget', () => {
    const workflow = {
      '7': {
        class_type: 'Power Lora Loader (rgthree)',
        inputs: {
          lora_1: { on: true, lora: 'style.safetensors', strength: 0.7 },
          lora_2: { on: false, lora: 'detail.safetensors', strength: 1 },
        },
      },
    };
    const graph = buildWorkflowGraph(workflow, {
      LoraLoader: { input: { required: { lora_name: [['style.safetensors', 'detail.safetensors'], {}] } } },
    });
    const field = graph.nodes[0]!.fields.find(item => item.field === 'lora');
    expect(field).toMatchObject({ type: 'COMBO', selectable: true, multiple: true, strengthable: true, options: ['style.safetensors', 'detail.safetensors'] });
    expect(createParamFromGraphField(field!)).toMatchObject({ id: 'lora-7', multiple: true, strengthable: true, default: [{ name: 'style.safetensors', strength: 0.7 }] });
  });
});
