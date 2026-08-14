import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { Graph } from '../types.js';
import { createNode, loadGraph } from '../graph/graph-store.js';
import { graphAtSnapshot, listSnapshots, recordSnapshot, rollback } from './snapshot-store.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'director-snap-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function g0(): Graph { return { projectName: 't', nodes: [], edges: [] }; }

describe('SnapshotStore', () => {
  it('recordSnapshot 生成连续 seq 并持久化', () => {
    const a = g0();
    const b = g0();
    createNode(b, { type: 'shot', title: 'SHOT 01' });
    const m1 = recordSnapshot(dir, a, b, { actor: 'user', reason: '创建 SHOT 01' });
    expect(m1.seq).toBe(1);
    const c = structuredClone(b);
    createNode(c, { type: 'shot', title: 'SHOT 02' });
    const m2 = recordSnapshot(dir, b, c, { actor: 'agent', reason: '创建 SHOT 02' });
    expect(m2.seq).toBe(2);
    const list = listSnapshots(dir);
    expect(list.map((m) => m.seq)).toEqual([1, 2]);
    expect(list[0]?.actor).toBe('user');
  });

  it('graphAtSnapshot 重建任意历史状态', () => {
    const a = g0();
    const b = g0();
    createNode(b, { type: 'shot', title: 'SHOT 01' });
    recordSnapshot(dir, a, b, { actor: 'user', reason: 'step1' });
    const c = structuredClone(b);
    createNode(c, { type: 'shot', title: 'SHOT 02' });
    recordSnapshot(dir, b, c, { actor: 'user', reason: 'step2' });
    const at1 = graphAtSnapshot(dir, 1);
    expect(at1.nodes).toHaveLength(1);
    expect(at1.nodes[0]?.title).toBe('SHOT 01');
    const at2 = graphAtSnapshot(dir, 2);
    expect(at2.nodes).toHaveLength(2);
  });

  it('graphAtSnapshot seq 越界抛 INVALID_PATCH', () => {
    expect(() => graphAtSnapshot(dir, 99)).toThrowError(
      expect.objectContaining({ code: 'INVALID_PATCH' }),
    );
  });

  it('rollback 回到目标状态并追加新快照', () => {
    const a = g0();
    const b = g0();
    createNode(b, { type: 'shot', title: 'SHOT 01' });
    recordSnapshot(dir, a, b, { actor: 'user', reason: 'step1' });
    const c = structuredClone(b);
    createNode(c, { type: 'shot', title: 'SHOT 02' });
    recordSnapshot(dir, b, c, { actor: 'user', reason: 'step2' });
    const g = rollback(dir, 1, 'user', '回滚测试');
    expect(g.nodes).toHaveLength(1);
    // 回滚后的当前图（project.json）也是 1 节点
    expect(loadGraph(dir).nodes).toHaveLength(1);
    // 快照追加了一条
    const list = listSnapshots(dir);
    expect(list.at(-1)?.reason).toContain('回滚至 SN-1');
  });
});
