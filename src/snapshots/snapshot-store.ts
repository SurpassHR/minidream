import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
// 注意：fast-json-patch 在 Node ESM 下仅有 default 导出（CJS module.exports），
// named/namespace 导入在 tsx/node 运行时不可用；vitest 的 CJS interop 会掩盖此差异
import jsonpatch from 'fast-json-patch';
import { DirectorError, type Actor, type Graph, type SnapshotMeta } from '../types.js';
import { loadGraph, saveGraph } from '../graph/graph-store.js';

const DIR = '.director/snapshots';
// 自动快照上限：只保留最近 300 次操作，超出时把最旧快照的 patch 合并进 base 后删除
export const MAX_SNAPSHOTS = 300;

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

function headPath(projectDir: string): string {
  return join(snapDir(projectDir), 'head.json');
}

// —— HEAD：当前图对应的快照序号 ——
// 正常情况 HEAD = 最新快照；回滚/撤销后 HEAD 指向历史快照，
// 之后的快照为“未来分支”（前端灰色显示），新操作会覆盖它们（需确认）

export function headSeq(projectDir: string): number {
  const p = headPath(projectDir);
  if (!existsSync(p)) {
    // 兼容存量项目（无 head.json）：HEAD = 最新快照
    const snaps = listSnapshots(projectDir);
    return snaps.at(-1)?.seq ?? 0;
  }
  return (JSON.parse(readFileSync(p, 'utf8')) as { seq: number }).seq;
}

function writeHead(projectDir: string, seq: number): void {
  mkdirSync(snapDir(projectDir), { recursive: true });
  writeFileSync(headPath(projectDir), JSON.stringify({ seq }), 'utf8');
}

// 未来（灰色）快照数量：HEAD 之后还有多少快照
export function futureSnapshotCount(projectDir: string): number {
  const head = headSeq(projectDir);
  return listSnapshots(projectDir).filter((s) => s.seq > head).length;
}

// 切换 HEAD（回滚/撤销/重做）：把 project.json 重置为目标快照状态并更新 HEAD。
// 不追加新快照（“直接回到该快照”），未来快照保留等待覆盖或重做
export function switchHead(projectDir: string, seq: number): Graph {
  const target = graphAtSnapshot(projectDir, seq);
  saveGraph(projectDir, target);
  writeHead(projectDir, seq);
  return target;
}

// —— 覆盖未来快照的一次性批准 ——
// 回滚到历史点后执行新操作会覆盖未来（灰色）快照：recordSnapshot 默认拒绝，
// 前端确认后调用 approveOverwrite() 批准下一次写操作覆盖。
// 30s 过期：确认流程中断（前端确认后未重放/测试泄漏）时标志不残留，
// 避免后续写操作被静默放行
const OVERWRITE_APPROVE_TTL_MS = 30_000;
let overwriteApproved = false;
let overwriteApprovedAt = 0;
export function approveOverwrite(): void {
  overwriteApproved = true;
  overwriteApprovedAt = Date.now();
}

function isOverwriteApproved(): boolean {
  if (!overwriteApproved) return false;
  if (Date.now() - overwriteApprovedAt > OVERWRITE_APPROVE_TTL_MS) {
    overwriteApproved = false;
    return false;
  }
  return true;
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
  const snaps = listSnapshots(projectDir);
  const head = headSeq(projectDir);
  const maxSeq = snaps.at(-1)?.seq ?? 0;
  let seq: number;
  if (head < maxSeq) {
    // 存在未来（灰色）快照：覆盖它们（seq = head+1，删除 head+2..maxSeq）
    if (!isOverwriteApproved()) {
      throw new DirectorError('SNAPSHOT_FUTURE_EXISTS',
        `将覆盖 ${maxSeq - head} 个未来快照，请确认`);
    }
    overwriteApproved = false;
    seq = head + 1;
    for (const s of snaps) {
      if (s.seq > seq) unlinkSync(snapPath(projectDir, s.seq));
    }
  } else {
    seq = maxSeq + 1;
  }
  const snap: SnapshotFile = {
    seq,
    ts: Date.now(),
    actor: meta.actor,
    reason: meta.reason,
    patch: jsonpatch.compare(before, after, true) as jsonpatch.Operation[],
  };
  writeFileSync(snapPath(projectDir, seq), JSON.stringify(snap, null, 2), 'utf8');
  writeHead(projectDir, seq);
  trimSnapshots(projectDir);
  return { seq: snap.seq, ts: snap.ts, actor: snap.actor, reason: snap.reason };
}

// 快照上限：超过 MAX_SNAPSHOTS 时，把最旧快照的 patch 合并进 base（保证后续
// 快照仍可重建图），再删除最旧快照文件；HEAD 若落在被删范围则修正到剩余最旧
// （HEAD 修正无条件执行：防御极端时序下 HEAD 指向已删快照）
export function trimSnapshots(projectDir: string): void {
  const snaps = listSnapshots(projectDir);
  const excess = snaps.length - MAX_SNAPSHOTS;
  if (excess > 0) {
    const base = JSON.parse(readFileSync(basePath(projectDir), 'utf8')) as Graph;
    let graph = structuredClone(base);
    for (let i = 0; i < excess; i++) {
      const s = JSON.parse(readFileSync(snapPath(projectDir, snaps[i].seq), 'utf8')) as SnapshotFile;
      if (s.patch.length > 0) {
        graph = jsonpatch.applyPatch(graph, s.patch, false, false).newDocument;
      }
      unlinkSync(snapPath(projectDir, snaps[i].seq));
    }
    writeFileSync(basePath(projectDir), JSON.stringify(graph), 'utf8');
  }
  const remaining = listSnapshots(projectDir);
  const minSeq = remaining[0]?.seq ?? 0;
  const head = headSeq(projectDir);
  if (head < minSeq) writeHead(projectDir, minSeq);
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
  if (!snaps.some((s) => s.seq === seq)) {
    throw new DirectorError('INVALID_PATCH', `快照序号不存在: ${seq}`);
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
