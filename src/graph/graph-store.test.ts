import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { DirectorError, type Graph } from '../types.js';
import {
  createNode, deleteNode, updateNode, moveNode,
  createEdge, deleteEdge, loadGraph, saveGraph,
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
