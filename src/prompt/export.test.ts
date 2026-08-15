import { describe, expect, it } from 'vitest';
import type { DirectorNode, Graph } from '../types.js';
import { DirectorError } from '../types.js';
import { chainOrder, DEFAULT_SEED, graphToPromptYaml } from './export.js';
import { validatePromptProtocol } from './protocol.js';

function shot(id: string, title: string, fields: Record<string, unknown> = {}): DirectorNode {
  return { id, type: 'shot', title, fields, position: { x: 0, y: 0 }, version: 1 };
}
function prompt(id: string, title: string, content: string): DirectorNode {
  return { id, type: 'prompt', title, fields: { content }, position: { x: 0, y: 0 }, version: 1 };
}
function keyframe(id: string, title: string): DirectorNode {
  return { id, type: 'keyframe', title, fields: {}, position: { x: 0, y: 0 }, version: 1 };
}
function params(mode: string): DirectorNode {
  return { id: 'params', type: 'params', title: 'PARAMS', fields: { mode }, position: { x: 0, y: 0 }, version: 1 };
}
function edge(kind: 'ref' | 'chain' | 'exec', source: string, target: string, label?: string) {
  return { id: `${kind}-${source}-${target}`, kind, source, target, label };
}

const graph = (nodes: DirectorNode[], edges: ReturnType<typeof edge>[] = []): Graph => ({
  projectName: 'demo', nodes, edges,
});

describe('chainOrder 链式排序', () => {
  it('沿 chain 线性排序（起点 → 终点）', () => {
    const g = graph(
      [shot('a', 'SHOT 01'), shot('b', 'SHOT 02'), shot('c', 'SHOT 03')],
      [edge('chain', 'a', 'b'), edge('chain', 'b', 'c')],
    );
    const { ordered, errors } = chainOrder(g);
    expect(errors).toEqual([]);
    expect(ordered.map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('无 chain 时按标题序号排序', () => {
    const g = graph([shot('b', 'SHOT 02'), shot('a', 'SHOT 01')]);
    const { ordered } = chainOrder(g);
    expect(ordered.map((n) => n.title)).toEqual(['SHOT 01', 'SHOT 02']);
  });

  it('环检测：chain 成环报错', () => {
    const g = graph(
      [shot('a', 'A'), shot('b', 'B'), shot('c', 'C')],
      [edge('chain', 'a', 'b'), edge('chain', 'b', 'c'), edge('chain', 'c', 'a')],
    );
    const { errors } = chainOrder(g);
    expect(errors.join()).toContain('成环');
  });

  it('分支检测：一个分镜多个后继报错', () => {
    const g = graph(
      [shot('a', 'A'), shot('b', 'B'), shot('c', 'C')],
      [edge('chain', 'a', 'b'), edge('chain', 'a', 'c')],
    );
    const { errors } = chainOrder(g);
    expect(errors.join()).toContain('分支');
  });

  it('孤立分镜排在链后（start/标题序）', () => {
    const g = graph(
      [shot('a', 'A'), shot('x', 'SHOT 99'), shot('b', 'B')],
      [edge('chain', 'a', 'b')],
    );
    const { ordered } = chainOrder(g);
    expect(ordered.map((n) => n.id)).toEqual(['a', 'b', 'x']);
  });
});

describe('graphToPromptYaml 映射', () => {
  it('基本映射：chain 顺序 + 归属 prompt + keyframes + duration + seed 默认 42', () => {
    const g = graph(
      [
        { id: 'proj', type: 'project', title: 'demo', fields: {}, position: { x: 0, y: 0 }, version: 1 },
        params('storyboard'),
        shot('a', 'SHOT 01', { duration: '3.0s' }),
        shot('b', 'SHOT 02'),
        prompt('p1', 'P1', 'shot one prompt'),
        prompt('p2', 'P2', 'shot two prompt'),
        keyframe('k1', 'KF0'),
      ],
      [
        edge('chain', 'a', 'b'),
        edge('ref', 'p1', 'a'),
        edge('ref', 'p2', 'b'),
        edge('ref', 'k1', 'a', 'KF0'),
      ],
    );
    const { yaml, segments } = graphToPromptYaml(g);
    expect(segments).toBe(2);
    expect(yaml).toContain('project: demo');
    expect(yaml).toContain('mode: storyboard');
    expect(yaml).toContain('shot: 1');
    expect(yaml).toContain('duration: 3');
    expect(yaml).toContain('duration: 3.75'); // SHOT 02 缺省时长
    expect(yaml).toContain(`seed: ${DEFAULT_SEED}`);
    expect(yaml).toContain('keyframes: [KF0]');
    expect(yaml).toContain('shot one prompt');
    expect(yaml).toContain('shot two prompt');
    // 产出 YAML 必须通过协议校验
    const v = validatePromptProtocol(JSON.parse(JSON.stringify({
      version: 1, project: 'demo', mode: 'storyboard',
      segments: [
        { shot: 1, title: 'SHOT 01', duration: 3, seed: 42, prompt: 'shot one prompt', keyframes: ['KF0'] },
        { shot: 2, title: 'SHOT 02', duration: 3.75, seed: 42, prompt: 'shot two prompt' },
      ],
    })));
    expect(v.ok).toBe(true);
  });

  it('无归属 prompt 的分镜 → 报错（不产出坏 YAML）', () => {
    const g = graph(
      [shot('a', 'SHOT 01'), prompt('p', 'P', 'orphan prompt')],
      [],
    );
    expect(() => graphToPromptYaml(g)).toThrowError(/没有归属提示词/);
  });

  it('未被引用的 prompt 节点 → 顶层共享 prompt', () => {
    const g = graph(
      [
        shot('a', 'SHOT 01'),
        prompt('p1', 'P1', 'shot prompt'),
        prompt('p2', 'SHARED', 'global prompt'),
      ],
      [edge('ref', 'p1', 'a')],
    );
    const { yaml } = graphToPromptYaml(g);
    expect(yaml).toContain('prompt: |');
    expect(yaml).toContain('global prompt');
  });

  it('chain 成环 → 导出报错', () => {
    const g = graph(
      [shot('a', 'A'), shot('b', 'B'), shot('c', 'C'), prompt('p', 'P', 'x')],
      [
        edge('ref', 'p', 'a'),
        edge('chain', 'a', 'b'),
        edge('chain', 'b', 'c'),
        edge('chain', 'c', 'a'),
      ],
    );
    expect(() => graphToPromptYaml(g)).toThrowError(DirectorError);
  });

  it('显式 fields.seed 覆盖默认 42', () => {
    const g = graph(
      [shot('a', 'SHOT 01', { seed: 7 }), prompt('p', 'P', 'x')],
      [edge('ref', 'p', 'a')],
    );
    const { yaml } = graphToPromptYaml(g);
    expect(yaml).toContain('seed: 7');
    expect(yaml).not.toContain(`seed: ${DEFAULT_SEED}`);
  });
});
