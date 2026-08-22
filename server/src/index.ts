import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { generateData, mockReply } from './mock.js';
import {
  COMFYUI_BASE_URL,
  checkHealth,
  getQueue,
  setComfyBaseUrl,
  uploadFile,
  submitPrompt,
} from './comfyui.js';
import {
  readSettings,
  writeSettings,
  updateImageGenSettings,
  updateComfyUISettings,
  type ImageGenSettings,
} from './settings.js';
import {
  buildSpecsCached,
  buildPrompt,
  getWorkflowJson,
  invalidateComfyCaches,
  type WorkflowSpec,
} from './workflow.js';
import { startJob, cancelJob, subscribeJob, getJob, jobSnapshot } from './jobs.js';
import { TaskQueue } from './tasks/queue.js';
import { createDirectorMCPServer, type McpServerInstance } from './mcp/server.js';
import { runAgentStream, buildAgentInput, type AgentStreamEvent } from './agent/bridge.js';
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
export const taskQueue = new TaskQueue({
  dataFile: TASKS_FILE,
  settingsFile: SETTINGS_FILE,
});

export const mcpServer: McpServerInstance = createDirectorMCPServer(taskQueue);


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

/** 更新会话最后一条消息（SSE 终态落库：done/error/cancelled） */
app.post('/api/sessions/:id/messages/last', (req, res) => {
  try {
    const body = req.body ?? {};
    const msg: StoredMessage = {
      role: body.role === 'user' ? 'user' : 'assistant',
      content: typeof body.content === 'string' ? body.content : '',
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

/** workflow 列表（introspection 自动识别输入/参数/输出） */
app.get('/api/workflows', async (_req, res) => {
  const specs = await buildSpecsCached();
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

/** 生成任务实时事件流（SSE） */
app.get('/api/generate/:jobId/events', (req, res) => {
  const job = getJob(req.params.jobId);
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
  const unsubscribe = subscribeJob(req.params.jobId, send);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

/** 任务快照（供重连/轮询） */
app.get('/api/generate/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'job not found' });
    return;
  }
  res.json(jobSnapshot(job));
});

/** 取消生成 */
app.post('/api/generate/:jobId/cancel', async (req, res) => {
  const ok = await cancelJob(req.params.jobId);
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
    imageGen: current.imageGen,
  });
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

function dataUrlToBuffer(dataUrl: string): { buffer: Buffer; mime: string } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error('素材格式无效（需 data URL）');
  return { buffer: Buffer.from(m[2] ?? '', 'base64'), mime: m[1] ?? '' };
}

function extForMime(mime: string, name?: string): string {
  if (name?.includes('.')) return name.split('.').pop()!;
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
  };
  return map[mime] ?? 'bin';
}

/** 生成回复：thinking 日志 + 任务卡（实时进度走 SSE） */
async function generateReply(
  message: string,
  opts: {
    workflowId?: string;
    params?: Record<string, unknown>;
    images?: UploadPayload[];
    videos?: UploadPayload[];
  },
): Promise<ChatReply> {
  const title = message.slice(0, 12) + (message.length > 12 ? '…' : '');
  const workflows = await buildSpecsCached();
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
    // 1. 上传素材（同步，POST 返回前完成）
    const uploaded: Record<string, string> = {};
    const imageInputs = spec.inputs.filter(i => i.kind === 'image');
    const videoInputs = spec.inputs.filter(i => i.kind === 'video');

    for (let i = 0; i < (opts.images ?? []).length; i++) {
      const up = opts.images![i];
      if (!up?.dataUrl) continue;
      const { buffer, mime } = dataUrlToBuffer(up.dataUrl);
      const ext = extForMime(mime, up.name);
      const input = imageInputs[i] ?? imageInputs[0];
      if (!input) continue;
      const filename = `upload_${Date.now()}_${i}.${ext}`;
      const res = await uploadFile('image', filename, buffer);
      const name = res.subfolder ? `${res.subfolder}/${res.name}` : res.name;
      uploaded[input.id] = name;
      logs.push(`已上传参考图「${up.name ?? filename}」`);
    }
    for (let i = 0; i < (opts.videos ?? []).length; i++) {
      const up = opts.videos![i];
      if (!up?.dataUrl) continue;
      const { buffer, mime } = dataUrlToBuffer(up.dataUrl);
      const ext = extForMime(mime, up.name);
      const input = videoInputs[i] ?? videoInputs[0];
      if (!input) continue;
      const filename = `upload_${Date.now()}_v${i}.${ext}`;
      const res = await uploadFile('video', filename, buffer);
      const name = res.subfolder ? `${res.subfolder}/${res.name}` : res.name;
      uploaded[input.id] = name;
      logs.push(`已上传视频「${up.name ?? filename}」`);
    }

    // 2. 构建 prompt 并提交
    logs.push('正在提交任务到 ComfyUI…');
    const settings = readSettings(SETTINGS_FILE);
    const prompt = await buildPrompt(spec, getWorkflowJson(spec.id)!, {
      prompt: message,
      uploaded,
      params: opts.params,
      settings: settings.imageGen,
    });
    const clientId = randomUUID();
    const submit = await submitPrompt(prompt, clientId);
    const queue = await getQueue();
    const pending = queue.queue_pending.length;

    // 3. 启动任务监听（WS → SSE）
    const job = startJob({
      workflowId: spec.id,
      spec,
      promptId: submit.prompt_id,
      clientId,
    });

    logs.push(`任务已提交（#${submit.number}）${pending > 0 ? `，${pending} 个任务排队中` : ''}`);

    const stages: ChatReply['stages'] = [
      { type: 'thinking', logs },
      {
        type: 'task',
        progress: { completed: 0, total: 1 },
        taskLabel: `${spec.outputs.some(o => o.kind === 'video') ? '视频' : '图片'}生成中…`,
        queued: pending > 0,
        queueLabel: pending > 0 ? `${pending} 个任务排队中` : undefined,
      },
    ];

    return {
      title,
      reply: `已提交生成任务（工作流：${spec.name}），完成后可直接查看结果。`,
      stages,
      jobId: job.id,
      promptId: submit.prompt_id,
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

  // 1. 用户消息落库（会话不存在时自动创建）
  const append = appendMessage(SESSIONS_FILE, sessionId, { role: 'user', content: message.trim() });
  const sid = append.sessionId;

  const isStream = req.headers.accept === 'text/event-stream' || req.query.stream === 'true' || req.body?.stream === true;

  if (isStream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendEvent = (event: string, data: any) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let fullThinking = '';
    let fullText = '';
    const taskUnsubscribes: Array<() => void> = [];
    let agentDone = false;
    let activeTaskCount = 0;

    const cleanupAndEnd = () => {
      if (!agentDone || activeTaskCount > 0) return;
      // 保存助手消息
      appendMessage(SESSIONS_FILE, sid, {
        role: 'assistant',
        content: fullText,
      });
      sendEvent('agent:end', { sessionId: sid });
      res.end();
    };

    req.on('close', () => {
      taskUnsubscribes.forEach(unsub => unsub());
    });

    const mcpUrl = mcpServer.getUrl() || `http://127.0.0.1:${PORT}/api/mcp`;
    const agentInput = buildAgentInput({
      message: message.trim(),
      images: Array.isArray(req.body?.images) ? req.body.images : undefined,
      videos: Array.isArray(req.body?.videos) ? req.body.videos : undefined,
    });

    try {
      await runAgentStream(agentInput, {
        mcpServerUrl: mcpUrl,
        onEvent: (evt: AgentStreamEvent) => {
          if (evt.type === 'thinking') {
            fullThinking += evt.delta || '';
            sendEvent('agent:thinking', { delta: evt.delta });
          } else if (evt.type === 'text') {
            fullText += evt.delta || '';
            sendEvent('agent:text', { delta: evt.delta });
          } else if (evt.type === 'tool_call') {
            sendEvent('tool:call', {
              callId: evt.tool?.id,
              name: evt.tool?.name,
              args: evt.tool?.args,
            });
          } else if (evt.type === 'tool_result') {
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
                activeTaskCount++;
                sendEvent('task:queued', { taskId: task.id, position: 1, task });

                const unsub = taskQueue.subscribeTask(task.id, (tEvt, updatedTask) => {
                  if (tEvt === 'updated') {
                    const activeStage =
                      updatedTask.stages.find((s) => s.status === 'active') ||
                      updatedTask.stages[updatedTask.stages.length - 1];
                    sendEvent('task:progress', {
                      taskId: updatedTask.id,
                      stage: activeStage?.name || 'Processing',
                      step: activeStage?.step ?? 0,
                      total: activeStage?.totalSteps ?? 0,
                      percent: activeStage?.progress ?? 0,
                      task: updatedTask,
                    });
                  } else if (tEvt === 'completed') {
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
      sendEvent('agent:error', { error: err.message || String(err) });
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
  });

  // 3. 助手消息落库；本次新建的会话用回复标题命名
  appendMessage(SESSIONS_FILE, sid, {
    role: 'assistant',
    content: reply.reply ?? '',
    stages: reply.stages,
    jobId: reply.jobId,
  });
  if (append.created && reply.title) {
    renameSession(SESSIONS_FILE, sid, reply.title);
  }

  res.json({ ...reply, sessionId: sid });
});

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
