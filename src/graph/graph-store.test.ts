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

  it('createEdge 透传 targetHandle（分镜多接口圆点）', () => {
    const g = emptyGraph();
    const a = createNode(g, { type: 'prompt', title: 'P' });
    const b = createNode(g, { type: 'shot', title: 'SHOT 01' });
    const e = createEdge(g, { kind: 'ref', source: a.id, target: b.id, targetHandle: 'text-0' });
    expect(e.targetHandle).toBe('text-0');
    // 同一源连同一分镜同组不同圆点 = 不同边（不判重）
    const kf = createNode(g, { type: 'keyframe', title: 'KF' });
    const e2 = createEdge(g, { kind: 'ref', source: kf.id, target: b.id, targetHandle: 'image-0' });
    expect(e2.targetHandle).toBe('image-0');
    const e3 = createEdge(g, { kind: 'ref', source: kf.id, target: b.id, targetHandle: 'image-1' });
    expect(e3.targetHandle).toBe('image-1');
    expect(g.edges).toHaveLength(3);
    // 同一源连同一分镜同一接口圆点仍判重
    expect(() => createEdge(g, { kind: 'ref', source: a.id, target: b.id, targetHandle: 'text-0' }))
      .toThrowError(expect.objectContaining({ code: 'EDGE_EXISTS' }));
  });

  it('createEdge 未传 targetHandle 时边不带该字段（向后兼容）', () => {
    const g = emptyGraph();
    const a = createNode(g, { type: 'prompt', title: 'P' });
    const b = createNode(g, { type: 'shot', title: 'SHOT 01' });
    const e = createEdge(g, { kind: 'ref', source: a.id, target: b.id });
    expect(e.targetHandle).toBeUndefined();
  });

  it('接口圆点类型校验：文字/图像/视频源只能连对应接口', () => {
    const g = emptyGraph();
    const prompt = createNode(g, { type: 'prompt', title: 'P' });
    const kf = createNode(g, { type: 'keyframe', title: 'KF' });
    const vid = createNode(g, { type: 'asset', title: 'V', fields: { assetKind: 'vid' } });
    const shot = createNode(g, { type: 'shot', title: 'SHOT 01' });
    // 合法组合
    expect(createEdge(g, { kind: 'ref', source: prompt.id, target: shot.id, targetHandle: 'text-0' }).targetHandle).toBe('text-0');
    expect(createEdge(g, { kind: 'ref', source: kf.id, target: shot.id, targetHandle: 'image-0' }).targetHandle).toBe('image-0');
    expect(createEdge(g, { kind: 'ref', source: vid.id, target: shot.id, targetHandle: 'video-0' }).targetHandle).toBe('video-0');
    // 非法组合：文字节点不能连图像接口（反向亦然）
    expect(() => createEdge(g, { kind: 'ref', source: prompt.id, target: shot.id, targetHandle: 'image-1' }))
      .toThrowError(expect.objectContaining({ code: 'EDGE_INVALID' }));
    expect(() => createEdge(g, { kind: 'ref', source: kf.id, target: shot.id, targetHandle: 'text-1' }))
      .toThrowError(expect.objectContaining({ code: 'EDGE_INVALID' }));
    expect(() => createEdge(g, { kind: 'ref', source: vid.id, target: shot.id, targetHandle: 'text-1' }))
      .toThrowError(expect.objectContaining({ code: 'EDGE_INVALID' }));
    // 非 shot 目标不受接口校验影响
    const gen = createNode(g, { type: 'generation', title: 'G' });
    expect(createEdge(g, { kind: 'exec', source: prompt.id, target: gen.id, targetHandle: 'whatever-0' })).toBeTruthy();
  });

  it('chain 边只能连剧情接口（chain-N），连素材接口被拒', () => {
    const g = emptyGraph();
    const a = createNode(g, { type: 'shot', title: 'A' });
    const b = createNode(g, { type: 'shot', title: 'B' });
    const c = createNode(g, { type: 'shot', title: 'C' });
    const d = createNode(g, { type: 'shot', title: 'D' });
    expect(createEdge(g, { kind: 'chain', source: a.id, target: b.id, targetHandle: 'chain-0' }).targetHandle).toBe('chain-0');
    // 独立分镜对：chain 连素材接口（text-0）被类型校验拒绝
    expect(() => createEdge(g, { kind: 'chain', source: c.id, target: d.id, targetHandle: 'text-0' }))
      .toThrowError(expect.objectContaining({ code: 'EDGE_INVALID' }));
  });

  it('replaceEdgeId 为乐观 id（后端不存在）时按同源 chain 边匹配并原子替换', () => {
    const g = emptyGraph();
    const a = createNode(g, { type: 'shot', title: 'A' });
    const b = createNode(g, { type: 'shot', title: 'B' });
    const c = createNode(g, { type: 'shot', title: 'C' });
    createEdge(g, { kind: 'chain', source: a.id, target: b.id, targetHandle: 'chain-0' });
    // replaceEdgeId 是前端乐观边 id（pending-xxx，后端不存在）：按同源 chain 出边匹配
    const e = createEdge(g, {
      kind: 'chain', source: a.id, target: c.id, targetHandle: 'chain-0', replaceEdgeId: 'pending-xxx',
    });
    expect(e.target).toBe(c.id);
    // 旧边被原子替换删除：只剩 A→C
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]?.target).toBe(c.id);
  });

  it('chain 重连替换：replaceEdgeId 排除旧边（移动 SHOT1→SHOT2 到 SHOT3）', () => {
    const g = emptyGraph();
    const a = createNode(g, { type: 'shot', title: 'A' });
    const b = createNode(g, { type: 'shot', title: 'B' });
    const c = createNode(g, { type: 'shot', title: 'C' });
    const old = createEdge(g, { kind: 'chain', source: a.id, target: b.id, targetHandle: 'chain-0' });
    // 不带 replaceEdgeId：SHOT1 已有出链 → 拒绝
    expect(() => createEdge(g, { kind: 'chain', source: a.id, target: c.id, targetHandle: 'chain-0' }))
      .toThrowError(expect.objectContaining({ code: 'EDGE_INVALID' }));
    // 带 replaceEdgeId：排除旧边后 A 无出链 → 通过（重连语义）
    const e = createEdge(g, {
      kind: 'chain', source: a.id, target: c.id, targetHandle: 'chain-0', replaceEdgeId: old.id,
    });
    expect(e.target).toBe(c.id);
    // 目标已有入链仍拒绝（即使排除旧边）
    const d = createNode(g, { type: 'shot', title: 'D' });
    createEdge(g, { kind: 'chain', source: c.id, target: d.id, targetHandle: 'chain-0' });
    expect(() => createEdge(g, {
      kind: 'chain', source: b.id, target: d.id, targetHandle: 'chain-0', replaceEdgeId: old.id,
    })).toThrowError(expect.objectContaining({ code: 'EDGE_INVALID' }));
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
