// 镜像 Director Server 契约（后端 src/types.ts）；字段与 spec 第 5 节一致
export type NodeType =
  | 'project' | 'script' | 'subject' | 'shot' | 'keyframe'
  | 'prompt' | 'params' | 'generation' | 'asset';

export type EdgeKind = 'ref' | 'chain' | 'exec';

export interface DirectorNode {
  id: string;
  type: NodeType;
  title: string;
  fields: Record<string, unknown>;
  position: { x: number; y: number };
  version: number;
}

export interface DirectorEdge {
  id: string;
  kind: EdgeKind;
  source: string;
  target: string;
  label?: string;
}

export interface Graph {
  projectName: string;
  nodes: DirectorNode[];
  edges: DirectorEdge[];
}

export type Actor = 'user' | 'agent';

export interface SnapshotMeta {
  seq: number;
  ts: number;
  actor: Actor;
  reason: string;
}

export type GenStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';

export interface GenTask {
  id: string;
  status: GenStatus;
  progress: number;
  error?: string;
  promptId?: string;
  result?: { videoPath: string; lastFramePath: string };
}

export type WsEvent =
  | { type: 'graph'; graph: Graph }
  | { type: 'generation'; task: GenTask }
  | { type: 'file-changed'; path: string };
