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

export interface ImageGenSettings {
  seedMode: 'random' | 'fixed';
  seed: number;
  steps: number;
  cfg: number;
  sampler_name: string;
  scheduler: string;
  denoise: number;
  width: number;
  height: number;
}

export interface AppSettings {
  comfyui: {
    baseUrl: string;
  };
  imageGen?: ImageGenSettings;
}

export async function fetchAppSettings(): Promise<AppSettings> {
  return http('/api/settings');
}

export async function saveImageGenSettings(
  settings: Partial<ImageGenSettings>,
): Promise<{ ok: boolean; imageGen: ImageGenSettings }> {
  return http('/api/settings/image-gen', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
}

export async function fetchComfySettings(): Promise<AppSettings> {
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
  sessionId?: string | null;
}

export interface ChatReplyWithSession extends ChatReply {
  /** 本次消息所属会话 id（无会话时后端自动创建） */
  sessionId?: string;
}

export async function sendChat(message: string, opts: SendChatOptions = {}): Promise<ChatReplyWithSession> {
  return http('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, ...opts }),
  });
}

/* ---------------- 会话（服务端 JSON 文件持久化） ---------------- */

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionsResponse {
  sessions: SessionMeta[];
  activeId: string | null;
}

export async function fetchSessions(): Promise<SessionsResponse> {
  return http('/api/sessions');
}

export async function createSession(): Promise<SessionsResponse> {
  return http('/api/sessions', { method: 'POST' });
}

export async function renameSession(id: string, title: string): Promise<SessionsResponse> {
  return http(`/api/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
}

export async function deleteSession(id: string): Promise<SessionsResponse> {
  return http(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function selectSession(id: string): Promise<{ ok: boolean; activeId: string | null }> {
  return http(`/api/sessions/${encodeURIComponent(id)}/select`, { method: 'POST' });
}

export async function fetchSessionMessages(id: string): Promise<ChatMessage[]> {
  return http(`/api/sessions/${encodeURIComponent(id)}/messages`);
}

/** SSE 终态落库：更新会话最后一条消息（done/error/cancelled 时调用） */
export async function updateLastMessage(id: string, msg: ChatMessage): Promise<{ ok: boolean }> {
  return http(`/api/sessions/${encodeURIComponent(id)}/messages/last`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(msg),
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
