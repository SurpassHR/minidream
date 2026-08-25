import i18n from './i18n';

export interface RailItem {
  id: string;
  label: string;
  icon: string;
  active?: boolean;
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
  composer: {
    placeholder: string;
    preferences: {
      types: string[];
      ratios: string[];
      /** 生成尺寸（MP）：滑块范围与步长 */
      sizes: { min: number; max: number; step: number; default: number };
      models: string[];
    };
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
  generation?: {
    taskId: string;
    workflowId: string;
    prompt: string;
    params?: Record<string, unknown>;
    ratio?: string;
    size?: number;
    createdAt: number;
  };
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
  generation?: {
    taskId: string;
    workflowId: string;
    prompt: string;
    params?: Record<string, unknown>;
    ratio?: string;
    size?: number;
    createdAt: number;
  };
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
  generationParams?: Record<string, unknown>;
  ratio?: string;
  size?: number;
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

export interface WorkflowRoute {
  requestedWorkflowId: string;
  finalWorkflowId: string;
  intent: 'text_to_image' | 'image_to_image' | 'image_upscale' | 'text_to_video' | 'image_to_video' | 'unknown';
  referenceImageCount: number;
  referenceVideoCount: number;
  forced: boolean;
  reason: string;
  taskId?: string;
  sessionId?: string;
}

export interface PluginResponsePolicy {
  thinking: 'hidden' | 'collapsed' | 'visible';
  prompt: 'hidden' | 'visible';
  route: 'hidden' | 'visible';
  result: 'outside-bubble';
}

export interface ResponseBlock {
  id: string;
  order?: number;
  type: 'field' | 'template' | 'assistant-reply' | 'thinking';
  source?: string;
  label?: string;
  content: string;
  container: 'text' | 'collapsible';
  format: 'plain' | 'markdown' | 'code';
  defaultOpen?: boolean;
  language?: string;
  timing: 'submit' | 'complete' | 'always';
}

export interface PluginResponseProtocol {
  version: 1;
  thinking: {
    enabled: boolean;
    container: 'text' | 'collapsible';
    format: 'plain' | 'markdown' | 'code';
    defaultOpen?: boolean;
    language?: string;
  };
  blocks: Array<{
    id: string;
    type: 'field' | 'template' | 'assistant-reply';
    source?: string;
    template?: string;
    label?: string;
    container: 'text' | 'collapsible';
    format: 'plain' | 'markdown' | 'code';
    defaultOpen?: boolean;
    language?: string;
    timing: 'submit' | 'complete' | 'always';
    visibleWhen?: { source: string; operator: 'exists' | 'not-empty' };
  }>;
  result: { display: 'outside-bubble' };
}

export interface ToolCallData {
  callId?: string;
  name: string;
  args?: Record<string, unknown>;
  result?: unknown;
}

export type StreamChatEvent =
  | { type: 'agent:started'; sessionId: string; status?: string }
  /** Agent 正文回复已结束（生成任务可能仍在进行，用于停止打字光标） */
  | { type: 'agent:reply_done' }
  | { type: 'agent:status'; status: string }
  | { type: 'agent:thinking'; delta: string }
  | { type: 'agent:response_policy'; policy: PluginResponsePolicy }
  | { type: 'agent:response_protocol'; active: boolean }
  | { type: 'agent:text'; delta: string }
  | { type: 'agent:prompt'; prompt: string }
  | { type: 'agent:route'; route: WorkflowRoute }
  | { type: 'agent:response_block'; block: ResponseBlock }
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
  routes?: WorkflowRoute[];
  generationPrompts?: string[];
  responseBlocks?: ResponseBlock[];
  responseProtocolActive?: boolean;
  responsePolicy?: PluginResponsePolicy;
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
  description?: string;
  nodeId: string;
  field: string;
  classType: string;
  defaultValue?: string;
  /** 是否必须由用户提供（素材缺失或工作流强依赖） */
  required?: boolean;
  /** 工作流显式标记的提示词注入目标（_meta.promptPlaceholder） */
  primary?: boolean;
  hidden?: boolean;
}

export interface WorkflowParam {
  id: string;
  label: string;
  description?: string;
  nodeId: string;
  field: string;
  type: 'INT' | 'FLOAT' | 'BOOLEAN' | 'SEED' | 'STRING' | 'combo';
  default: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  /** 多选参数（如 Power Lora Loader 的 LoRA 列表）：值为 string[] */
  multiple?: boolean;
  /** 多选参数每项可调强度（如 LoRA）：值为 {name, strength}[]，min/max/step 描述强度范围 */
  strengthable?: boolean;
  applyTo?: string[];
  hidden?: boolean;
  /** 是否加入 LLM 上下文：false 表示仅在节点视图固定值（仍参与运行时注入），不暴露给 LLM */
  llm?: boolean;
  /** 节点屏蔽（bypass）：布尔参数，true 时跳过 nodeId 节点的执行（对应 ComfyUI bypass），field 为空 */
  bypass?: boolean;
}

export interface WorkflowOutput {
  id: string;
  kind: 'image' | 'video' | 'text';
  label: string;
  nodeId: string;
  classType: string;
  description?: string;
  hidden?: boolean;
}

export interface WorkflowSpec {
  id: string;
  name: string;
  description?: string;
  source?: { type: 'bundled' | 'imported'; workflowFile: string };
  hasManifest?: boolean;
  editable?: boolean;
  manifestError?: string;
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
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const message = (() => {
      try {
        const body = JSON.parse(detail) as { error?: string };
        if (typeof body.error === 'string' && body.error.trim()) return body.error.trim();
      } catch {
        /* 非 JSON 响应体 */
      }
      return detail.trim() || res.statusText;
    })();
    throw new Error(`HTTP ${res.status}: ${message}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchDrafts(): Promise<{ drafts: DraftRecord[] }> {
  return http('/api/drafts');
}

export async function deleteDraft(id: string): Promise<{ ok: boolean }> {
  return http(`/api/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** 在系统文件管理器中打开草稿文件所在位置 */
export async function openDraftLocation(id: string): Promise<{ ok: boolean }> {
  return http(`/api/drafts/${encodeURIComponent(id)}/open-location`, { method: 'POST' });
}

export async function fetchGenerateData(): Promise<GenerateData> {
  return http('/api/generate');
}

export interface WorkflowNodeCandidate {
  nodeId: string;
  classType: string;
  title: string;
  fields: Array<{ field: string; type: string; connected: boolean }>;
}

export interface WorkflowGraphField {
  nodeId: string;
  field: string;
  type: string;
  value?: unknown;
  connected: boolean;
  selectable: boolean;
  selected: boolean;
  paramId?: string;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  applyTo?: string[];
  multiple?: boolean;
  strengthable?: boolean;
  connection?: { sourceNode: string; sourceField: string };
}

export interface WorkflowGraphNode {
  nodeId: string;
  classType: string;
  title: string;
  x: number;
  y: number;
  fields: WorkflowGraphField[];
}

export interface WorkflowGraphEdge {
  sourceNode: string;
  sourceField: string;
  targetNode: string;
  targetField: string;
  type?: string;
}

export interface WorkflowGraph {
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
  manifestError?: string;
}

export interface WorkflowManifest extends WorkflowSpec {
  source: { type: 'bundled' | 'imported'; workflowFile: string };
}

export interface WorkflowPluginRecord extends WorkflowSpec {
  source: { type: 'bundled' | 'imported'; workflowFile: string };
  hasManifest: boolean;
  editable: boolean;
  enabled: boolean;
  available: boolean;
}

export async function fetchWorkflows(): Promise<WorkflowSpec[]> {
  return http('/api/workflows');
}

export async function fetchPlugins(): Promise<WorkflowPluginRecord[]> {
  return http('/api/plugins');
}

export async function fetchWorkflowNodes(id: string): Promise<{ nodes: WorkflowNodeCandidate[] }> {
  return http(`/api/plugins/${encodeURIComponent(id)}/nodes`);
}

export async function fetchWorkflowGraph(id: string): Promise<{ graph: WorkflowGraph }> {
  return http(`/api/plugins/${encodeURIComponent(id)}/graph`);
}

export async function importWorkflowPlugin(payload: {
  filename: string;
  name?: string;
  workflow: Record<string, unknown>;
  overwrite?: boolean;
}): Promise<{ ok: boolean; plugin: WorkflowPluginRecord }> {
  return http('/api/plugins/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function saveWorkflowManifest(id: string, manifest: WorkflowManifest): Promise<{ ok: boolean; plugin: WorkflowPluginRecord }> {
  return http(`/api/plugins/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
}

export async function redetectWorkflowManifest(id: string): Promise<WorkflowManifest> {
  return http(`/api/plugins/${encodeURIComponent(id)}/redetect`, { method: 'POST' });
}

/** plugin-creator 配置建议（预览，不落盘） */
export interface PluginAnalysisCandidate {
  candidate: { id: string; kind: string; label: string; description?: string; hidden?: boolean };
  confidence: number;
  reason: string;
  recommended: boolean;
}

export interface PluginAnalysisWidget {
  field: {
    nodeId: string;
    field: string;
    type: string;
    connected: boolean;
    selectable: boolean;
    value?: unknown;
    options?: string[];
  };
  exposure: 'llm' | 'fixed' | 'hidden' | 'review';
  reason: string;
  confidence: number;
  /** 仅连线字段：沿连线追溯到的上游源头节点及其可暴露 widget */
  sources?: Array<{ nodeId: string; classType: string; title: string; fields: string[] }>;
}

export interface PluginAnalysis {
  workflow: { format: 'api' | 'ui'; nodeCount: number; sourceFingerprint: string };
  purpose: { name: string; description: string; capabilities: string[] };
  inputs: PluginAnalysisCandidate[];
  outputs: PluginAnalysisCandidate[];
  widgets: PluginAnalysisWidget[];
  response: {
    recommendedPromptVisibility: boolean;
    blocks: Array<{ source: string; timing: string; format: string }>;
  };
}

/** 请求插件配置分析建议预览；服务端只读不写盘 */
export async function analyzePluginConfig(id: string): Promise<{ ok: boolean; analysis: PluginAnalysis; warnings?: string[] }> {
  return http(`/api/plugins/${encodeURIComponent(id)}/analyze`, { method: 'POST' });
}

/** 用户确认后保存完整插件配置；overwrite 标志控制是否重写自定义 Skill/回复协议 */
export async function configureWorkflowPlugin(
  id: string,
  manifest: WorkflowManifest,
  flags: { overwriteSkill?: boolean; overwriteResponse?: boolean } = {},
): Promise<{ ok: boolean; plugin: WorkflowPluginRecord }> {
  return http(`/api/plugins/${encodeURIComponent(id)}/configure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest, ...flags }),
  });
}

/** 获取插件自动生成的 SKILL.md（预览用） */
export async function fetchPluginSkill(id: string): Promise<string> {
  const res = await fetch(`/api/plugins/${encodeURIComponent(id)}/skill`);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${detail.trim() || res.statusText}`);
  }
  return res.text();
}

/** 强制重新生成插件 SKILL.md（自动版） */
export async function regeneratePluginSkill(id: string): Promise<{ ok: boolean }> {
  return http(`/api/plugins/${encodeURIComponent(id)}/skill/regenerate`, { method: 'POST' });
}

/** 保存插件 SKILL.md 的自定义内容（手工编辑） */
export async function savePluginSkill(id: string, content: string): Promise<{ ok: boolean; content: string }> {
  return http(`/api/plugins/${encodeURIComponent(id)}/skill`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

/** 用 plugin-creator 为插件生成 SKILL.md（覆盖当前内容） */
export async function generatePluginSkillLlm(id: string): Promise<{ ok: boolean; content: string }> {
  return http(`/api/plugins/${encodeURIComponent(id)}/skill/generate`, { method: 'POST' });
}

/** 获取插件机器可读回复协议；服务端会自动兼容旧版 Skill response 字段 */
export async function fetchPluginResponse(id: string): Promise<{ ok: boolean; protocol: PluginResponseProtocol }> {
  return http(`/api/plugins/${encodeURIComponent(id)}/response`);
}

/** 保存插件机器可读回复协议 */
export async function savePluginResponse(id: string, protocol: PluginResponseProtocol): Promise<{ ok: boolean; protocol: PluginResponseProtocol }> {
  return http(`/api/plugins/${encodeURIComponent(id)}/response`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol }),
  });
}

/** 按当前插件重新生成默认兼容回复协议 */
export async function regeneratePluginResponse(id: string): Promise<{ ok: boolean; protocol: PluginResponseProtocol }> {
  return http(`/api/plugins/${encodeURIComponent(id)}/response/regenerate`, { method: 'POST' });
}

export interface PluginSkillChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export async function chatPluginSkill(
  id: string,
  message: string,
  history: PluginSkillChatMessage[],
  currentSkill: string,
): Promise<{ ok: boolean; reply: string; skill: string }> {
  return http(`/api/plugins/${encodeURIComponent(id)}/skill/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, history, currentSkill }),
  });
}

export async function deleteWorkflowPlugin(id: string): Promise<{ ok: boolean }> {
  return http(`/api/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' });
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

export type FabricatedRole = 'system' | 'user' | 'assistant';

export interface FabricatedHistoryMessage {
  role: FabricatedRole;
  content: string;
}

export interface AgentSettings {
  model: string;
  thinking: AgentThinking;
  /** Agent 是否轮询生成任务状态（关闭时移除 generation.status 工具，进度走 SSE 推送） */
  pollTaskStatus: boolean;
  /** 是否注入虚构对话历史（开关控制；关闭时不注入，即使有内容） */
  fabricatedEnabled: boolean;
  /** 虚构对话历史：开关开启且有内容时每个请求注入（内容与条数均可配置；空数组 = 无内容可注入） */
  fabricatedHistory: FabricatedHistoryMessage[];
}

export interface AgentModel {
  id: string;
  provider: string;
  thinking: boolean;
  images: boolean;
}

/** 多选参数带强度的配置项（如 LoRA：名称 + 强度） */
export interface PluginLoraItem {
  name: string;
  strength: number;
}

/** 插件参数配置值：单值 / 多选字符串数组 / 多选带强度数组 */
export type PluginConfigValue = string | string[] | PluginLoraItem[];

export interface AppSettings {
  comfyui: {
    baseUrl: string;
  };
  agent?: AgentSettings;
  imageGen?: ImageGenSettings;
  storage?: StorageSettings;
  /** 生成插件（工作流）停用状态；参数配置保存在工作流 manifest */
  plugins?: {
    disabled: string[];
  };
}

export async function savePluginsSettings(
  disabled: string[],
): Promise<{
  ok: boolean;
  plugins: { disabled: string[] };
}> {
  return http('/api/settings/plugins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ disabled }),
  });
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
  /** 生成比例（如 16:9 / 智能） */
  ratio?: string;
  /** 生成尺寸（MP，如 1 / 1.5 / 8） */
  size?: number;
  /** 编辑历史 user 消息时，从该索引开始截断旧分支，再发送当前 message。 */
  replaceMessageIndex?: number;
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
    const errorText = await res.text().catch(() => i18n.t('api.networkError'));
    throw new Error(`HTTP ${res.status}: ${errorText}`);
  }

  if (!res.body) {
    throw new Error(i18n.t('api.streamUnsupported'));
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
        } else if (eventType === 'agent:reply_done') {
          onEvent({ type: 'agent:reply_done' });
        } else if (eventType === 'agent:status') {
          onEvent({ type: 'agent:status', status: parsed.status });
        } else if (eventType === 'agent:thinking') {
          onEvent({ type: 'agent:thinking', delta: parsed.delta });
        } else if (eventType === 'agent:response_policy') {
          onEvent({ type: 'agent:response_policy', policy: parsed.policy });
        } else if (eventType === 'agent:response_protocol') {
          onEvent({ type: 'agent:response_protocol', active: parsed.active === true });
        } else if (eventType === 'agent:text') {
          onEvent({ type: 'agent:text', delta: parsed.delta as string });
        } else if (eventType === 'agent:prompt') {
          onEvent({ type: 'agent:prompt', prompt: parsed.prompt as string });
        } else if (eventType === 'agent:route') {
          onEvent({ type: 'agent:route', route: parsed.route });
        } else if (eventType === 'agent:response_block') {
          onEvent({ type: 'agent:response_block', block: parsed.block });
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

export async function deleteSessions(ids: string[]): Promise<SessionsResponse> {
  return http('/api/sessions', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
}

export async function selectSession(id: string): Promise<{ ok: boolean; activeId: string | null }> {
  return http(`/api/sessions/${encodeURIComponent(id)}/select`, { method: 'POST' });
}

export async function fetchSessionMessages(id: string): Promise<ChatMessage[]> {
  return http(`/api/sessions/${encodeURIComponent(id)}/messages`);
}

/** 删除会话中的一条 user/assistant 消息；后端同时提升上下文版本。 */
export async function deleteSessionMessage(
  id: string,
  index: number,
): Promise<{ ok: boolean; messages: ChatMessage[] }> {
  return http(`/api/sessions/${encodeURIComponent(id)}/messages/${index}`, { method: 'DELETE' });
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
