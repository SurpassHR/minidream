import { describe, expect, it } from 'vitest';
import { buildWorkflowGraph } from './workflow-graph.js';

const objectInfo = {
  KSampler: { input: { required: { steps: ['INT', { default: 20 }] } } },
  SaveImage: { input: { required: { images: ['IMAGE', {}] } } },
};

describe('workflow graph readable layout', () => {
  it('leaves a visible gap between connected nodes in API fallback layout', () => {
    const graph = buildWorkflowGraph({
      '1': { class_type: 'KSampler', inputs: { steps: 20 } },
      '2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
    }, objectInfo);
    const source = graph.nodes.find(node => node.nodeId === '1')!;
    const target = graph.nodes.find(node => node.nodeId === '2')!;

    expect(target.x - source.x).toBeGreaterThanOrEqual(440);
  });

  it('spreads UI nodes that were exported too close together', () => {
    const graph = buildWorkflowGraph({
      nodes: [
        { id: 1, type: 'KSampler', pos: [0, 0], widgets_values: [20], inputs: [] },
        { id: 2, type: 'SaveImage', pos: [300, 0], widgets_values: [], inputs: [{ name: 'images', link: 1 }] },
      ],
      links: [[1, 1, 0, 2, 0, 'IMAGE']],
    }, objectInfo);
    const source = graph.nodes.find(node => node.nodeId === '1')!;
    const target = graph.nodes.find(node => node.nodeId === '2')!;

    expect(target.x - source.x).toBeGreaterThanOrEqual(440);
  });
});
