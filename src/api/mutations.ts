import type { Actor, Graph } from '../types.js';
import { loadGraph, saveGraph } from '../graph/graph-store.js';
import { recordSnapshot, switchHead } from '../snapshots/snapshot-store.js';

// 图变更订阅（WS 广播用）
type GraphListener = (graph: Graph) => void;
const listeners: GraphListener[] = [];
export function onGraphChanged(fn: GraphListener): void { listeners.push(fn); }
function broadcast(graph: Graph): void { for (const fn of listeners) fn(graph); }

// 所有写操作的唯一入口：读图 → mutate → 快照 → 保存 → 广播。
// 注意顺序：先 recordSnapshot（可能抛 SNAPSHOT_FUTURE_EXISTS——覆盖未来快照需确认），
// 被拒时 project.json 保持不变（不会出现“图已改但快照没记”的不一致）
export function applyMutation(
  projectDir: string,
  actor: Actor,
  reason: string,
  mutate: (graph: Graph) => void,
): Graph {
  const before = loadGraph(projectDir);
  const after = structuredClone(before);
  mutate(after);
  recordSnapshot(projectDir, before, after, { actor, reason });
  saveGraph(projectDir, after);
  broadcast(after);
  return after;
}

// 切换 HEAD（回滚 / 撤销 / 重做）：把 project.json 重置为目标快照状态并更新 HEAD，
// 不追加新快照（回滚 = 直接回到该快照）；WS 广播与 applyMutation 同通道
export function applyHeadSwitch(projectDir: string, seq: number): Graph {
  const graph = switchHead(projectDir, seq);
  broadcast(graph);
  return graph;
}
