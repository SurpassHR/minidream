import type { Actor, Graph } from '../types.js';
import { loadGraph, saveGraph } from '../graph/graph-store.js';
import { recordSnapshot } from '../snapshots/snapshot-store.js';

// 图变更订阅（WS 广播用）
type GraphListener = (graph: Graph) => void;
const listeners: GraphListener[] = [];
export function onGraphChanged(fn: GraphListener): void { listeners.push(fn); }
function broadcast(graph: Graph): void { for (const fn of listeners) fn(graph); }

// 所有写操作的唯一入口：读图 → mutate → 保存 → 快照 → 广播
export function applyMutation(
  projectDir: string,
  actor: Actor,
  reason: string,
  mutate: (graph: Graph) => void,
): Graph {
  const before = loadGraph(projectDir);
  const after = structuredClone(before);
  mutate(after);
  saveGraph(projectDir, after);
  recordSnapshot(projectDir, before, after, { actor, reason });
  broadcast(after);
  return after;
}
