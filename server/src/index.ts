import express from 'express';
import path from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateData, mockReply } from './mock.js';
import {
  COMFYUI_BASE_URL,
  checkHealth,
  getQueue,
  setComfyBaseUrl,
  uploadFile,
} from './comfyui.js';
import {
  readSettings,
  writeSettings,
  updateImageGenSettings,
  updateComfyUISettings,
  updateStorageSettings,
  updateAgentSettings,
  updatePluginsSettings,
  type ImageGenSettings,
  type AgentSettings,
} from './settings.js';
import {
  buildSpecsCached,
  invalidateComfyCaches,
  type WorkflowSpec,
} from './workflow.js';
import { cancelJob, subscribeJob, getJob, jobSnapshot } from './jobs.js';
import { ActivityRegistry } from './activity.js';
import { DraftStore, inferMimeType } from './drafts.js';
import { TaskQueue } from './tasks/queue.js';
import type { TaskItem } from './tasks/types.js';
import { createDirectorMCPServer, type McpServerInstance, type WorkflowRoute } from './mcp/server.js';
import { createWorkflowPluginRouter } from './workflow-plugin-api.js';
import { migrateLegacyPluginConfig } from './workflow-plugin-migration.js';
import { IMPORTED_WORKFLOWS_DIR, MANIFESTS_DIR, WORKFLOW_PLUGIN_DATA_DIR } from './workflow-plugin-store.js';
import { ensurePluginSkills, DEFAULT_PLUGIN_RESPONSE_POLICY, filterPluginGenerationArgs, pluginResponseAllows, readPluginResponsePolicy, PLUGIN_SKILLS_DIR, type PluginResponsePolicy } from './workflow-skill.js';
import { readPluginResponseProtocol, renderResponseBlocks, responseProtocolAllowsPrompt, syncPluginResponseProtocol, validatePluginResponseProtocol, type PluginResponseContext, type PluginResponseProtocol, type RenderedResponseBlock, type ResponseTiming } from './workflow-response.js';
import { listAgentModels, runAgentStream, buildAgentInput, generateConversationTitle, toolCallFingerprint, runPluginSkillChat, runPluginSkillCreator, type AgentStreamEvent } from './agent/bridge.js';
import {
  SessionError,
  appendMessage,
  createSession,
  deleteMessage,
  deleteSession,
  deleteSessions,
  renameSession,
  selectSession,
  sessionList,
  sessionMessages,
  truncateMessages,
  updateLastMessage,
  type StoredMessage,
} from './sessions.js';
import type { ChatReply } from './data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4777);

const app = express();
app.use(express.json({ limit: '50mb' }));

// Static assets (downloaded images)
app.use('/assets', express.static(path.resolve(__dirname, '../assets')));

/* ---------------- 统一任务队列与 MCP Server ---------------- */

const SETTINGS_FILE = path.resolve(__dirname, '../data/settings.json');
const TASKS_FILE = path.resolve(__dirname, '../data/tasks.json');
const SESSIONS_FILE = path.resolve(__dirname, '../data/sessions.json');
const DRAFTS_INDEX_FILE = path.resolve(__dirname, '../data/drafts.json');
const initialSettings = readSettings(SETTINGS_FILE);

// 将旧版全局 combo 配置一次性迁移到工作流 manifest；后续由节点视图维护。
// 在创建任务队列前完成，避免启动早期任务读取到旧配置或未迁移的 manifest。
await migrateLegacyPluginConfig(SETTINGS_FILE, {
  bundledDir: path.resolve(__dirname, '../workflows'),
  importedDir: IMPORTED_WORKFLOWS_DIR,
  manifestDir: MANIFESTS_DIR,
  introspect: async json => {
    const { introspectWorkflow } = await import('./workflow.js');
    return introspectWorkflow(json);
  },
}).catch(error => {
  console.error('[workflow-plugin-migration]', error);
});

// 为每个工作流插件（内置+导入）幂等补齐自动生成的 SKILL.md；
// 缺失才写入，不影响已有文件；失败不阻断启动。
const startupWorkflowSpecs = await buildSpecsCached();
await ensurePluginSkills(startupWorkflowSpecs);
for (const startupSpec of startupWorkflowSpecs) {
  try {
    syncPluginResponseProtocol(startupSpec, PLUGIN_SKILLS_DIR);
  } catch (error) {
    console.error(`[workflow-response] 生成 ${startupSpec.id} 失败:`, error);
  }
}

export const draftStore = new DraftStore({
  indexFile: DRAFTS_INDEX_FILE,
  outputDir: initialSettings.storage.outputDir,
});
export const taskQueue = new TaskQueue({
  dataFile: TASKS_FILE,
  settingsFile: SETTINGS_FILE,
  sessionsFile: SESSIONS_FILE,
  drafts: draftStore,
});

/** 启用插件（工作流）过滤：disabled 列表中的插件不参与生成 */
function isWorkflowEnabled(id: string): boolean {
  const disabled = readSettings(SETTINGS_FILE).plugins.disabled;
  return !disabled.includes(id);
}

function filterEnabledWorkflows(specs: WorkflowSpec[]): WorkflowSpec[] {
  return specs.filter(s => isWorkflowEnabled(s.id));
}

/** 按插件回复协议隐藏任务对象中的 prompt，避免从活动面板或产物元数据旁路泄漏。 */
function taskForResponse(task: TaskItem, policy: PluginResponsePolicy): TaskItem {
  if (pluginResponseAllows(policy, 'prompt')) return task;
  return {
    ...task,
    prompt: '',
    outputs: task.outputs?.map(output => output.generation
      ? { ...output, generation: { ...output.generation, prompt: '' } }
      : output),
  };
}

// 工作流插件导入、映射清单与节点候选 API
app.use(createWorkflowPluginRouter({
  catalog: {
    bundledDir: path.resolve(__dirname, '../workflows'),
    importedDir: IMPORTED_WORKFLOWS_DIR,
    manifestDir: MANIFESTS_DIR,
    introspect: async (json) => {
      const { introspectWorkflow } = await import('./workflow.js');
      return introspectWorkflow(json);
    },
  },
  dataRoot: WORKFLOW_PLUGIN_DATA_DIR,
  objectInfo: async () => (await import('./comfyui.js')).getObjectInfo(),
  isWorkflowEnabled,
  invalidate: invalidateComfyCaches,
  generateSkill: runPluginSkillCreator,
  chatSkill: runPluginSkillChat,
}));

/* ---------------- 会话素材标签解析（兜底 LLM 误传 @imageN/@videoN 标签） ---------------- */

// sessionId -> 素材标签（image1/video2，小写）-> 已上传到 ComfyUI 的真实文件名
const sessionAssetLabels = new Map<string, Map<string, string>>();
// 兜底：Agent 未传 sessionId 时，使用最近一次会话上传的素材映射
let latestSessionAssetLabels: Map<string, string> = new Map();
function resolveSessionAssetLabel(sessionId: string | undefined, label: string): string | undefined {
  const key = label.replace(/^@/, '').toLowerCase();
  if (sessionId) {
    const resolved = sessionAssetLabels.get(sessionId)?.get(key);
    if (resolved) return resolved;
  }
  return latestSessionAssetLabels.get(key);
}

function registerSessionAssetLabels(sid: string, assets: Array<{ name: string; filename: string }>): void {
  if (assets.length === 0) return;
  const map = new Map<string, string>();
  for (const asset of assets) map.set(asset.name.toLowerCase(), asset.filename);
  sessionAssetLabels.set(sid, map);
  latestSessionAssetLabels = map;
}

export const activityRegistry = new ActivityRegistry(taskQueue);
export const mcpServer: McpServerInstance = createDirectorMCPServer(
  taskQueue,
  isWorkflowEnabled,
  () => readSettings(SETTINGS_FILE).agent.pollTaskStatus,
  resolveSessionAssetLabel,
);

/**
 * 把聊天请求携带的图像/视频素材预上传到 ComfyUI input 目录。
 * name 是会话素材栏使用的 imageN/videoN，filename 是 Agent 提交任务时使用的文件名。
 */
async function uploadChatMedia(
  kind: 'image' | 'video',
  items: unknown,
): Promise<Array<{ name: string; filename: string }>> {
  if (!Array.isArray(items)) return [];
  const result: Array<{ name: string; filename: string }> = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as { name?: string; dataUrl?: string } | string | undefined;
    const fallback = `${kind}${i + 1}`;
    if (typeof item === 'string') {
      result.push({ name: item, filename: item });
      continue;
    }
    if (!item) {
      result.push({ name: fallback, filename: fallback });
      continue;
    }
    const name = item.name || fallback;
    const dataUrl = item.dataUrl;
    if (typeof dataUrl !== 'string') {
      result.push({ name, filename: name });
      continue;
    }
    const parsed = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
    if (!parsed) {
      result.push({ name, filename: name });
      continue;
    }
    const ext = name.includes('.')
      ? (name.split('.').pop() ?? (kind === 'image' ? 'png' : 'mp4'))
      : (kind === 'image' ? 'png' : 'mp4');
    try {
      const upRes = await uploadFile(kind, `chat-${Date.now()}-${i}.${ext}`, Buffer.from(parsed[2] ?? '', 'base64'));
      result.push({ name, filename: upRes.subfolder ? `${upRes.subfolder}/${upRes.name}` : upRes.name });
    } catch {
      result.push({ name, filename: name });
    }
  }
  return result;
}


/* ---------------- 会话（JSON 文件持久化，照搬 v1 方案） ---------------- */

/** 会话元信息列表 + 当前会话 id */
app.get('/api/sessions', (_req, res) => {
  res.json(sessionList(SESSIONS_FILE));
});

/** 批量删除会话 */
app.delete('/api/sessions', (req, res) => {
  const ids = Array.isArray(req.body?.ids)
    ? [...new Set(req.body.ids.filter((id: unknown): id is string => typeof id === 'string' && id.trim()))]
    : [];
  if (ids.length === 0) {
    res.status(400).json({ error: 'ids is required' });
    return;
  }
  try {
    ids.forEach(id => activityRegistry.cancelSession(id));
    const f = deleteSessions(SESSIONS_FILE, ids);
    res.json({
      sessions: f.sessions.map(s => ({ id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt })),
      activeId: f.activeId,
    });
  } catch (e) {
    if (e instanceof SessionError) { res.status(404).json({ error: e.message }); return; }
    throw e;
  }
});

/** 新建会话 */
app.post('/api/sessions', (_req, res) => {
  const f = createSession(SESSIONS_FILE);
  res.json({
    sessions: f.sessions.map(s => ({ id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt })),
    activeId: f.activeId,
  });
});

/** 重命名会话 */
app.patch('/api/sessions/:id', (req, res) => {
  try {
    const title = typeof req.body?.title === 'string' ? req.body.title : '';
    const f = renameSession(SESSIONS_FILE, req.params.id, title);
    res.json({ ok: true, sessions: f.sessions.map(s => ({ id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt })), activeId: f.activeId });
  } catch (e) {
    if (e instanceof SessionError) { res.status(404).json({ error: e.message }); return; }
    throw e;
  }
});

/** 删除会话 */
app.delete('/api/sessions/:id', (req, res) => {
  try {
    activityRegistry.cancelSession(req.params.id);
    const f = deleteSession(SESSIONS_FILE, req.params.id);
    res.json({
      sessions: f.sessions.map(s => ({ id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt })),
      activeId: f.activeId,
    });
  } catch (e) {
    if (e instanceof SessionError) { res.status(404).json({ error: e.message }); return; }
    throw e;
  }
});

/** 切换当前会话 */
app.post('/api/sessions/:id/select', (req, res) => {
  try {
    const f = selectSession(SESSIONS_FILE, req.params.id);
    res.json({ ok: true, activeId: f.activeId });
  } catch (e) {
    if (e instanceof SessionError) { res.status(404).json({ error: e.message }); return; }
    throw e;
  }
});

/** 会话消息（刷新恢复历史） */
app.get('/api/sessions/:id/messages', (req, res) => {
  try {
    res.json(sessionMessages(SESSIONS_FILE, req.params.id));
  } catch (e) {
    if (e instanceof SessionError) { res.status(404).json({ error: e.message }); return; }
    throw e;
  }
});

/** 终止活动会话，并联动取消该会话的未完成生成任务 */
app.post('/api/sessions/:id/cancel', (req, res) => {
  const id = req.params.id;
  const knownSession = sessionList(SESSIONS_FILE).sessions.some(session => session.id === id);
  const hasTask = taskQueue.list().some(task => task.sessionId === id && (task.status === 'queued' || task.status === 'running'));
  if (!knownSession && !activityRegistry.getSession(id) && !hasTask) {
    res.status(404).json({ error: `会话不存在: ${id}` });
    return;
  }
  const canceledTasks = activityRegistry.cancelSession(id);
  res.json({ ok: true, sessionId: id, canceledTaskIds: canceledTasks.map(task => task.id) });
});

/** 运行中会话事件流：刷新后的客户端可回放并继续订阅同一轮 Agent 输出 */
app.get('/api/sessions/:id/events', (req, res) => {
  if (!activityRegistry.getSession(req.params.id)) {
    res.status(404).json({ error: 'session is not running' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const parsedAfter = Number(req.query.after ?? 0);
  const afterSequence = Number.isFinite(parsedAfter) && parsedAfter >= 0 ? parsedAfter : 0;
  let closed = false;
  let unsubscribe: () => void = () => undefined;
  const send = (envelope: { sequence: number; event: Record<string, unknown> }) => {
    if (closed) return;
    res.write(`id: ${envelope.sequence}\nevent: session:event\ndata: ${JSON.stringify(envelope)}\n\n`);
    if (envelope.event.type === 'agent:end') {
      closed = true;
      unsubscribe();
      res.end();
    }
  };
  unsubscribe = activityRegistry.subscribeSession(req.params.id, send, afterSequence);
  if (closed) unsubscribe();
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15_000);

  req.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  });
});

/** 更新会话最后一条消息（SSE 终态落库：done/error/cancelled） */
app.post('/api/sessions/:id/messages/last', (req, res) => {
  try {
    const body = req.body ?? {};
    const msg: StoredMessage = {
      role: body.role === 'user' ? 'user' : 'assistant',
      content: typeof body.content === 'string' ? body.content : '',
      thinking: typeof body.thinking === 'string' ? body.thinking : undefined,
      thinkingDurationMs: typeof body.thinkingDurationMs === 'number' ? body.thinkingDurationMs : undefined,
      status: typeof body.status === 'string' ? body.status : undefined,
      toolCalls: Array.isArray(body.toolCalls) ? body.toolCalls : undefined,
      tasks: Array.isArray(body.tasks) ? body.tasks : undefined,
      actionCards: Array.isArray(body.actionCards) ? body.actionCards : undefined,
      stages: Array.isArray(body.stages) ? body.stages : undefined,
      routes: Array.isArray(body.routes) ? body.routes : undefined,
      generationPrompts: Array.isArray(body.generationPrompts) ? body.generationPrompts : undefined,
      responseBlocks: Array.isArray(body.responseBlocks) ? body.responseBlocks : undefined,
      responseProtocolActive: body.responseProtocolActive === true ? true : undefined,
      jobId: typeof body.jobId === 'string' ? body.jobId : undefined,
    };
    updateLastMessage(SESSIONS_FILE, req.params.id, msg);
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof SessionError) { res.status(404).json({ error: e.message }); return; }
    throw e;
  }
});

/** 删除一条用户或助手消息；删除后后续 Agent 只使用剩余可见消息重建上下文。 */
app.delete('/api/sessions/:id/messages/:index', (req, res) => {
  try {
    const f = deleteMessage(SESSIONS_FILE, req.params.id, Number(req.params.index));
    const session = f.sessions.find(item => item.id === req.params.id);
    res.json({ ok: true, messages: session?.messages ?? [] });
  } catch (e) {
    if (e instanceof SessionError) {
      res.status(e.code === 'MESSAGE_NOT_FOUND' ? 400 : 404).json({ error: e.message });
      return;
    }
    throw e;
  }
});

/* ---------------- 页面数据 ---------------- */

app.get('/api/generate', (_req, res) => {
  res.json(generateData);
});

/* ---------------- ComfyUI 对接 ---------------- */

/** ComfyUI 连接状态 + 队列 */
app.get('/api/comfyui/status', async (_req, res) => {
  const health = await checkHealth();
  if (!health.connected) {
    res.json({ ...health, queue: null });
    return;
  }
  const queue = await getQueue();
  res.json({
    ...health,
    queue: {
      running: queue.queue_running.length,
      pending: queue.queue_pending.length,
    },
  });
});

/** workflow 列表（introspection 自动识别输入/参数/输出，仅启用中的插件） */
app.get('/api/workflows', async (_req, res) => {
  const specs = filterEnabledWorkflows(await buildSpecsCached());
  res.json(
    specs.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      inputs: s.inputs,
      params: s.params,
      outputs: s.outputs,
    })),
  );
});

/** 活动会话与生成任务快照 */
app.get('/api/activity', (_req, res) => {
  res.json(activityRegistry.snapshot());
});

/** 活动会话与生成任务实时事件流 */
app.get('/api/activity/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event: unknown) => {
    res.write(`event: activity\ndata: ${JSON.stringify(event)}\n\n`);
  };
  send({ type: 'snapshot', snapshot: activityRegistry.snapshot() });
  const unsubscribe = activityRegistry.subscribe(send);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

/** 生成任务实时事件流（SSE） */
app.get('/api/generate/:jobId/events', (req, res) => {
  const job = getJob(taskQueue, req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'job not found' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');

  const send = (evt: unknown) => {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  };
  const unsubscribe = subscribeJob(taskQueue, req.params.jobId, send);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

/** 任务快照（供重连/轮询） */
app.get('/api/generate/:jobId', (req, res) => {
  const job = getJob(taskQueue, req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'job not found' });
    return;
  }
  res.json(jobSnapshot(job));
});

/** 取消生成 */
app.post('/api/generate/:jobId/cancel', async (req, res) => {
  const ok = await cancelJob(taskQueue, req.params.jobId);
  res.json({ ok });
});

/** 代理 ComfyUI /view（本地/远程统一走这里，避免 CORS） */
app.get('/comfyui/view', async (req, res) => {
  const { filename, subfolder = '', type = 'output' } = req.query;
  if (typeof filename !== 'string' || !filename) {
    res.status(400).json({ error: 'filename is required' });
    return;
  }
  const p = new URLSearchParams({ filename, type: String(type) });
  if (subfolder) p.set('subfolder', String(subfolder));
  try {
    const upstream = await fetch(`${COMFYUI_BASE_URL}/view?${p.toString()}`);
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `ComfyUI /view 返回 ${upstream.status}` });
      return;
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    const upstreamType = upstream.headers.get('content-type');
    const contentType = upstreamType && !/^application\/octet-stream(?:;|$)/i.test(upstreamType)
      ? upstreamType
      : inferMimeType(filename) ?? upstreamType ?? 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(buf);
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

/* ---------------- 设置（JSON 文件持久化，照搬 v1 方案） ---------------- */

// 启动时从文件恢复 ComfyUI 地址（环境变量仍可覆盖）
const savedSettings = readSettings(SETTINGS_FILE);
if (!process.env.COMFYUI_BASE_URL) {
  try {
    setComfyBaseUrl(savedSettings.comfyui.baseUrl);
  } catch {
    /* 使用默认值 */
  }
}

/** 当前设置（前端设置弹窗初始化用） */
app.get('/api/settings', (_req, res) => {
  const current = readSettings(SETTINGS_FILE);
  res.json({
    comfyui: { baseUrl: COMFYUI_BASE_URL },
    agent: current.agent,
    imageGen: current.imageGen,
    storage: current.storage,
    plugins: { disabled: current.plugins.disabled },
  });
});

/** Agent 模型列表：设置弹窗按需从当前 Pi 配置读取 */
app.get('/api/agent/models', async (_req, res) => {
  res.json({ models: await listAgentModels() });
});

/** 更新 Agent 默认模型、thinking 强度与虚构对话历史 */
app.post('/api/settings/agent', (req, res) => {
  try {
    const partial: Partial<AgentSettings> = {
      model: typeof req.body?.model === 'string' ? req.body.model : undefined,
      thinking: typeof req.body?.thinking === 'string' ? req.body.thinking as AgentSettings['thinking'] : undefined,
      pollTaskStatus: typeof req.body?.pollTaskStatus === 'boolean' ? req.body.pollTaskStatus : undefined,
      fabricatedHistory: Array.isArray(req.body?.fabricatedHistory) ? req.body.fabricatedHistory : undefined,
    };
    const updated = updateAgentSettings(SETTINGS_FILE, partial);
    res.json({ ok: true, agent: updated.agent });
  } catch (e) {
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

/** 更新生图默认设置 */
app.post('/api/settings/image-gen', (req, res) => {
  try {
    const partial = req.body as Partial<ImageGenSettings>;
    const updated = updateImageGenSettings(SETTINGS_FILE, partial);
    res.json({ ok: true, imageGen: updated });
  } catch (e) {
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

/** 更新生成插件（工作流）停用状态；combo 参数已迁移到工作流 manifest */
app.post('/api/settings/plugins', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const specs = await buildSpecsCached();
    const known = new Set(specs.map(s => s.id));

    const requested: string[] = Array.isArray(body.disabled)
      ? body.disabled.filter((id: unknown): id is string => typeof id === 'string')
      : [];
    const disabled = requested.filter(id => known.has(id));

    const updated = updatePluginsSettings(SETTINGS_FILE, { disabled, config: {} });
    res.json({ ok: true, plugins: updated.plugins });
  } catch (e) {
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

/** 更新产物存储目录：持久化并检查目录可写 */
app.post('/api/settings/storage', (req, res) => {
  const outputDir = typeof req.body?.outputDir === 'string' ? req.body.outputDir : '';
  try {
    const candidate = new DraftStore({ indexFile: DRAFTS_INDEX_FILE, outputDir });
    if (!candidate.isWritable()) throw new Error('产物存储目录不可写');
    const updated = updateStorageSettings(SETTINGS_FILE, { outputDir });
    draftStore.setOutputDir(updated.storage.outputDir);
    res.json({ ok: true, storage: updated.storage });
  } catch (e) {
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

/** 当前草稿列表 */
app.get('/api/drafts', (_req, res) => {
  res.json({ drafts: draftStore.list().map(({ path: _path, ...draft }) => draft) });
});

/** 读取草稿文件 */
app.get('/api/drafts/:id/file', (req, res) => {
  const draft = draftStore.get(req.params.id);
  if (!draft || !existsSync(draft.path)) {
    res.status(404).json({ error: 'draft not found' });
    return;
  }
  res.setHeader('Content-Type', draftStore.contentType(draft.id) ?? 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  createReadStream(draft.path).pipe(res);
});

/** 删除草稿 */
app.delete('/api/drafts/:id', (req, res) => {
  if (!draftStore.delete(req.params.id)) {
    res.status(404).json({ error: 'draft not found' });
    return;
  }
  res.json({ ok: true });
});

/** 在系统文件管理器中打开草稿文件所在位置 */
app.post('/api/drafts/:id/open-location', (req, res) => {
  const draft = draftStore.get(req.params.id);
  if (!draft) {
    res.status(404).json({ error: 'draft not found' });
    return;
  }
  try {
    openFileLocation(draft.path);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

/** 跨平台调用系统文件管理器定位文件（explorer / open -R / xdg-open） */
function openFileLocation(filePath: string): void {
  const platform = process.platform;
  if (platform === 'win32') {
    spawn('explorer', ['/select,' + filePath], { detached: true, stdio: 'ignore' }).unref();
  } else if (platform === 'darwin') {
    spawn('open', ['-R', filePath], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [path.dirname(filePath)], { detached: true, stdio: 'ignore' }).unref();
  }
}

/** 更新 ComfyUI 地址：持久化到文件 + 清空缓存 + 健康检查 */
app.post('/api/settings/comfyui', async (req, res) => {
  const baseUrl = typeof req.body?.baseUrl === 'string' ? req.body.baseUrl : '';
  try {
    const next = setComfyBaseUrl(baseUrl);
    updateComfyUISettings(SETTINGS_FILE, { baseUrl: next });
    invalidateComfyCaches();
    const status = await checkHealth();
    res.json({ ok: true, baseUrl: next, connected: status.connected, status });
  } catch (e) {
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

/* ---------------- MCP HTTP 协议端点 ---------------- */

app.post('/api/mcp', async (req, res) => {
  try {
    const jsonRpcRes = await mcpServer.handleRpcMessage(req.body);
    res.json(jsonRpcRes);
  } catch (err: any) {
    res.status(500).json({
      jsonrpc: '2.0',
      id: req.body?.id ?? null,
      error: { code: -32603, message: `Internal server error: ${err?.message || String(err)}` },
    });
  }
});

/* ---------------- 统一任务 API (/api/tasks) ---------------- */

/** 获取所有任务列表 */
app.get('/api/tasks', (_req, res) => {
  res.json({ tasks: taskQueue.listTasks() });
});

/** 获取单个任务详情 */
app.get('/api/tasks/:id', (req, res) => {
  const task = taskQueue.getTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  res.json({ task });
});

/** 取消任务 */
app.post('/api/tasks/:id/cancel', (req, res) => {
  const task = taskQueue.cancelTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  res.json({ ok: true, task });
});

/** 单个任务的独立 SSE 事件流 */
app.get('/api/tasks/:id/events', (req, res) => {
  const task = taskQueue.getTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const sendEvent = (event: string, data: any) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // 初始推送当前快照
  sendEvent('task:snapshot', task);

  if (task.status === 'completed' || task.status === 'failed' || task.status === 'canceled') {
    res.end();
    return;
  }

  const unsubscribe = taskQueue.subscribeTask(task.id, (event, updatedTask) => {
    if (event === 'updated') {
      sendEvent('task:updated', updatedTask);
    } else if (event === 'completed') {
      sendEvent('task:completed', updatedTask);
      res.end();
    } else if (event === 'failed') {
      sendEvent('task:failed', updatedTask);
      res.end();
    } else if (event === 'canceled') {
      sendEvent('task:canceled', updatedTask);
      res.end();
    }
  });

  req.on('close', () => {
    unsubscribe();
  });
});


/* ---------------- 生成对话（对接 ComfyUI 的 /api/chat） ---------------- */

interface UploadPayload {
  name?: string;
  dataUrl?: string;
}

/** 生成回复：thinking 日志 + 任务卡（实时进度走 SSE） */
async function generateReply(
  message: string,
  opts: {
    workflowId?: string;
    params?: Record<string, unknown>;
    images?: UploadPayload[];
    videos?: UploadPayload[];
    sessionId?: string;
    ratio?: string;
    size?: number;
  },
): Promise<ChatReply> {
  const title = message.slice(0, 12) + (message.length > 12 ? '…' : '');
  const workflows = filterEnabledWorkflows(await buildSpecsCached());
  if (!workflows.length) {
    return {
      title,
      stages: [{ type: 'error', logs: ['没有可用的 workflow：请把 workflow_api.json 放到 server/workflows/ 目录'] }],
    };
  }

  // 选 workflow：显式指定 → 否则优先选不需要上传素材的（避免默认选中强制依赖参考图的工作流）
  let spec: WorkflowSpec | null = workflows.find(w => w.id === opts.workflowId) ?? null;
  if (!spec) {
    spec =
      workflows.find(w => !w.inputs.some(i => i.kind !== 'text')) ??
      workflows.find(w => w.outputs.some(o => o.kind === 'image')) ??
      workflows[0] ??
      null;
  }
  if (!spec) {
    return {
      title,
      stages: [{ type: 'error', logs: ['没有可用的 workflow：请把 workflow_api.json 放到 server/workflows/ 目录'] }],
    };
  }

  const health = await checkHealth();
  if (!health.connected) {
    return {
      title,
      stages: [
        {
          type: 'error',
          logs: [
            `无法连接 ComfyUI（${health.baseUrl}）。`,
            '请先启动 ComfyUI，或在 server 目录配置环境变量 COMFYUI_BASE_URL 指向你的实例（本地或远程均可）。',
            health.error ? `详情：${health.error}` : '',
          ].filter(Boolean),
        },
      ],
    };
  }

  const logs: string[] = [`已加载工作流「${spec.name}」`];
  if (spec.inputs.some(i => i.kind !== 'text')) {
    logs.push(
      `工作流输入：${spec.inputs
        .filter(i => i.kind !== 'text')
        .map(i => `${i.label}（${i.kind === 'image' ? '图像' : '视频'}）`)
        .join('、') || '无'}`,
    );
  }
  if (spec.outputs.length) {
    const kindLabel = { image: '图片', video: '视频', text: '文本' };
    logs.push(
      `工作流输出：${spec.outputs.map(o => `${o.label}（${kindLabel[o.kind]}）`).join('、')}`,
    );
  }

  // 校验必填素材输入
  const requiredImages = spec.inputs.filter(i => i.kind === 'image' && (i.required || !String(i.defaultValue ?? '').trim()));
  const requiredVideos = spec.inputs.filter(i => i.kind === 'video' && (i.required || !String(i.defaultValue ?? '').trim()));
  if (requiredImages.length && (opts.images?.length ?? 0) < requiredImages.length) {
    return {
      title,
      stages: [
        {
          type: 'error',
          logs: [
            `这个工作流需要 ${requiredImages.length} 张参考图${requiredImages.length > 1 ? '（按顺序对应）' : ''}，请先上传后再发送。`,
          ],
        },
      ],
    };
  }
  if (requiredVideos.length && (opts.videos?.length ?? 0) < requiredVideos.length) {
    return {
      title,
      stages: [{ type: 'error', logs: ['这个工作流需要输入视频，请先上传视频再发送。'] }],
    };
  }

  try {
    logs.push('任务已加入项目生成队列，等待统一调度…');
    const task = taskQueue.submit({
      workflowId: spec.id,
      prompt: message,
      params: opts.params,
      sessionId: opts.sessionId,
      ratio: opts.ratio,
      size: opts.size,
      imageUploads: opts.images?.filter((item): item is UploadPayload & { dataUrl: string } => typeof item.dataUrl === 'string'),
      videoUploads: opts.videos?.filter((item): item is UploadPayload & { dataUrl: string } => typeof item.dataUrl === 'string'),
    });

    const stages: ChatReply['stages'] = [
      { type: 'thinking', logs },
      {
        type: 'task',
        progress: { completed: 0, total: 1 },
        taskLabel: `${spec.outputs.some(o => o.kind === 'video') ? '视频' : '图片'}生成中…`,
        queued: true,
        queueLabel: '项目队列统一调度中',
      },
    ];

    return {
      title,
      reply: `已提交生成任务（工作流：${spec.name}），完成后可直接查看结果。`,
      jobId: task.id,
    };
  } catch (e) {
    return {
      title,
      stages: [{ type: 'error', logs: [`生成失败：${(e as Error).message}`] }],
    };
  }
}

app.post('/api/chat', async (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message : '';
  if (!message.trim()) {
    res.status(400).json({ error: 'message is required' });
    return;
  }
  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : null;
  const replaceMessageIndex = typeof req.body?.replaceMessageIndex === 'number' && Number.isInteger(req.body.replaceMessageIndex)
    ? req.body.replaceMessageIndex
    : undefined;
  if (replaceMessageIndex !== undefined) {
    if (!sessionId) {
      res.status(400).json({ error: '编辑历史消息需要有效的 sessionId' });
      return;
    }
    try {
      // 原子地删除被编辑消息及其全部后续内容；下面 appendMessage 会把新文本写成当前轮 user 消息。
      truncateMessages(SESSIONS_FILE, sessionId, replaceMessageIndex);
    } catch (e) {
      if (e instanceof SessionError) {
        res.status(e.code === 'SESSION_NOT_FOUND' ? 404 : 400).json({ error: e.message });
        return;
      }
      throw e;
    }
  }

  const isStream = req.headers.accept === 'text/event-stream' || req.query.stream === 'true' || req.body?.stream === true;

  // v1 时序：先建立 SSE，让浏览器立即进入流式读取，再做同步会话落盘。
  if (isStream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
  }

  // 1. 用户消息落库（会话不存在时自动创建）
  const append = appendMessage(SESSIONS_FILE, sessionId, { role: 'user', content: message.trim() });
  const sid = append.sessionId;

  // 会话首条消息时，后台用 LLM 生成对话标题（不阻塞主流程；失败保留截断标题）
  const initialTitle = append.file.sessions.find(s => s.id === sid)?.title ?? '';
  const isFirstMessage = (append.file.sessions.find(s => s.id === sid)?.messages.length ?? 0) === 1;
  if (isFirstMessage) {
    void autoTitleSession(sid, message.trim(), initialTitle);
  }

  // 虚构对话历史：只要有配置就**每个请求**都注入（参考 custom-first-control-prompt 的
  // “every request re-injects it”设计——种子消息只在请求路径上，不写入会话日志，
  // 因此必须每次请求都重新前置注入，否则后续轮次模型从 session 恢复的历史中
  // 看不到种子，准则/参考对话会“遗忘”；每次注入字节级一致，保持前缀缓存复用）。
  // 消息被删除后，切换到无持久化 Pi 会话，并把删除后的可见历史按请求注入，
  // 从根上避免被删除内容继续留在 Agent 的隐式上下文中。
  const fabricatedHistory = readSettings(SETTINGS_FILE).agent.fabricatedHistory;
  const sessionAfterAppend = append.file.sessions.find(item => item.id === sid);
  const contextVersion = sessionAfterAppend?.contextVersion ?? 0;
  const contextHistory = contextVersion > 0
    ? (sessionAfterAppend?.messages ?? []).slice(0, -1)
        .filter(item => typeof item.content === 'string' && item.content.trim())
        .map(item => ({ role: item.role, content: item.content }))
    : undefined;

  if (isStream) {

    let fullThinking = '';
    let pendingThinking = '';
    let fullText = '';
    const fullToolCalls: Array<Record<string, unknown>> = [];
    let responsePolicy: PluginResponsePolicy = { ...DEFAULT_PLUGIN_RESPONSE_POLICY };
    let responsePolicyActive = false;
    let responseProtocol: PluginResponseProtocol | null = null;
    let responseSpec: WorkflowSpec | undefined;
    let responseArgs: Record<string, unknown> | undefined;
    let responseRoute: WorkflowRoute | undefined;
    let pendingGeneration: { tool: NonNullable<AgentStreamEvent['tool']>; record: Record<string, unknown> } | null = null;
    const seenToolCalls = new Set<string>();
    const fullRoutes: WorkflowRoute[] = [];
    const generationPrompts: string[] = [];
    const responseBlocks = new Map<string, RenderedResponseBlock>();
    const sessionTasks = new Map<string, TaskItem>();
    const taskUnsubscribes: Array<() => void> = [];
    const agentController = new AbortController();
    let agentDone = false;
    let activeTaskCount = 0;
    let responseEnded = false;
    let responseConnected = true;
    let runFinalized = false;
    let unsubscribeResponse: () => void = () => undefined;
    const workflowSpecs = await buildSpecsCached();
    activityRegistry.startSession(sid, message.trim(), agentController);

    const publishEvent = (type: string, data: Record<string, unknown> = {}) => {
      activityRegistry.publishSessionEvent(sid, { type, ...data });
    };
    const sendEvent = (type: string, data: Record<string, unknown> = {}) => {
      publishEvent(type, data);
    };
    const flushThinking = () => {
      if (!pendingThinking) return;
      if (responseProtocol && !responseProtocol.thinking.enabled) {
        pendingThinking = '';
        return;
      }
      fullThinking += pendingThinking;
      if (responseProtocol) {
        if (responseProtocol.thinking.enabled) {
          const block: RenderedResponseBlock = {
            id: '__thinking__',
            type: 'thinking',
            content: fullThinking,
            container: responseProtocol.thinking.container,
            format: responseProtocol.thinking.format,
            defaultOpen: responseProtocol.thinking.defaultOpen,
            language: responseProtocol.thinking.language,
            timing: 'always',
          };
          responseBlocks.set(block.id, block);
          sendEvent('agent:response_block', { block });
        }
      } else if (pluginResponseAllows(responsePolicy, 'thinking')) {
        sendEvent('agent:thinking', { delta: pendingThinking });
      }
      pendingThinking = '';
    };
    const contextFor = (
      spec: WorkflowSpec,
      args: Record<string, unknown>,
      route?: WorkflowRoute,
      task?: TaskItem,
      status?: string,
    ): PluginResponseContext => {
      const rawParams = args.params && typeof args.params === 'object' ? args.params as Record<string, unknown> : {};
      const manifestDefaults = Object.fromEntries(
        spec.params.filter(item => !item.hidden && item.llm !== false).map(item => [item.id, item.default]),
      );
      const effectiveParams = task?.generationParams && typeof task.generationParams === 'object'
        ? { ...manifestDefaults, ...rawParams, ...task.generationParams }
        : { ...manifestDefaults, ...rawParams };
      const input: Record<string, unknown> = {};
      const primary = spec.inputs.find(item => !item.hidden && item.kind === 'text' && item.primary)
        ?? spec.inputs.find(item => !item.hidden && item.kind === 'text');
      if (primary && typeof args.prompt === 'string') input[primary.id] = args.prompt;
      const param: Record<string, unknown> = {};
      for (const item of spec.params) {
        if (item.hidden || item.llm === false) continue;
        const value = effectiveParams[item.id] !== undefined ? effectiveParams[item.id] : effectiveParams[item.field];
        if (value !== undefined) param[item.id] = value;
      }
      const negative = spec.params.find(item => !item.hidden && item.llm !== false && /负面|反面|negative/i.test(`${item.label} ${item.description ?? ''}`));
      return {
        plugin: { name: spec.name, description: spec.description },
        input,
        param,
        generation: {
          prompt: args.prompt,
          negativePrompt: negative ? param[negative.id] : undefined,
          workflowName: spec.name,
          intent: route?.intent,
        },
        route: {
          requestedWorkflow: route?.requestedWorkflowId,
          finalWorkflow: route?.finalWorkflowId,
          reason: route?.reason,
        },
        result: {
          count: task?.outputs?.length,
          types: task?.outputs?.map(output => output.kind).join(', '),
          status: status ?? task?.status,
        },
        assistant: { reply: fullText },
      };
    };
    const emitResponseBlocks = (timing: ResponseTiming, context: PluginResponseContext) => {
      if (!responseProtocol) return;
      for (const block of renderResponseBlocks(responseProtocol, context, timing)) {
        responseBlocks.set(block.id, block);
        sendEvent('agent:response_block', { block });
      }
    };
    const presentGenerationCall = (route?: WorkflowRoute, requestedWorkflowId?: string) => {
      const generation = pendingGeneration;
      if (!generation) return;
      const finalWorkflowId = route?.finalWorkflowId || requestedWorkflowId;
      responsePolicy = finalWorkflowId ? readPluginResponsePolicy(finalWorkflowId) : { ...DEFAULT_PLUGIN_RESPONSE_POLICY };
      responsePolicyActive = true;
      const selectedSpec = finalWorkflowId ? workflowSpecs.find(spec => spec.id === finalWorkflowId) : undefined;
      const savedProtocol = finalWorkflowId ? readPluginResponseProtocol(finalWorkflowId, PLUGIN_SKILLS_DIR) : null;
      responseProtocol = selectedSpec && savedProtocol && validatePluginResponseProtocol(savedProtocol, selectedSpec).length === 0
        ? savedProtocol
        : null;
      responseSpec = selectedSpec;
      responseArgs = generation.tool.args;
      responseRoute = route;
      if (responseProtocol && selectedSpec && !responseProtocolAllowsPrompt(responseProtocol, selectedSpec)) {
        responsePolicy = { ...responsePolicy, prompt: 'hidden' };
      }
      activityRegistry.setSessionResponsePolicy(sid, responsePolicy);
      if (responseProtocol) sendEvent('agent:response_protocol', { active: true });
      else sendEvent('agent:response_policy', { policy: responsePolicy });
      flushThinking();
      const args = responseProtocol
        ? filterPluginGenerationArgs(generation.tool.args, { ...responsePolicy, prompt: 'hidden' })
        : filterPluginGenerationArgs(generation.tool.args, responsePolicy);
      generation.record.args = args;
      sendEvent('tool:call', {
        callId: generation.tool.id,
        name: generation.tool.name,
        args,
      });
      const prompt = typeof generation.tool.args.prompt === 'string' ? generation.tool.args.prompt.trim() : '';
      if (responseProtocol && selectedSpec) {
        emitResponseBlocks('submit', contextFor(selectedSpec, generation.tool.args, route));
      } else {
        if (prompt && pluginResponseAllows(responsePolicy, 'prompt')) {
          if (!generationPrompts.includes(prompt)) generationPrompts.push(prompt);
          sendEvent('agent:prompt', { prompt });
        }
        if (route && pluginResponseAllows(responsePolicy, 'route') && !fullRoutes.some(item => item.taskId === route.taskId)) {
          fullRoutes.push(route);
          sendEvent('agent:route', { route });
        }
      }
      pendingGeneration = null;
    };
    unsubscribeResponse = activityRegistry.subscribeSession(sid, ({ event }) => {
      if (!responseConnected || responseEnded) return;
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    publishEvent('agent:started', { sessionId: sid });

    const cleanupAndEnd = () => {
      if (runFinalized || !agentDone || (!agentController.signal.aborted && activeTaskCount > 0)) return;
      runFinalized = true;
      const canceled = agentController.signal.aborted;
      const stages = canceled ? [{ type: 'error', logs: ['对话已终止'] }] : undefined;
      appendMessage(SESSIONS_FILE, sid, {
        role: 'assistant',
        content: fullText || (canceled ? '对话已终止。' : ''),
        thinking: fullThinking || undefined,
        toolCalls: fullToolCalls.length ? fullToolCalls : undefined,
        tasks: sessionTasks.size ? [...sessionTasks.values()] : undefined,
        routes: fullRoutes.length ? fullRoutes : undefined,
        generationPrompts: generationPrompts.length ? generationPrompts : undefined,
        responseBlocks: responseBlocks.size ? [...responseBlocks.values()] : undefined,
        responseProtocolActive: responseProtocol ? true : undefined,
        responsePolicy: responsePolicyActive ? responsePolicy : undefined,
        stages,
      });
      publishEvent('agent:end', { sessionId: sid, canceled });
      activityRegistry.finishSession(sid, canceled ? 'canceled' : 'completed');
      taskUnsubscribes.forEach(unsub => unsub());
      unsubscribeResponse();
      if (responseConnected && !responseEnded && !res.writableEnded) {
        responseEnded = true;
        res.end();
      }
    };

    res.on('close', () => {
      responseConnected = false;
      unsubscribeResponse();
    });

    const mcpUrl = mcpServer.getUrl() || `http://127.0.0.1:${PORT}/api/mcp`;
    const reqRatio = typeof req.body?.ratio === 'string' ? req.body.ratio.trim() : undefined;
    const reqSize =
      typeof req.body?.size === 'number' && Number.isFinite(req.body.size) && req.body.size > 0
        ? req.body.size
        : undefined;
    // 预上传用户 @ 提及的会话素材，把素材名与 ComfyUI 文件名暴露给 Agent。
    const chatImages = await uploadChatMedia('image', req.body?.images);
    const chatVideos = await uploadChatMedia('video', req.body?.videos);
    // 注册素材标签映射，供 generation.submit 兜底解析 Agent 误传的 @imageN/@videoN 标签。
    registerSessionAssetLabels(sid, [...chatImages, ...chatVideos]);
    const agentInput = buildAgentInput({
      message: message.trim(),
      images: chatImages.length > 0 ? chatImages : undefined,
      videos: chatVideos.length > 0 ? chatVideos : undefined,
    });
    const agentSystemPrompt = [
      '你运行在「Minidream」中。生成结果（图片/视频）会自动展示在用户界面中，',
      '不要向用户报告内部文件名、存储路径、接口地址或任务 ID 等实现细节，',
      '工作流选择与参数回答规则见 director-copilot skill：询问可用工作流或可调参数时必须先调用 workflow.list，',
      '选定工作流后必须调用 workflow.skill 获取该插件的完整使用规则，并把该插件 Skill 的回复协议作为当前请求的唯一用户可见格式来源；不要套用通用的 prompt/路由/状态输出顺序。',
      '插件 Skill 负责 MCP 调用和正文语义；如果存在 response.json，回复协议编辑器控制结构化展示，不改变 MCP 工具安全边界、任务队列或气泡外产物规则。',
      '只介绍清单中真实存在的参数及其 description，不得凭通用知识补充未配置的参数。',
      '不要在正文中输出“正在适配工作流”“正在提交任务”“生成中”等无意义状态句；工具调用和任务进度由界面结构化处理。',
      '每次用户请求最多调用一次 generation.submit；提交成功后不要重复提交相同任务。',
      '如果生成进度由界面事件流自动展示，不要调用 generation.status 轮询。',
      '若用户指令中以 @imageN 或 @videoN 提及会话素材（【参考图片】/【参考视频】中对应名称），图生图/图生视频时必须按序传入对应文件名。',
      '图像放大/超分/高清化必须使用带参考图的 SeedVR2 图像放大工作流；后端会对参考图与放大意图执行确定性路由。',
    ].join('\n');

    try {
      await runAgentStream(agentInput, {
        // 删除过消息的会话不再复用旧 Pi session；否则旧消息虽从 JSON 删除，仍会被 Pi 恢复。
        sessionId: contextVersion > 0 ? undefined : sid,
        contextHistory,
        rebuildContext: contextVersion > 0,
        signal: agentController.signal,
        mcpServerUrl: mcpUrl,
        seedHistory: fabricatedHistory.length > 0 ? fabricatedHistory : undefined,
        systemPrompt: agentSystemPrompt,
        model: typeof req.body?.agentModel === 'string' && req.body.agentModel.trim()
          ? req.body.agentModel.trim()
          : readSettings(SETTINGS_FILE).agent.model || undefined,
        thinking: typeof req.body?.thinking === 'string' && req.body.thinking.trim()
          ? req.body.thinking
          : readSettings(SETTINGS_FILE).agent.thinking,
        onEvent: (evt: AgentStreamEvent) => {
          if (evt.type === 'status') {
            sendEvent('agent:status', { status: evt.status });
          } else if (evt.type === 'thinking') {
            pendingThinking += evt.delta || '';
          } else if (evt.type === 'text') {
            fullText += evt.delta || '';
            sendEvent('agent:text', { delta: evt.delta });
          } else if (evt.type === 'tool_call') {
            const tool = evt.tool;
            if (!tool) return;
            const callFingerprint = toolCallFingerprint(tool);
            if (seenToolCalls.has(callFingerprint)) return;
            seenToolCalls.add(callFingerprint);
            const record: Record<string, unknown> = {
              callId: tool.id,
              name: tool.name,
              args: { ...tool.args },
            };
            fullToolCalls.push(record);
            const isGenerationSubmit = tool.name === 'generation.submit' || tool.name.endsWith('.generation.submit');
            if (isGenerationSubmit) {
              pendingGeneration = { tool, record };
              const requestedWorkflowId = tool.args.workflowId;
              if (typeof requestedWorkflowId === 'string') {
                responsePolicy = readPluginResponsePolicy(requestedWorkflowId);
                responsePolicyActive = true;
                activityRegistry.setSessionResponsePolicy(sid, responsePolicy);
              }
            } else {
              sendEvent('tool:call', {
                callId: tool.id,
                name: tool.name,
                args: tool.args,
              });
            }
          } else if (evt.type === 'tool_result') {
            const toolCall = fullToolCalls.find(call => call.callId === evt.result?.id);
            if (toolCall) toolCall.result = evt.result?.content;
            // 如果提交了任务，自动订阅 TaskQueue 并转发进度
            let taskId: string | undefined;
            let resolvedRoute: WorkflowRoute | undefined;
            const resObj = evt.result?.content as any;
            if (resObj && typeof resObj === 'object') {
              taskId = resObj.taskId;
              // 处理 MCP 标准 CallToolResult 格式: { content: [{ type: 'text', text: '{...}' }] }
              const route = resObj.route as WorkflowRoute | undefined;
              if (route && typeof route.finalWorkflowId === 'string') resolvedRoute = route;
              if (!taskId && Array.isArray(resObj.content)) {
                for (const c of resObj.content) {
                  if (c?.type === 'text' && typeof c.text === 'string') {
                    try {
                      const parsed = JSON.parse(c.text);
                      if (parsed?.route && typeof parsed.route.finalWorkflowId === 'string') {
                        resolvedRoute = parsed.route as WorkflowRoute;
                      }
                      if (parsed?.taskId) {
                        taskId = parsed.taskId;
                        break;
                      }
                    } catch {
                      // ignore json parse error
                    }
                  }
                }
              }
            } else if (typeof resObj === 'string') {
              try {
                const parsed = JSON.parse(resObj);
                if (parsed?.route && typeof parsed.route.finalWorkflowId === 'string') {
                  resolvedRoute = parsed.route as WorkflowRoute;
                }
                if (parsed?.taskId) taskId = parsed.taskId;
              } catch {
                // ignore
              }
            }

            const generationRequestedId = pendingGeneration?.tool.args.workflowId;
            presentGenerationCall(resolvedRoute, typeof generationRequestedId === 'string' ? generationRequestedId : undefined);
            sendEvent('tool:result', {
              callId: evt.result?.id,
              name: evt.result?.name,
              result: evt.result?.content,
            });

            if (taskId && typeof taskId === 'string') {
              const task = taskQueue.getTask(taskId);
              if (task) {
                taskQueue.bindSession(task.id, sid);
                // 注入本次对话的生成比例/尺寸偏好，执行时换算为分辨率
                if (reqRatio !== undefined || reqSize !== undefined) {
                  taskQueue.setGenPrefs(task.id, reqRatio, reqSize);
                }
                activityRegistry.attachTask(sid, task.id);
                const responseTask = taskForResponse(task, responsePolicy);
                sessionTasks.set(task.id, responseTask);
                activeTaskCount++;
                sendEvent('task:queued', { taskId: task.id, position: 1, task: responseTask });

                const unsub = taskQueue.subscribeTask(task.id, (tEvt, updatedTask) => {
                  if (tEvt === 'updated') {
                    const activeStage =
                      updatedTask.stages.find((s) => s.status === 'active') ||
                      updatedTask.stages[updatedTask.stages.length - 1];
                    const responseTask = taskForResponse(updatedTask, responsePolicy);
                    sessionTasks.set(updatedTask.id, responseTask);
                    sendEvent('task:progress', {
                      taskId: updatedTask.id,
                      stage: activeStage?.name || 'Processing',
                      step: activeStage?.step ?? 0,
                      total: activeStage?.totalSteps ?? 0,
                      percent: activeStage?.progress ?? 0,
                      task: responseTask,
                    });
                  } else if (tEvt === 'completed') {
                    const responseTask = taskForResponse(updatedTask, responsePolicy);
                    sessionTasks.set(updatedTask.id, responseTask);
                    activeTaskCount--;
                    if (responseProtocol && responseSpec && responseArgs) {
                      emitResponseBlocks('complete', contextFor(responseSpec, responseArgs, responseRoute, updatedTask, 'completed'));
                    }
                    if (updatedTask.outputs) {
                      for (const out of updatedTask.outputs) {
                        sendEvent('task:artifact', {
                          taskId: updatedTask.id,
                          kind: out.kind,
                          url: out.url,
                          filename: out.filename,
                        });
                      }
                    }
                    sendEvent('task:completed', { taskId: updatedTask.id, task: responseTask });
                    cleanupAndEnd();
                  } else if (tEvt === 'failed' || tEvt === 'canceled') {
                    const responseTask = taskForResponse(updatedTask, responsePolicy);
                    sessionTasks.set(updatedTask.id, responseTask);
                    activeTaskCount--;
                    if (responseProtocol && responseSpec && responseArgs) {
                      emitResponseBlocks('complete', contextFor(responseSpec, responseArgs, responseRoute, updatedTask, tEvt === 'failed' ? 'failed' : 'canceled'));
                    }
                    sendEvent(tEvt === 'failed' ? 'task:failed' : 'task:canceled', {
                      taskId: updatedTask.id,
                      error: updatedTask.error,
                      task: responseTask,
                    });
                    cleanupAndEnd();
                  }
                });
                taskUnsubscribes.push(unsub);
              }
            }

          } else if (evt.type === 'error') {
            sendEvent('agent:error', { error: evt.error });
          }
        },
      });
    } catch (err: any) {
      if (!agentController.signal.aborted) {
        sendEvent('agent:error', { error: err.message || String(err) });
      }
    } finally {
      const pending = pendingGeneration as { tool: NonNullable<AgentStreamEvent['tool']> } | null;
      const pendingWorkflowId = pending?.tool.args.workflowId;
      presentGenerationCall(undefined, typeof pendingWorkflowId === 'string' ? pendingWorkflowId : undefined);
      flushThinking();
      agentDone = true;
      // Agent 正文回复已结束。生成任务可能仍在进行，SSE 流保持打开以推送任务进度；
      // 前端据此停止对话气泡内的打字光标（agent:end 要等所有任务完成才发出，太晚）。
      if (responseProtocol && responseSpec && responseArgs) {
        emitResponseBlocks('always', contextFor(responseSpec, responseArgs, responseRoute, undefined, 'submitted'));
      }
      sendEvent('agent:reply_done', { sessionId: sid });
      cleanupAndEnd();
    }
    return;
  }

  // 2. 非流式 fallback（调用现有 generateReply）
  const reply = await generateReply(message.trim(), {
    workflowId: typeof req.body?.workflowId === 'string' ? req.body.workflowId : undefined,
    params: req.body?.params && typeof req.body.params === 'object' ? req.body.params : undefined,
    images: Array.isArray(req.body?.images) ? req.body.images : undefined,
    videos: Array.isArray(req.body?.videos) ? req.body.videos : undefined,
    sessionId: sid,
    ratio: typeof req.body?.ratio === 'string' ? req.body.ratio.trim() : undefined,
    size:
      typeof req.body?.size === 'number' && Number.isFinite(req.body.size) && req.body.size > 0
        ? req.body.size
        : undefined,
  });

  // 3. 助手消息落库（首条消息时自动命名已在上面触发）
  appendMessage(SESSIONS_FILE, sid, {
    role: 'assistant',
    content: reply.reply ?? '',
    stages: reply.stages,
    jobId: reply.jobId,
  });

  res.json({ ...reply, sessionId: sid });
});

/**
 * 用 LLM 为会话生成标题并落库（fire-and-forget）。
 * - 仅在会话标题仍是首条消息的截断值时重命名，避免覆盖用户手动修改；
 * - 成功后通过活动事件实时推送给前端侧边栏。
 */
async function autoTitleSession(sid: string, firstMessage: string, initialTitle: string): Promise<void> {
  const agent = readSettings(SETTINGS_FILE).agent;
  const title = await generateConversationTitle(firstMessage, {
    model: agent.model || undefined,
    thinking: agent.thinking === 'off' ? 'off' : 'minimal',
    timeoutMs: 12_000,
  }).catch(() => null);
  if (!title) return;
  const current = sessionList(SESSIONS_FILE).sessions.find(s => s.id === sid);
  if (!current || current.title !== initialTitle) return; // 用户可能已手动重命名
  renameSession(SESSIONS_FILE, sid, title);
  // 双通道通知：聊天 SSE（会话仍在流中时实时更新）+ 全局活动流（流结束后也能收到）
  activityRegistry.publishSessionEvent(sid, { type: 'session:renamed', sessionId: sid, title });
  activityRegistry.notifySessionRenamed(sid, title);
}

// 兼容旧 mock（保留，前端不再使用）
app.post('/api/chat/mock', (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message : '';
  res.json(mockReply(message));
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, name: 'minidream', version: '2.0.0', comfyui: COMFYUI_BASE_URL });
});

app.listen(PORT, () => {
  console.log(`[server] Minidream v2 API listening on http://127.0.0.1:${PORT}`);
  console.log(`[server] ComfyUI base URL: ${COMFYUI_BASE_URL} (env COMFYUI_BASE_URL 可覆盖)`);
});
