import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import {
  DirectorError, type DirectorEdge, type DirectorNode,
  type EdgeKind, type Graph, type NodeType,
} from '../types.js';

// —— 纯内存操作（不落盘） ——

export function createNode(
  graph: Graph,
  input: { type: NodeType; title: string; fields?: Record<string, unknown>; position?: { x: number; y: number } },
): DirectorNode {
  const node: DirectorNode = {
    id: randomUUID(),
    type: input.type,
    title: input.title,
    fields: input.fields ?? {},
    position: input.position ?? { x: 0, y: 0 },
    version: 1,
  };
  graph.nodes.push(node);
  return node;
}

function findNode(graph: Graph, nodeId: string): DirectorNode {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) throw new DirectorError('NODE_NOT_FOUND', `节点不存在: ${nodeId}`);
  return node;
}

export function updateNode(graph: Graph, nodeId: string, patch: Record<string, unknown>): DirectorNode {
  const node = findNode(graph, nodeId);
  if (patch.title !== undefined) node.title = String(patch.title);
  if (patch.fields !== undefined) node.fields = { ...node.fields, ...(patch.fields as Record<string, unknown>) };
  node.version += 1;
  return node;
}

export function moveNode(graph: Graph, nodeId: string, position: { x: number; y: number }): DirectorNode {
  const node = findNode(graph, nodeId);
  node.position = { ...position };
  node.version += 1;
  return node;
}

export function deleteNode(graph: Graph, nodeId: string): void {
  findNode(graph, nodeId); // 不存在即抛错
  graph.nodes = graph.nodes.filter((n) => n.id !== nodeId);
  graph.edges = graph.edges.filter((e) => e.source !== nodeId && e.target !== nodeId);
}

export function createEdge(
  graph: Graph,
  input: { kind: EdgeKind; source: string; target: string; label?: string },
): DirectorEdge {
  findNode(graph, input.source);
  findNode(graph, input.target);
  const dup = graph.edges.find(
    (e) => e.kind === input.kind && e.source === input.source && e.target === input.target,
  );
  if (dup) throw new DirectorError('EDGE_EXISTS', `边已存在: ${input.source} -> ${input.target}`);
  // chain（链式参考）强制线性：只允许 shot→shot；每节点至多一个入/出 chain；全局无环。
  // （剧情顺序 = chain 拓扑序，分支/环会让 YAML segments 顺序不确定）
  if (input.kind === 'chain') {
    validateChainEdge(graph, graph.edges, input.source, input.target);
  }
  const edge: DirectorEdge = {
    id: randomUUID(),
    kind: input.kind,
    source: input.source,
    target: input.target,
    label: input.label,
  };
  graph.edges.push(edge);
  return edge;
}

// 修改边：kind/label；改为 chain 时按“除自身外的现有 chain 边”重新校验线性约束
// （改类型可能引入分支/环，必须拒绝）
export function updateEdge(
  graph: Graph,
  edgeId: string,
  patch: { kind?: EdgeKind; label?: string },
): DirectorEdge {
  const edge = graph.edges.find((e) => e.id === edgeId);
  if (!edge) throw new DirectorError('EDGE_NOT_FOUND', `边不存在: ${edgeId}`);
  const kind = patch.kind !== undefined ? patch.kind : edge.kind;
  const label = patch.label !== undefined ? patch.label : edge.label;
  if (kind === 'chain') {
    const others = graph.edges.filter((e) => e.id !== edgeId);
    validateChainEdge(graph, others, edge.source, edge.target);
  }
  edge.kind = kind;
  edge.label = label;
  return edge;
}

// chain 线性约束：端点必须是 shot；目标节点无已有入 chain，源节点无已有出 chain；
// 沿出链走到底不会回到源节点（无环）。chains 为当前（或候选）chain 边集合。
function validateChainEdge(graph: Graph, chains: DirectorEdge[], source: string, target: string): void {
  const typeOf = (id: string): string | undefined => graph.nodes.find((n) => n.id === id)?.type;
  if (typeOf(source) !== 'shot' || typeOf(target) !== 'shot') {
    throw new DirectorError('EDGE_INVALID', 'chain 边只允许连接 shot → shot（分镜链式参考）');
  }
  const chainOf = chains.filter((e) => e.kind === 'chain');
  if (chainOf.some((e) => e.target === target)) {
    throw new DirectorError('EDGE_INVALID', `分镜 ${target} 已有入链，一个分镜只能有一个前驱（暂不支持分支）`);
  }
  if (chainOf.some((e) => e.source === source)) {
    throw new DirectorError('EDGE_INVALID', `分镜 ${source} 已有出链，一个分镜只能有一个后继（暂不支持分支）`);
  }
  // 环检测：从 target 沿出链走，若回到 source 即成环
  let cur = target;
  const seen = new Set<string>([source]);
  for (;;) {
    if (seen.has(cur)) throw new DirectorError('EDGE_INVALID', 'chain 边成环：分镜链必须线性');
    seen.add(cur);
    const next = chainOf.find((e) => e.source === cur);
    if (!next) break;
    cur = next.target;
  }
}

export function deleteEdge(graph: Graph, edgeId: string): void {
  const idx = graph.edges.findIndex((e) => e.id === edgeId);
  if (idx === -1) throw new DirectorError('EDGE_NOT_FOUND', `边不存在: ${edgeId}`);
  graph.edges.splice(idx, 1);
}

// —— 持久化 ——

function projectFile(projectDir: string): string {
  return join(projectDir, '.director', 'project.json');
}

export function loadGraph(projectDir: string): Graph {
  const p = projectFile(projectDir);
  if (!existsSync(p)) {
    return { projectName: basename(projectDir), nodes: [], edges: [] };
  }
  return JSON.parse(readFileSync(p, 'utf8')) as Graph;
}

export function saveGraph(projectDir: string, graph: Graph): void {
  const p = projectFile(projectDir);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(graph, null, 2), 'utf8');
  renameSync(tmp, p); // 原子替换
}
