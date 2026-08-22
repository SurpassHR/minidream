import express from 'express';
import path from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateData, mockReply } from './mock.js';
import {
  COMFYUI_BASE_URL,
  checkHealth,
  getQueue,
  setComfyBaseUrl,
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
import { DraftStore } from './drafts.js';
import { TaskQueue } from './tasks/queue.js';
import type { TaskItem } from './tasks/types.js';
import { createDirectorMCPServer, type McpServerInstance } from './mcp/server.js';
import { listAgentModels, runAgentStream, buildAgentInput, generateConversationTitle, type AgentStreamEvent } from './agent/bridge.js';
import {
  SessionError,
  appendMessage,
  createSession,
  deleteSession,
  renameSession,
  selectSession,
  sessionList,
  sessionMessages,
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
const DRAFTS_INDEX_FILE = path.resolve(__dirname, '../data/drafts.json');
const initialSettings = readSettings(SETTINGS_FILE);
export const draftStore = new DraftStore({
  indexFile: DRAFTS_INDEX_FILE,
  outputDir: initialSettings.storage.outputDir,
});
export const taskQueue = new TaskQueue({
  dataFile: TASKS_FILE,
  settingsFile: SETTINGS_FILE,
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

export const mcpServer: McpServerInstance = createDirectorMCPServer(
  taskQueue,
  isWorkflowEnabled,
  () => readSettings(SETTINGS_FILE).agent.pollTaskStatus,
);
export const activityRegistry = new ActivityRegistry(taskQueue);


/* ---------------- 会话（JSON 文件持久化，照搬 v1 方案） ---------------- */

const SESSIONS_FILE = path.resolve(__dirname, '../data/sessions.json');

/** 会话元信息列表 + 当前会话 id */
app.get('/api/sessions', (_req, res) => {
  res.json(sessionList(SESSIONS_FILE));
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
      jobId: typeof body.jobId === 'string' ? body.jobId : undefined,
    };
    updateLastMessage(SESSIONS_FILE, req.params.id, msg);
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof SessionError) { res.status(404).json({ error: e.message }); return; }
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
    res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/octet-stream');
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
    plugins: current.plugins,
  });
});

/** Agent 模型列表：设置弹窗按需从当前 Pi 配置读取 */
app.get('/api/agent/models', async (_req, res) => {
  res.json({ models: await listAgentModels() });
});

/** 更新 Agent 默认模型与 thinking 强度 */
app.post('/api/settings/agent', (req, res) => {
  try {
    const partial: Partial<AgentSettings> = {
      model: typeof req.body?.model === 'string' ? req.body.model : undefined,
      thinking: typeof req.body?.thinking === 'string' ? req.body.thinking as AgentSettings['thinking'] : undefined,
      pollTaskStatus: typeof req.body?.pollTaskStatus === 'boolean' ? req.body.pollTaskStatus : undefined,
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

/** 更新生成插件（工作流）停用状态与参数配置 */
app.post('/api/settings/plugins', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const specs = await buildSpecsCached();
    const known = new Set(specs.map(s => s.id));

    const requested: string[] = Array.isArray(body.disabled)
      ? body.disabled.filter((id: unknown): id is string => typeof id === 'string')
      : [];
    const disabled = requested.filter(id => known.has(id));

    // 参数配置：只保留「已知工作流 + 已知参数 + 值在 combo 列表中（列表为空时不校验）」的条目
    const config: Record<string, Record<string, string>> = {};
    const rawConfig =
      body.config && typeof body.config === 'object'
        ? (body.config as Record<string, Record<string, unknown>>)
        : {};
    for (const [wfId, cfg] of Object.entries(rawConfig)) {
      if (!known.has(wfId) || !cfg || typeof cfg !== 'object') continue;
      const spec = specs.find(s => s.id === wfId)!;
      const byId = new Map(spec.params.map(p => [p.id, p]));
      const entries: Record<string, string> = {};
      for (const [paramId, value] of Object.entries(cfg)) {
        if (typeof value !== 'string' || !value.trim()) continue;
        const param = byId.get(paramId);
        if (!param || param.type !== 'combo') continue;
        // 有 combo 列表时校验值在列表中，避免保存非法值；无列表（ComfyUI 未连接）时放行
        if (param.options?.length && !param.options.includes(value)) continue;
        entries[paramId] = value;
      }
      if (Object.keys(entries).length) config[wfId] = entries;
    }

    const updated = updatePluginsSettings(SETTINGS_FILE, { disabled, config });
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
  res.setHeader('Content-Type', draft.mime ?? 'application/octet-stream');
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
  if ((append.file.sessions.find(s => s.id === sid)?.messages.length ?? 0) === 1) {
    void autoTitleSession(sid, message.trim(), initialTitle);
  }

  if (isStream) {

    let fullThinking = '';
    let fullText = '';
    const fullToolCalls: Array<Record<string, unknown>> = [];
    const sessionTasks = new Map<string, TaskItem>();
    const taskUnsubscribes: Array<() => void> = [];
    const agentController = new AbortController();
    let agentDone = false;
    let activeTaskCount = 0;
    let responseEnded = false;
    let responseConnected = true;
    let runFinalized = false;
    let unsubscribeResponse: () => void = () => undefined;
    activityRegistry.startSession(sid, message.trim(), agentController);

    const publishEvent = (type: string, data: Record<string, unknown> = {}) => {
      activityRegistry.publishSessionEvent(sid, { type, ...data });
    };
    const sendEvent = (type: string, data: Record<string, unknown> = {}) => {
      publishEvent(type, data);
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
    const agentInput = buildAgentInput({
      message: message.trim(),
      images: Array.isArray(req.body?.images) ? req.body.images : undefined,
      videos: Array.isArray(req.body?.videos) ? req.body.videos : undefined,
    });

    try {
      await runAgentStream(agentInput, {
        sessionId: sid,
        signal: agentController.signal,
        mcpServerUrl: mcpUrl,
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
            fullThinking += evt.delta || '';
            sendEvent('agent:thinking', { delta: evt.delta });
          } else if (evt.type === 'text') {
            fullText += evt.delta || '';
            sendEvent('agent:text', { delta: evt.delta });
          } else if (evt.type === 'tool_call') {
            fullToolCalls.push({
              callId: evt.tool?.id,
              name: evt.tool?.name,
              args: evt.tool?.args,
            });
            sendEvent('tool:call', {
              callId: evt.tool?.id,
              name: evt.tool?.name,
              args: evt.tool?.args,
            });
          } else if (evt.type === 'tool_result') {
            const toolCall = fullToolCalls.find(call => call.callId === evt.result?.id);
            if (toolCall) toolCall.result = evt.result?.content;
            sendEvent('tool:result', {
              callId: evt.result?.id,
              name: evt.result?.name,
              result: evt.result?.content,
            });

            // 如果提交了任务，自动订阅 TaskQueue 并转发进度
            let taskId: string | undefined;
            const resObj = evt.result?.content as any;
            if (resObj && typeof resObj === 'object') {
              taskId = resObj.taskId;
              // 处理 MCP 标准 CallToolResult 格式: { content: [{ type: 'text', text: '{...}' }] }
              if (!taskId && Array.isArray(resObj.content)) {
                for (const c of resObj.content) {
                  if (c?.type === 'text' && typeof c.text === 'string') {
                    try {
                      const parsed = JSON.parse(c.text);
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
                if (parsed?.taskId) taskId = parsed.taskId;
              } catch {
                // ignore
              }
            }

            if (taskId && typeof taskId === 'string') {
              const task = taskQueue.getTask(taskId);
              if (task) {
                taskQueue.bindSession(task.id, sid);
                // 注入本次对话的生成比例/尺寸偏好，执行时换算为分辨率
                if (reqRatio !== undefined || reqSize !== undefined) {
                  taskQueue.setGenPrefs(task.id, reqRatio, reqSize);
                }
                activityRegistry.attachTask(sid, task.id);
                sessionTasks.set(task.id, task);
                activeTaskCount++;
                sendEvent('task:queued', { taskId: task.id, position: 1, task });

                const unsub = taskQueue.subscribeTask(task.id, (tEvt, updatedTask) => {
                  if (tEvt === 'updated') {
                    const activeStage =
                      updatedTask.stages.find((s) => s.status === 'active') ||
                      updatedTask.stages[updatedTask.stages.length - 1];
                    sessionTasks.set(updatedTask.id, updatedTask);
                    sendEvent('task:progress', {
                      taskId: updatedTask.id,
                      stage: activeStage?.name || 'Processing',
                      step: activeStage?.step ?? 0,
                      total: activeStage?.totalSteps ?? 0,
                      percent: activeStage?.progress ?? 0,
                      task: updatedTask,
                    });
                  } else if (tEvt === 'completed') {
                    sessionTasks.set(updatedTask.id, updatedTask);
                    activeTaskCount--;
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
                    sendEvent('task:completed', { taskId: updatedTask.id, task: updatedTask });
                    cleanupAndEnd();
                  } else if (tEvt === 'failed' || tEvt === 'canceled') {
                    sessionTasks.set(updatedTask.id, updatedTask);
                    activeTaskCount--;
                    sendEvent(tEvt === 'failed' ? 'task:failed' : 'task:canceled', {
                      taskId: updatedTask.id,
                      error: updatedTask.error,
                      task: updatedTask,
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
      agentDone = true;
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
  res.json({ ok: true, name: 'director-workbench', version: '2.0.0', comfyui: COMFYUI_BASE_URL });
});

app.listen(PORT, () => {
  console.log(`[server] Director Workbench v2 API listening on http://127.0.0.1:${PORT}`);
  console.log(`[server] ComfyUI base URL: ${COMFYUI_BASE_URL} (env COMFYUI_BASE_URL 可覆盖)`);
});
