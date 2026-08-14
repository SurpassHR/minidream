import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
// 注意：fast-json-patch 在 Node ESM 下仅有 default 导出（CJS module.exports），
// named/namespace 导入在 tsx/node 运行时不可用；vitest 的 CJS interop 会掩盖此差异
import jsonpatch from 'fast-json-patch';
import { DirectorError, type Actor, type Graph, type SnapshotMeta } from '../types.js';
import { loadGraph, saveGraph } from '../graph/graph-store.js';

const DIR = '.director/snapshots';

interface SnapshotFile extends SnapshotMeta {
  patch: jsonpatch.Operation[];
}

function snapDir(projectDir: string): string {
  return join(projectDir, DIR);
}

function snapPath(projectDir: string, seq: number): string {
  return join(snapDir(projectDir), `snapshot-${seq}.json`);
}

function basePath(projectDir: string): string {
  return join(snapDir(projectDir), 'base.json');
}

export function recordSnapshot(
  projectDir: string,
  before: Graph,
  after: Graph,
  meta: { actor: Actor; reason: string },
): SnapshotMeta {
  mkdirSync(snapDir(projectDir), { recursive: true });
  if (!existsSync(basePath(projectDir))) {
    writeFileSync(basePath(projectDir), JSON.stringify(before), 'utf8');
  }
  const seq = listSnapshots(projectDir).length + 1;
  const snap: SnapshotFile = {
    seq,
    ts: Date.now(),
    actor: meta.actor,
    reason: meta.reason,
    patch: jsonpatch.compare(before, after, true) as jsonpatch.Operation[],
  };
  writeFileSync(snapPath(projectDir, seq), JSON.stringify(snap, null, 2), 'utf8');
  return { seq: snap.seq, ts: snap.ts, actor: snap.actor, reason: snap.reason };
}

export function listSnapshots(projectDir: string): SnapshotMeta[] {
  const dir = snapDir(projectDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^snapshot-\d+\.json$/.test(f))
    .map((f) => {
      const s = JSON.parse(readFileSync(join(dir, f), 'utf8')) as SnapshotFile;
      return { seq: s.seq, ts: s.ts, actor: s.actor, reason: s.reason };
    })
    .sort((a, b) => a.seq - b.seq);
}

export function graphAtSnapshot(projectDir: string, seq: number): Graph {
  const snaps = listSnapshots(projectDir);
  if (seq < 1 || seq > snaps.length) {
    throw new DirectorError('INVALID_PATCH', `快照序号越界: ${seq}`);
  }
  const base = JSON.parse(readFileSync(basePath(projectDir), 'utf8')) as Graph;
  let graph = structuredClone(base);
  for (const m of snaps) {
    if (m.seq > seq) break;
    const s = JSON.parse(readFileSync(snapPath(projectDir, m.seq), 'utf8')) as SnapshotFile;
    if (s.patch.length > 0) {
      // fast-json-patch: mutate=false 时不修改原文档，重建须取返回值 newDocument
      graph = jsonpatch.applyPatch(graph, s.patch, false, false).newDocument;
    }
  }
  return graph;
}

export function rollback(projectDir: string, seq: number, actor: Actor, reason: string): Graph {
  const target = graphAtSnapshot(projectDir, seq);
  const current = loadGraph(projectDir);
  recordSnapshot(projectDir, current, target, { actor, reason: `回滚至 SN-${seq}: ${reason}` });
  saveGraph(projectDir, target);
  return target;
}
