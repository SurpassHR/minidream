import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { Graph } from '../types.js';
import { createNode, loadGraph, saveGraph } from '../graph/graph-store.js';
import {
  graphAtSnapshot, listSnapshots, recordSnapshot, switchHead, headSeq,
  futureSnapshotCount, approveOverwrite, trimSnapshots, MAX_SNAPSHOTS,
} from './snapshot-store.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'director-snap-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function g0(): Graph { return { projectName: 't', nodes: [], edges: [] }; }

// 快速生成 N 个快照：每次加一个节点
function pushSnap(g: Graph, title: string): Graph {
  const next = structuredClone(g);
  createNode(next, { type: 'shot', title });
  recordSnapshot(dir, g, next, { actor: 'user', reason: `创建 ${title}` });
  return next;
}

describe('SnapshotStore 基础', () => {
  it('recordSnapshot 生成连续 seq 并持久化', () => {
    const a = g0();
    let b = g0();
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
    // HEAD 跟随最新快照
    expect(headSeq(dir)).toBe(2);
  });

  it('graphAtSnapshot 重建任意历史状态', () => {
    const a = g0();
    let g = pushSnap(a, 'SHOT 01');
    g = pushSnap(g, 'SHOT 02');
    expect(graphAtSnapshot(dir, 1).nodes).toHaveLength(1);
    expect(graphAtSnapshot(dir, 1).nodes[0]?.title).toBe('SHOT 01');
    expect(graphAtSnapshot(dir, 2).nodes).toHaveLength(2);
  });

  it('graphAtSnapshot seq 不存在抛 INVALID_PATCH', () => {
    expect(() => graphAtSnapshot(dir, 99)).toThrowError(
      expect.objectContaining({ code: 'INVALID_PATCH' }),
    );
  });
});

describe('SnapshotStore HEAD 与回滚', () => {
  it('switchHead 重置图为目标状态、更新 HEAD、不追加新快照', () => {
    const a = g0();
    let g = pushSnap(a, 'SHOT 01');
    g = pushSnap(g, 'SHOT 02');
    expect(listSnapshots(dir)).toHaveLength(2);

    const back = switchHead(dir, 1);
    expect(back.nodes).toHaveLength(1);
    expect(loadGraph(dir).nodes).toHaveLength(1);
    expect(headSeq(dir)).toBe(1);
    // 未来快照保留（灰色），可前进
    expect(futureSnapshotCount(dir)).toBe(1);
    expect(listSnapshots(dir)).toHaveLength(2);
    // 快照文件未被删除
    expect(graphAtSnapshot(dir, 2).nodes).toHaveLength(2);
  });

  it('覆盖模型：回滚后新操作默认拒绝（SNAPSHOT_FUTURE_EXISTS），批准后覆盖并删除未来快照', () => {
    const a = g0();
    let g = pushSnap(a, 'SHOT 01');
    g = pushSnap(g, 'SHOT 02');
    switchHead(dir, 1);

    // 未批准 → 拒绝（applyMutation 语义：快照被拒时 project.json 不被写入）
    const cur = loadGraph(dir);
    const next = structuredClone(cur);
    createNode(next, { type: 'shot', title: 'SHOT 03' });
    expect(() => recordSnapshot(dir, cur, next, { actor: 'user', reason: '创建 SHOT 03' }))
      .toThrowError(expect.objectContaining({ code: 'SNAPSHOT_FUTURE_EXISTS' }));

    // 批准 → 覆盖 seq2（原未来快照），删除更后的未来快照，HEAD 前进
    approveOverwrite();
    const m = recordSnapshot(dir, cur, next, { actor: 'user', reason: '创建 SHOT 03' });
    expect(m.seq).toBe(2);
    expect(listSnapshots(dir).map((s) => s.seq)).toEqual([1, 2]);
    expect(listSnapshots(dir)[1]?.reason).toBe('创建 SHOT 03');
    expect(headSeq(dir)).toBe(2);
    expect(futureSnapshotCount(dir)).toBe(0);
    // project.json 由 applyMutation 写入（此处模拟）
    saveGraph(dir, next);
    expect(loadGraph(dir).nodes.map((n) => n.title)).toEqual(['SHOT 01', 'SHOT 03']);
  });

  it('一次性批准：覆盖后灰色清空；再次回滚后未批准仍被拒', () => {
    const a = g0();
    let g = pushSnap(a, 'SHOT 01');
    g = pushSnap(g, 'SHOT 02');
    g = pushSnap(g, 'SHOT 03');
    switchHead(dir, 1);
    approveOverwrite();
    let cur = loadGraph(dir);
    let next = structuredClone(cur);
    createNode(next, { type: 'shot', title: 'S4' });
    recordSnapshot(dir, cur, next, { actor: 'user', reason: 's4' });
    // 覆盖后未来快照已被清空 → head == maxSeq → 正常追加（无灰色）
    expect(futureSnapshotCount(dir)).toBe(0);
    cur = loadGraph(dir);
    next = structuredClone(cur);
    createNode(next, { type: 'shot', title: 'S5' });
    expect(recordSnapshot(dir, cur, next, { actor: 'user', reason: 's5' }).seq).toBe(3);
    // 再次回滚后未批准 → 拒绝
    switchHead(dir, 1);
    cur = loadGraph(dir);
    next = structuredClone(cur);
    createNode(next, { type: 'shot', title: 'S6' });
    expect(() => recordSnapshot(dir, cur, next, { actor: 'user', reason: 's6' }))
      .toThrowError(expect.objectContaining({ code: 'SNAPSHOT_FUTURE_EXISTS' }));
  });

  it('未来快照可 redo（switchHead 前进）', () => {
    const a = g0();
    let g = pushSnap(a, 'SHOT 01');
    g = pushSnap(g, 'SHOT 02');
    switchHead(dir, 1);
    const fwd = switchHead(dir, 2);
    expect(fwd.nodes).toHaveLength(2);
    expect(headSeq(dir)).toBe(2);
    expect(futureSnapshotCount(dir)).toBe(0);
  });
});

describe('SnapshotStore 300 上限', () => {
  it('超过 MAX_SNAPSHOTS 时 trim 到上限且历史重建仍正确', () => {
    const a = g0();
    let g = a;
    for (let i = 1; i <= MAX_SNAPSHOTS + 10; i++) {
      g = pushSnap(g, `SHOT ${String(i).padStart(3, '0')}`);
    }
    expect(listSnapshots(dir)).toHaveLength(MAX_SNAPSHOTS);
    // 最旧的 10 个被合并进 base（其节点保留在 base 中）：任意历史点仍可重建
    const at = graphAtSnapshot(dir, MAX_SNAPSHOTS - 5);
    expect(at.nodes).toHaveLength(MAX_SNAPSHOTS - 5);
    expect(at.nodes[0]?.title).toBe('SHOT 001');
    // 最新快照 seq 保留原编号（seq 不因删除而重排）
    expect(listSnapshots(dir).at(-1)?.seq).toBe(MAX_SNAPSHOTS + 10);
    expect(headSeq(dir)).toBe(MAX_SNAPSHOTS + 10);
  });

  it('HEAD 修正（防御）：HEAD 指向已被 trim 删除的快照时落到剩余最旧', () => {
    const a = g0();
    let g = a;
    for (let i = 1; i <= MAX_SNAPSHOTS + 5; i++) {
      g = pushSnap(g, `SHOT ${String(i).padStart(3, '0')}`);
    }
    expect(listSnapshots(dir)).toHaveLength(MAX_SNAPSHOTS);
    expect(listSnapshots(dir)[0]?.seq).toBe(6); // seq 1..5 已被 trim
    // 模拟 HEAD 指向已删除的快照（极端时序）
    writeFileSync(join(dir, '.director', 'snapshots', 'head.json'), JSON.stringify({ seq: 1 }), 'utf8');
    trimSnapshots(dir);
    expect(headSeq(dir)).toBe(6);
    expect(graphAtSnapshot(dir, headSeq(dir)).nodes).toHaveLength(6);
  });

  it('trimSnapshots 无多余快照时不动', () => {
    const a = g0();
    pushSnap(a, 'SHOT 01');
    trimSnapshots(dir);
    expect(listSnapshots(dir)).toHaveLength(1);
  });
});
