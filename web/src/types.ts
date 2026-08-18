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
  // 目标端接口圆点 id（分镜节点多输入圆点：text-0 / video-0 / image-0 …）
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

// 项目列表项（镜像后端 src/projects/projects-store.ts）
export interface ProjectInfo {
  path: string;
  name: string;
  current: boolean;
  shots: number;    // -1 = 未知
  duration: number; // 秒；-1 = 未知
  mode: string;     // 'KEYFRAME' | 'REF2V' | ''
}

export type WsEvent =
  | { type: 'graph'; graph: Graph }
  | { type: 'generation'; task: GenTask }
  | { type: 'file-changed'; path: string }
  // agent 活动回传（借鉴 kanban hooks：agent 工具调用即活动，前端实时展示）
  | { type: 'agent-activity'; text: string; at: number };

// story-teller 向导进度（镜像后端 src/story/store.ts）
export interface StoryProgress {
  step: number;
  answers: Record<string, string>;
  completedAt: string | null;
}

// object-designer 设计对象（镜像后端 src/design/store.ts）
export type DesignKind = 'character' | 'scene' | 'prop';
export type DesignStatus = 'draft' | 'generating' | 'done' | 'failed';

export interface DesignObject {
  id: string;
  kind: DesignKind;
  name: string;
  description: string;
  style: string;
  template: string;
  status: DesignStatus;
  assetId?: string;
  error?: string;
  createdAt: number;
}

// 素材记录（镜像后端 src/types.ts AssetRecord）
export interface AssetRecord {
  id: string;
  kind: 'txt' | 'img' | 'vid';
  name: string;
  ext: string;
  size: number;
  importedAt: number;
}

// 会话元数据（镜像后端 src/sessions/store.ts）
export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

// 全局设置（镜像后端 src/settings/settings-store.ts）：ComfyUI 地址 / agent 默认模型 / 思考强度
export interface AppSettings {
  comfyUrl: string;
  agentModel: string;
  agentThinking: string;
  // 提示词库（键=名称，值=内容）；键缺失=从未自定义（设置弹窗预填 5 角色默认）
  prompts?: Record<string, string>;
  // 破甲预设：开启且文本非空时插入到所有系统提示词之前
  armorBreak?: string;
  armorBreakEnabled?: boolean;
  // Ollama 本地视觉模型（图像转提示词）：地址 + 视觉模型名；空 = 未配置
  ollamaUrl?: string;
  ollamaModel?: string;
}
