// 导演工作台领域类型定义（唯一来源）
export type NodeType =
  | 'project' | 'script' | 'subject' | 'shot' | 'keyframe'
  | 'prompt' | 'params' | 'generation' | 'asset';

export type EdgeKind = 'ref' | 'chain' | 'exec';

export interface DirectorNode {
  id: string;                       // UUID
  type: NodeType;
  title: string;
  fields: Record<string, unknown>;  // 类型相关字段（shot: content/filename/duration …）
  position: { x: number; y: number };
  version: number;                  // 每次更新 +1
}

export interface DirectorEdge {
  id: string;
  kind: EdgeKind;
  source: string;  // 源节点 id
  target: string;  // 目标节点 id
  label?: string;
  /** 目标端接口圆点 id（如分镜节点的 text-0 / video-1 / image-0）；
   *  仅分镜（shot）节点使用：左侧按 文字/视频/图像 分组的多输入圆点 */
  targetHandle?: string;
}

export interface Graph {
  projectName: string;
  nodes: DirectorNode[];
  edges: DirectorEdge[];
}

export type Actor = 'user' | 'agent';

export interface SnapshotMeta {
  seq: number;
  ts: number;          // epoch ms
  actor: Actor;
  reason: string;      // 操作描述，如 "更新分镜 SHOT 02 时长"
}

export type DirectorErrorCode =
  | 'NODE_NOT_FOUND' | 'EDGE_NOT_FOUND' | 'EDGE_EXISTS'
  | 'CONFIRM_REQUIRED' | 'FILE_CONFLICT' | 'INVALID_PATCH'
  | 'PROJECT_NOT_FOUND' | 'PROJECT_NOT_ADDABLE' | 'PROJECT_NOT_OPEN' | 'EDGE_INVALID'
  | 'YAML_EXPORT_FAILED' | 'STORY_ALREADY_COMPLETED' | 'SESSION_NOT_FOUND' | 'BOARD_NOT_FOUND';

export class DirectorError extends Error {
  constructor(public code: DirectorErrorCode, message: string) {
    super(message);
    this.name = 'DirectorError';
  }
}

// —— 生成执行（计划 2） ——
export type GenStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';

export interface ComfyMedia {
  filename: string;
  subfolder: string;
  type: string; // 'output' | 'temp' 等
}

export interface ComfyOutput {
  promptId: string;
  media: ComfyMedia[];
}

export interface GenTask {
  id: string;          // generation 节点 id
  status: GenStatus;
  progress: number;    // 0-100
  error?: string;
  promptId?: string;
  result?: {
    videoPath: string;     // out/ 下相对项目目录
    lastFramePath: string; // out/ 下相对项目目录
  };
}

// —— 素材库（计划 4） ——
export type AssetKind = 'txt' | 'img' | 'vid';

export interface AssetRecord {
  id: string;
  kind: AssetKind;
  name: string;
  ext: string;
  meta?: string;
  /** 图像 captioning 生成的描述（写回图像记录，卡片缩略图下方/预览可直接展示） */
  caption?: string;
  size: number;
  importedAt: number;
}
