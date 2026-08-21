export interface RailItem {
  id: string;
  label: string;
  icon: string;
  active?: boolean;
}

export interface SkillCard {
  id: string;
  tag: string;
  title: string;
  desc: string;
  image: string;
}

export interface GenerateData {
  rail: {
    items: RailItem[];
  };
  sidebar: {
    createLabel: string;
    newChatLabel: string;
  };
  hero: {
    title: string;
  };
  skills: SkillCard[];
  composer: {
    placeholder: string;
    agentOptions: string[];
    preferences: {
      types: string[];
      ratios: string[];
      models: string[];
    };
    skills: { id: string; name: string; tag?: string; desc: string }[];
    skillFooter: string[];
  };
}

export interface ChatStage {
  type: 'thinking' | 'task' | 'done' | 'error';
  logs?: string[];
  progress?: { completed: number; total: number };
  taskLabel?: string;
  queued?: boolean;
  queueLabel?: string;
  credits?: number;
  suggestion?: string;
  cancelled?: boolean;
  outputs?: GenerationOutput[];
}

export interface GenerationOutput {
  kind: 'image' | 'video' | 'text';
  label?: string;
  url?: string;
  filename?: string;
  subfolder?: string;
  type?: string;
  text?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  stages?: ChatStage[];
  jobId?: string;
}

export interface ChatReply {
  title: string;
  reply?: string;
  stages?: ChatStage[];
  jobId?: string;
  promptId?: string;
}

/* ---------------- ComfyUI workflow introspection ---------------- */

export interface WorkflowInput {
  id: string;
  kind: 'text' | 'image' | 'video';
  label: string;
  nodeId: string;
  field: string;
  classType: string;
  defaultValue?: string;
  /** 是否必须由用户提供（素材缺失或工作流强依赖） */
  required?: boolean;
}

export interface WorkflowParam {
  id: string;
  label: string;
  nodeId: string;
  field: string;
  type: 'INT' | 'FLOAT' | 'BOOLEAN' | 'SEED' | 'STRING' | 'combo';
  default: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
}

export interface WorkflowOutput {
  id: string;
  kind: 'image' | 'video' | 'text';
  label: string;
  nodeId: string;
  classType: string;
}

export interface WorkflowSpec {
  id: string;
  name: string;
  description?: string;
  inputs: WorkflowInput[];
  params: WorkflowParam[];
  outputs: WorkflowOutput[];
}

export interface ComfyStatus {
  connected: boolean;
  baseUrl: string;
  system?: { comfyui_version?: string; python_version?: string };
  error?: string;
  queue?: { running: number; pending: number };
}

export type JobEvent =
  | { type: 'executing'; nodeId: string; label: string }
  | { type: 'progress'; completed: number; total: number; percent: number }
  | { type: 'queue'; running: number; pending: number }
  | { type: 'done'; outputs: GenerationOutput[] }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };

/* ---------------- 请求封装 ---------------- */

async function http<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export async function fetchGenerateData(): Promise<GenerateData> {
  return http('/api/generate');
}

export async function fetchWorkflows(): Promise<WorkflowSpec[]> {
  return http('/api/workflows');
}

export async function fetchComfyStatus(): Promise<ComfyStatus> {
  return http('/api/comfyui/status');
}

export interface ComfySettings {
  baseUrl: string;
}

export async function fetchComfySettings(): Promise<ComfySettings> {
  return http('/api/settings');
}

export async function saveComfySettings(
  baseUrl: string,
): Promise<{
  ok: boolean;
  baseUrl: string;
  connected: boolean;
  status?: ComfyStatus;
  error?: string;
}> {
  return http('/api/settings/comfyui', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl }),
  });
}

export interface SendChatOptions {
  workflowId?: string;
  params?: Record<string, unknown>;
  images?: { name?: string; dataUrl: string }[];
  videos?: { name?: string; dataUrl: string }[];
}

export async function sendChat(message: string, opts: SendChatOptions = {}): Promise<ChatReply> {
  return http('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, ...opts }),
  });
}

export async function cancelJob(jobId: string): Promise<{ ok: boolean }> {
  return http(`/api/generate/${jobId}/cancel`, { method: 'POST' });
}

/** 订阅生成任务事件流（SSE），返回关闭函数 */
export function openJobEvents(jobId: string, onEvent: (evt: JobEvent) => void): () => void {
  const es = new EventSource(`/api/generate/${jobId}/events`);
  es.onmessage = e => {
    try {
      onEvent(JSON.parse(e.data) as JobEvent);
    } catch {
      /* ignore */
    }
  };
  es.onerror = () => es.close();
  return () => es.close();
}
