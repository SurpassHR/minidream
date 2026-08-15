import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { DirectorError, type Graph } from '../types.js';
import {
  createNode, deleteNode, updateNode, moveNode,
  createEdge, updateEdge, deleteEdge, loadGraph, saveGraph,
} from './graph-store.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'director-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function emptyGraph(): Graph {
  return { projectName: 'test', nodes: [], edges: [] };
}

describe('GraphStore 节点 CRUD', () => {
  it('createNode 生成 UUID 与 version=1', () => {
    const g = emptyGraph();
    const n = createNode(g, { type: 'shot', title: 'SHOT 01' });
    expect(n.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(n.version).toBe(1);
    expect(g.nodes).toHaveLength(1);
  });

  it('updateNode 合并 fields 且 version 递增', () => {
    const g = emptyGraph();
    const n = createNode(g, { type: 'shot', title: 'SHOT 01', fields: { duration: 3.75 } });
    const u = updateNode(g, n.id, { fields: { camera: 'wide' }, title: 'SHOT 01 v2' });
    expect(u.fields.duration).toBe(3.75);
    expect(u.fields.camera).toBe('wide');
    expect(u.title).toBe('SHOT 01 v2');
    expect(u.version).toBe(2);
  });

  it('updateNode 节点不存在抛 NODE_NOT_FOUND', () => {
    expect(() => updateNode(emptyGraph(), 'missing', {})).toThrowError(
      expect.objectContaining({ code: 'NODE_NOT_FOUND' }),
    );
  });

  it('moveNode 更新坐标且 version 递增', () => {
    const g = emptyGraph();
    const n = createNode(g, { type: 'shot', title: 'S' });
    const m = moveNode(g, n.id, { x: 10, y: 20 });
    expect(m.position).toEqual({ x: 10, y: 20 });
    expect(m.version).toBe(2);
  });

  it('deleteNode 连带删除相关边', () => {
    const g = emptyGraph();
    const a = createNode(g, { type: 'shot', title: 'A' });
    const b = createNode(g, { type: 'shot', title: 'B' });
    createEdge(g, { kind: 'ref', source: a.id, target: b.id });
    deleteNode(g, a.id);
    expect(g.nodes).toHaveLength(1);
    expect(g.edges).toHaveLength(0);
  });
});

describe('GraphStore 边 CRUD', () => {
  it('createEdge 校验两端节点存在', () => {
    const g = emptyGraph();
    expect(() => createEdge(g, { kind: 'ref', source: 'x', target: 'y' }))
      .toThrowError(expect.objectContaining({ code: 'NODE_NOT_FOUND' }));
  });

  it('重复边抛 EDGE_EXISTS', () => {
    const g = emptyGraph();
    const a = createNode(g, { type: 'shot', title: 'A' });
    const b = createNode(g, { type: 'shot', title: 'B' });
    createEdge(g, { kind: 'ref', source: a.id, target: b.id });
    expect(() => createEdge(g, { kind: 'ref', source: a.id, target: b.id }))
      .toThrowError(expect.objectContaining({ code: 'EDGE_EXISTS' }));
  });

  it('deleteEdge 不存在抛 EDGE_NOT_FOUND', () => {
    expect(() => deleteEdge(emptyGraph(), 'missing')).toThrowError(
      expect.objectContaining({ code: 'EDGE_NOT_FOUND' }),
    );
  });
});

describe('GraphStore 持久化', () => {
  it('loadGraph 目录不存在项目文件时返回空图', () => {
    const g = loadGraph(dir);
    // 契约：空图 projectName = 项目目录 basename
    expect(g.projectName).toBe(basename(dir));
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
  });

  it('saveGraph 写 .director/project.json 且 loadGraph 可读回', () => {
    const g = emptyGraph();
    createNode(g, { type: 'shot', title: 'SHOT 01' });
    saveGraph(dir, g);
    const p = join(dir, '.director', 'project.json');
    expect(readFileSync(p, 'utf8')).toContain('SHOT 01');
    const loaded = loadGraph(dir);
    expect(loaded.nodes).toHaveLength(1);
    expect(loaded.nodes[0]?.title).toBe('SHOT 01');
  });
});

describe('createEdge chain 线性约束', () => {
  function shots(...titles: string[]): { g: Graph; ids: string[] } {
    const g = emptyGraph();
    const ids = titles.map((t) => createNode(g, { type: 'shot', title: t }).id);
    return { g, ids };
  }

  it('chain 允许 shot→shot；非 shot 端点拒绝', () => {
    const g = emptyGraph();
    const s = createNode(g, { type: 'shot', title: 'S' });
    const p = createNode(g, { type: 'prompt', title: 'P' });
    expect(() => createEdge(g, { kind: 'chain', source: s.id, target: p.id }))
      .toThrowError(expect.objectContaining({ code: 'EDGE_INVALID' }));
  });

  it('一个分镜至多一个入链/出链（分支拒绝）', () => {
    const { g, ids } = shots('A', 'B', 'C');
    createEdge(g, { kind: 'chain', source: ids[0]!, target: ids[1]! });
    expect(() => createEdge(g, { kind: 'chain', source: ids[0]!, target: ids[2]! }))
      .toThrowError(expect.objectContaining({ code: 'EDGE_INVALID' }));
    expect(() => createEdge(g, { kind: 'chain', source: ids[2]!, target: ids[1]! }))
      .toThrowError(expect.objectContaining({ code: 'EDGE_INVALID' }));
  });

  it('chain 成环拒绝', () => {
    const { g, ids } = shots('A', 'B', 'C');
    createEdge(g, { kind: 'chain', source: ids[0]!, target: ids[1]! });
    createEdge(g, { kind: 'chain', source: ids[1]!, target: ids[2]! });
    expect(() => createEdge(g, { kind: 'chain', source: ids[2]!, target: ids[0]! }))
      .toThrowError(expect.objectContaining({ code: 'EDGE_INVALID' }));
  });

  it('ref/exec 不受 chain 约束', () => {
    const g = emptyGraph();
    const s = createNode(g, { type: 'shot', title: 'S' });
    const p = createNode(g, { type: 'prompt', title: 'P' });
    const e = createEdge(g, { kind: 'ref', source: p.id, target: s.id });
    expect(e.kind).toBe('ref');
  });
});

describe('updateEdge 类型修改', () => {
  it('ref 改为 chain 时校验线性约束（分支拒绝）', () => {
    const g = emptyGraph();
    const a = createNode(g, { type: 'shot', title: 'A' });
    const b = createNode(g, { type: 'shot', title: 'B' });
    const c = createNode(g, { type: 'shot', title: 'C' });
    createEdge(g, { kind: 'chain', source: a.id, target: b.id });
    const e2 = createEdge(g, { kind: 'ref', source: a.id, target: c.id });
    // a 已有出链 → ref 改 chain 必须拒绝
    expect(() => updateEdge(g, e2.id, { kind: 'chain' }))
      .toThrowError(expect.objectContaining({ code: 'EDGE_INVALID' }));
    // 改 label 不受限
    const e3 = updateEdge(g, e2.id, { label: '备注' });
    expect(e3.label).toBe('备注');
    expect(e3.kind).toBe('ref');
  });

  it('ref 改为 chain 合法场景（线性延伸）', () => {
    const g = emptyGraph();
    const a = createNode(g, { type: 'shot', title: 'A' });
    const b = createNode(g, { type: 'shot', title: 'B' });
    createEdge(g, { kind: 'chain', source: a.id, target: b.id });
    const c = createNode(g, { type: 'shot', title: 'C' });
    const e = createEdge(g, { kind: 'ref', source: b.id, target: c.id });
    const u = updateEdge(g, e.id, { kind: 'chain' });
    expect(u.kind).toBe('chain');
  });
});
