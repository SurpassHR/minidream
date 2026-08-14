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
