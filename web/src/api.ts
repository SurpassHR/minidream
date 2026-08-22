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

export interface TaskStage {
  id: string;
  name: string;
  status: 'pending' | 'active' | 'completed' | 'failed';
  progress?: number;
  step?: number;
  totalSteps?: number;
  logs: string[];
}

export interface TaskOutput {
  kind: 'image' | 'video' | 'text';
  url: string;
  filename: string;
  subfolder?: string;
  type?: string;
}

export interface TaskItem {
  id: string;
  type: 'image_generation' | 'video_generation';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled' | 'interrupted';
  workflowId: string;
  prompt: string;
  images?: string[];
  videos?: string[];
  params?: Record<string, unknown>;
  sessionId?: string;
  stages: TaskStage[];
  outputs?: TaskOutput[];
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ActionCardData {
  title: string;
  workflowId: string;
  prompt: string;
  images?: string[];
  params?: Record<string, unknown>;
}

export interface ToolCallData {
  callId?: string;
  name: string;
  args?: Record<string, unknown>;
  result?: unknown;
}

export type StreamChatEvent =
  | { type: 'agent:started'; sessionId: string; status?: string }
  | { type: 'agent:status'; status: string }
  | { type: 'agent:thinking'; delta: string }
  | { type: 'agent:text'; delta: string }
  | { type: 'agent:action_card'; card: ActionCardData }
  | { type: 'tool:call'; callId?: string; name: string; args?: Record<string, unknown> }
  | { type: 'tool:result'; callId?: string; name: string; result?: unknown }
  | { type: 'task:queued'; taskId: string; position: number; task?: TaskItem }
  | {
      type: 'task:progress';
      taskId: string;
      stage: string;
      step: number;
      total: number;
      percent: number;
      task?: TaskItem;
    }
  | {
      type: 'task:artifact';
      taskId: string;
      kind: 'image' | 'video' | 'text';
      url: string;
      filename?: string;
    }
  | { type: 'task:completed'; taskId: string; task?: TaskItem }
  | { type: 'task:failed'; taskId: string; error?: string; task?: TaskItem }
  | { type: 'task:canceled'; taskId: string; task?: TaskItem }
  | { type: 'agent:error'; error: string }
  | { type: 'session:renamed'; sessionId: string; title: string }
  | { type: 'agent:end'; sessionId?: string; totalTokens?: number; canceled?: boolean };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  thinkingDurationMs?: number;
  /** Agent 尚未产生正文时展示的即时生命周期状态 */
  status?: string;
  toolCalls?: ToolCallData[];
  tasks?: TaskItem[];
  actionCards?: ActionCardData[];
  stages?: ChatStage[];
  jobId?: string;
  taskId?: string;
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

export interface ActiveSession {
  sessionId: string;
  message: string;
  startedAt: number;
  taskIds: string[];
  status: 'running' | 'canceled' | 'completed' | 'failed';
}

export interface ActivitySnapshot {
  sessions: ActiveSession[];
  tasks: TaskItem[];
}

export type ActivityStreamEvent =
  | { type: 'snapshot'; snapshot: ActivitySnapshot }
  | { type: 'session:started' | 'session:updated' | 'session:canceled' | 'session:finished'; session: ActiveSession }
  | { type: 'session:renamed'; sessionId: string; title: string }
  | { type: 'task:updated'; task: TaskItem };

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

export async function fetchDrafts(): Promise<{ drafts: DraftRecord[] }> {
  return http('/api/drafts');
}

export async function deleteDraft(id: string): Promise<{ ok: boolean }> {
  return http(`/api/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' });
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

export interface StorageSettings {
  outputDir: string;
}

export interface DraftRecord {
  id: string;
  taskId?: string;
  kind: 'image' | 'video' | 'text';
  filename: string;
  mime?: string;
  size: number;
  createdAt: number;
}

export type AgentThinking = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AgentSettings {
  model: string;
  thinking: AgentThinking;
}

export interface AgentModel {
  id: string;
  provider: string;
  thinking: boolean;
  images: boolean;
}

export interface AppSettings {
  comfyui: {
    baseUrl: string;
  };
  agent?: AgentSettings;
  imageGen?: ImageGenSettings;
  storage?: StorageSettings;
}

export async function fetchAppSettings(): Promise<AppSettings> {
  return http('/api/settings');
}

export async function fetchAgentModels(): Promise<{ models: AgentModel[] }> {
  return http('/api/agent/models');
}

export async function saveAgentSettings(
  agent: Partial<AgentSettings>,
): Promise<{ ok: boolean; agent: AgentSettings; error?: string }> {
  return http('/api/settings/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(agent),
  });
}

export async function saveStorageSettings(outputDir: string): Promise<{ ok: boolean; storage: StorageSettings; error?: string }> {
  return http('/api/settings/storage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ outputDir }),
  });
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
  agentModel?: string;
  thinking?: AgentThinking;
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

/** 流式发送对话，解析 SSE 事件（支持 Thinking、Task 进度、Tool 调用与多模态产物） */
export async function sendChatStream(
  message: string,
  opts: SendChatOptions = {},
  onEvent: (evt: StreamChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ message, ...opts, stream: true }),
    signal,
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '网络请求失败');
    throw new Error(`HTTP ${res.status}: ${errorText}`);
  }

  if (!res.body) {
    throw new Error('ReadableStream not supported in response');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split(/\r?\n\r?\n/);
    buffer = lines.pop() ?? '';

    for (const block of lines) {
      if (!block.trim()) continue;
      let eventType = 'message';
      let dataStr = '';

      const lineList = block.split(/\r?\n/);
      for (const line of lineList) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          dataStr = line.slice(6).trim();
        }
      }

      if (!dataStr) continue;
      try {
        const parsed = JSON.parse(dataStr);
        if (eventType === 'agent:started') {
          onEvent({ type: 'agent:started', sessionId: parsed.sessionId, status: parsed.status });
        } else if (eventType === 'agent:status') {
          onEvent({ type: 'agent:status', status: parsed.status });
        } else if (eventType === 'agent:thinking') {
          onEvent({ type: 'agent:thinking', delta: parsed.delta });
        } else if (eventType === 'agent:text') {
          onEvent({ type: 'agent:text', delta: parsed.delta as string });
        } else if (eventType === 'agent:action_card') {
          onEvent({ type: 'agent:action_card', card: parsed.card });
        } else if (eventType === 'tool:call') {
          onEvent({
            type: 'tool:call',
            callId: parsed.callId,
            name: parsed.name,
            args: parsed.args,
          });
        } else if (eventType === 'tool:result') {
          onEvent({
            type: 'tool:result',
            callId: parsed.callId,
            name: parsed.name,
            result: parsed.result,
          });
        } else if (eventType === 'task:queued') {
          onEvent({
            type: 'task:queued',
            taskId: parsed.taskId,
            position: parsed.position,
            task: parsed.task,
          });
        } else if (eventType === 'task:progress') {
          onEvent({
            type: 'task:progress',
            taskId: parsed.taskId,
            stage: parsed.stage,
            step: parsed.step,
            total: parsed.total,
            percent: parsed.percent,
            task: parsed.task,
          });
        } else if (eventType === 'task:artifact') {
          onEvent({
            type: 'task:artifact',
            taskId: parsed.taskId,
            kind: parsed.kind,
            url: parsed.url,
            filename: parsed.filename,
          });
        } else if (eventType === 'task:completed') {
          onEvent({
            type: 'task:completed',
            taskId: parsed.taskId,
            task: parsed.task,
          });
        } else if (eventType === 'task:failed') {
          onEvent({
            type: 'task:failed',
            taskId: parsed.taskId,
            error: parsed.error,
            task: parsed.task,
          });
        } else if (eventType === 'task:canceled') {
          onEvent({
            type: 'task:canceled',
            taskId: parsed.taskId,
            task: parsed.task,
          });
        } else if (eventType === 'agent:error') {
          onEvent({
            type: 'agent:error',
            error: parsed.error,
          });
        } else if (eventType === 'session:renamed') {
          onEvent({
            type: 'session:renamed',
            sessionId: parsed.sessionId,
            title: parsed.title,
          });
        } else if (eventType === 'agent:end') {
          onEvent({
            type: 'agent:end',
            sessionId: parsed.sessionId,
            totalTokens: parsed.totalTokens,
            canceled: parsed.canceled,
          });
        }
      } catch {
        /* ignore invalid JSON in stream chunk */
      }
    }
  }
}

/* ---------------- 统一任务 API (/api/tasks) ---------------- */

export async function fetchActivity(): Promise<ActivitySnapshot> {
  return http('/api/activity');
}

export async function cancelSession(sessionId: string): Promise<{ ok: boolean; sessionId: string; canceledTaskIds: string[] }> {
  return http(`/api/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: 'POST' });
}

export function openSessionEvents(
  sessionId: string,
  onEvent: (event: StreamChatEvent, sequence: number) => void,
): () => void {
  let closed = false;
  let sequence = 0;
  let es: EventSource | null = null;
  let retryTimer: number | null = null;

  const close = () => {
    closed = true;
    if (retryTimer != null) window.clearTimeout(retryTimer);
    es?.close();
  };

  const connect = () => {
    if (closed) return;
    es = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events?after=${sequence}`);
    es.addEventListener('session:event', event => {
      try {
        const envelope = JSON.parse((event as MessageEvent).data) as {
          sequence: number;
          event: StreamChatEvent;
        };
        if (envelope.sequence <= sequence) return;
        sequence = envelope.sequence;
        onEvent(envelope.event, envelope.sequence);
        if (envelope.event.type === 'agent:end') close();
      } catch {
        /* ignore malformed session event */
      }
    });
    es.onerror = () => {
      es?.close();
      if (!closed && retryTimer == null) {
        retryTimer = window.setTimeout(() => {
          retryTimer = null;
          connect();
        }, 2000);
      }
    };
  };

  connect();
  return close;
}

export function openActivityEvents(onEvent: (event: ActivityStreamEvent) => void): () => void {
  const es = new EventSource('/api/activity/events');
  es.addEventListener('activity', event => {
    try {
      onEvent(JSON.parse((event as MessageEvent).data) as ActivityStreamEvent);
    } catch {
      /* ignore malformed activity event */
    }
  });
  es.onerror = () => es.close();
  return () => es.close();
}

export async function getTasks(): Promise<{ tasks: TaskItem[] }> {
  return http('/api/tasks');
}

export async function getTask(id: string): Promise<{ task: TaskItem }> {
  return http(`/api/tasks/${encodeURIComponent(id)}`);
}

export async function cancelTask(id: string): Promise<{ ok: boolean; task: TaskItem }> {
  return http(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
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
