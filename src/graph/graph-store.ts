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

// 素材源节点 → 分镜接口组（文字/视频/图像）：与前端 nodes.tsx inletGroupOf 镜像
// prompt/script/subject/params/project/文本素材 → 文字；keyframe/图片素材 → 图像；
// 视频素材/generation 产物 → 视频；未知类型宽松归文字
function inletGroupOf(node: DirectorNode): 'text' | 'video' | 'image' {
  switch (node.type) {
    case 'keyframe': return 'image';
    case 'generation': return 'video';
    case 'asset': {
      const kind = node.fields.assetKind;
      if (kind === 'img') return 'image';
      if (kind === 'vid') return 'video';
      return 'text';
    }
    default: return 'text';
  }
}

const INLET_LABELS: Record<string, string> = { chain: '剧情', text: '文字', video: '视频', image: '图像' };

// 分镜左侧接口圆点类型校验（targetHandle 存在时）：
// - chain 边只能连剧情接口（chain-N）
// - ref/exec 边只能连与源节点素材类型匹配的接口（文字/视频/图像）
// 无 targetHandle 的边不校验（旧前端/重连兼容，前端渲染时会按源类型补齐）
function validateTargetHandle(graph: Graph, input: { kind: EdgeKind; source: string; target: string; targetHandle?: string }): void {
  if (!input.targetHandle) return;
  const tgt = findNode(graph, input.target);
  if (tgt.type !== 'shot') return;
  const group = /^([a-z]+)-\d+$/.exec(input.targetHandle)?.[1];
  if (!group) return;
  if (input.kind === 'chain') {
    if (group !== 'chain') {
      throw new DirectorError('EDGE_INVALID',
        `chain 边只能连接到分镜的剧情接口，不能连到${INLET_LABELS[group] ?? group}接口`);
    }
    return;
  }
  const src = findNode(graph, input.source);
  const expect = inletGroupOf(src);
  if (group !== expect) {
    throw new DirectorError('EDGE_INVALID',
      `接口类型不匹配：${INLET_LABELS[expect] ?? expect}类型的节点不能连接到${INLET_LABELS[group] ?? group}接口`);
  }
}

export function createEdge(
  graph: Graph,
  input: {
    kind: EdgeKind; source: string; target: string; label?: string; targetHandle?: string;
    /** 重连替换：新建边时把旧边（replaceEdgeId）从约束校验中排除（移动 chain 边） */
    replaceEdgeId?: string;
  },
): DirectorEdge {
  findNode(graph, input.source);
  findNode(graph, input.target);
  // 重连替换：定位被替换的旧边。replaceEdgeId 可能是前端乐观边 id（后端不存在）——
  // 按“同源 chain 出边”匹配（重连 = 移动该源节点的 chain 出边，线性约束保证唯一）
  let replacedId = input.replaceEdgeId;
  if (replacedId && !graph.edges.some((e) => e.id === replacedId)) {
    replacedId = input.kind === 'chain'
      ? graph.edges.find((e) => e.kind === 'chain' && e.source === input.source)?.id
      : undefined;
  }
  // 判重排除被替换的旧边（重连到相同参数 = 自身替换，允许）
  const dup = graph.edges.find(
    (e) => e.id !== replacedId
      && e.kind === input.kind && e.source === input.source && e.target === input.target
      && (e.targetHandle ?? null) === (input.targetHandle ?? null),
  );
  if (dup) throw new DirectorError('EDGE_EXISTS', `边已存在: ${input.source} -> ${input.target}`);
  // chain（链式参考）强制线性：只允许 shot→shot；每节点至多一个入/出 chain；全局无环。
  // （剧情顺序 = chain 拓扑序，分支/环会让 YAML segments 顺序不确定）
  // 重连场景排除被替换的旧边：移动 SHOT1→SHOT2 的 chain 到 SHOT3 时，
  // 旧边（SHOT1→SHOT2）让 SHOT1 看似“已有出链”，不排除会拒绝重连
  if (input.kind === 'chain') {
    const others = replacedId
      ? graph.edges.filter((e) => e.id !== replacedId)
      : graph.edges;
    validateChainEdge(graph, others, input.source, input.target);
  }
  // 分镜左侧接口圆点类型校验（文字/视频/图像/剧情）
  validateTargetHandle(graph, input);
  const edge: DirectorEdge = {
    id: randomUUID(),
    kind: input.kind,
    source: input.source,
    target: input.target,
    label: input.label,
    targetHandle: input.targetHandle,
  };
  graph.edges.push(edge);
  // 原子替换：创建新边后删除被替换的旧边（重连 = 后端一次性完成替换，
  // 不依赖前端删除——乐观边 id 错位/WS 竞态下旧边也不会残留）
  if (replacedId) {
    graph.edges = graph.edges.filter((e) => e.id !== replacedId);
  }
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
