import type { FastifyInstance } from 'fastify';
import { DirectorError, type Actor, type NodeType } from '../types.js';
import {
  createNode, updateNode, deleteNode, moveNode,
  createEdge, updateEdge, deleteEdge, loadGraph,
} from '../graph/graph-store.js';
import { syncNodeToFile } from '../sync/dual-writer.js';
import { listSnapshots, graphAtSnapshot, headSeq, futureSnapshotCount, approveOverwrite } from '../snapshots/snapshot-store.js';
import { listWorkspace, readWorkspaceFile, searchWorkspace } from '../workspace/accessor.js';
import { readFileSync, existsSync, mkdtempSync, createWriteStream, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { applyMutation, applyHeadSwitch } from './mutations.js';
import { graphToPromptYaml } from '../prompt/export.js';
import { GenerationQueue } from '../generation/queue.js';
import { ComfyUIClient } from '../comfy/client.js';
import { listAssets, importAssetFile, importAssetText, deleteAsset, readAssetText } from '../assets/assets-store.js';
import { buildAgentPrompt, runAgentCollect, runAgentStream } from '../agent/bridge.js';
import { appendChatMessage, readChatHistory } from '../agent/chat-history.js';
import { readStory, saveStory, completeStory, buildStoryMarkdown } from '../story/store.js';
import {
  addProject, listProjects, removeProject, resolveSwitchTarget, resolveComfyUrl,
} from '../projects/projects-store.js';
import type { WsHandle } from './ws.js';

// 项目上下文：单一可变事实来源，/api/project/switch 热切换时整体替换
// （projectDir / queue / comfy 三者必须同属一个项目，避免切换后交叉引用旧目录）
export interface ProjectContext {
  projectDir: string;
  queue: GenerationQueue;
  comfy: ComfyUIClient;
}

function confirmOf(query: unknown): boolean {
  if (typeof query !== 'object' || query === null) return false;
  // Fastify query 参数值为字符串（如 'true'），需同时接受布尔与字符串形式
  const c = (query as Record<string, unknown>).confirm;
  return c === true || c === 'true';
}


// pi --thinking 合法级别（侧栏思考强度下拉的数据源）
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// 生成 chat 专用 MCP 配置：只含 director-workbench 自身（type: http）。
// 目的：pi 默认会加载用户 ~/.pi/agent/mcp.json 的全部 MCP server（如 openreel-studio）——
// ① 初始化慢（等待外部 API 起来）导致 45s 空闲超时前零输出；
// ② agent 会用 openreel 工具误操作 OpenReel 画布而非本工作台画布。
// 替换配置后 pi 只认工作台自己的画布工具。失败返回 null（不传 --mcp-config，保持原行为）。
export function writeAgentMcpConfig(mcpPort: number): string | null {
  try {
    const file = join(tmpdir(), `director-agent-mcp-${mcpPort}.json`);
    writeFileSync(file, JSON.stringify({
      mcpServers: {
        'director-workbench': {
          type: 'http',
          url: `http://127.0.0.1:${mcpPort}/mcp`,
          directTools: true,
        },
      },
    }, null, 2), 'utf8');
    return file;
  } catch {
    return null;
  }
}


export function mountRoutes(
  app: FastifyInstance,
  ctx: ProjectContext,
  ws: WsHandle,
): void {
  const actor: Actor = 'user';

  app.get('/api/graph', async () => ({ graph: loadGraph(ctx.projectDir) }));

  // 画布 → MMH3 Prompt YAML 导出（chain 拓扑序 = 剧情顺序；结构性错误抛 YAML_EXPORT_FAILED）
  app.post('/api/yaml/export', async () => ({
    ...graphToPromptYaml(loadGraph(ctx.projectDir)),
  }));

  // —— 项目栏：手动添加的项目注册表（默认不自动发现） ——
  app.get('/api/projects', async () => ({ projects: listProjects(ctx.projectDir) }));

  // 添加项目：校验为剧本项目（mmh3_prompts/prompts）或空目录后才可加入；持久化注册表
  app.post('/api/projects/add', async (req) => ({
    projects: addProject(ctx.projectDir, (req.body as { path?: string }).path ?? ''),
  }));

  // 从项目栏移除（仅移除注册表项，不删除目录内容）
  app.post('/api/projects/remove', async (req) => ({
    projects: removeProject(ctx.projectDir, (req.body as { path?: string }).path ?? ''),
  }));

  app.post('/api/project/switch', async (req, reply) => {
    const body = req.body as { path?: string };
    const target = resolveSwitchTarget(ctx.projectDir, body.path ?? '');
    if (!target) {
      return reply.code(400).send({ code: 'PROJECT_NOT_FOUND', message: `项目目录不存在: ${body.path ?? ''}` });
    }
    // 三者整体替换为同一项目，避免交叉引用旧目录：
    // comfy 按新项目 project 节点地址重建；queue 随之重建；watcher 切换监视目录
    ctx.projectDir = target;
    ctx.comfy = new ComfyUIClient(resolveComfyUrl(target));
    ctx.queue = new GenerationQueue(target, ctx.comfy);
    await ws.switchDir(target);
    return { graph: loadGraph(ctx.projectDir), projects: listProjects(ctx.projectDir) };
  });


  app.post('/api/nodes', async (req, reply) => {
    const body = req.body as {
      type: NodeType; title: string; fields?: Record<string, unknown>;
      position?: { x: number; y: number };
    };
    let nodeId = '';
    applyMutation(ctx.projectDir, actor, `创建节点 ${body.title}`, (g) => {
      const n = createNode(g, body);
      nodeId = n.id;
    });
    const graph = loadGraph(ctx.projectDir);
    const node = graph.nodes.find((n) => n.id === nodeId);
    // 创建节点时若指定了映射文件且目标文件尚不存在，则落盘（验收冒烟要求；
    // 文件已存在时不覆盖——遵守“冲突从不静默覆盖”约束，走 PATCH/导入流程同步）
    if (node) {
      const f = node.fields.filename;
      if (typeof f === 'string' && !existsSync(join(ctx.projectDir, f))) {
        syncNodeToFile(ctx.projectDir, node);
      }
    }
    reply.code(201);
    return { node };
  });

  app.patch('/api/nodes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { patch } = req.body as { patch: Record<string, unknown> };
    let updated;
    applyMutation(ctx.projectDir, actor, `更新节点 ${id}`, (g) => {
      updated = updateNode(g, id, patch);
      // 内容字段变化时同步映射文件
      const p = patch.fields as Record<string, unknown> | undefined;
      if (p && typeof p.content === 'string') {
        syncNodeToFile(ctx.projectDir, updated);
      }
    });
    return { node: updated };
  });

  app.delete('/api/nodes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!confirmOf(req.query)) {
      return reply.code(400).send({ code: 'CONFIRM_REQUIRED', message: '删除节点需 confirm=true' });
    }
    applyMutation(ctx.projectDir, actor, `删除节点 ${id}`, (g) => { deleteNode(g, id); });
    return { ok: true };
  });

  app.post('/api/nodes/:id/move', async (req) => {
    const { id } = req.params as { id: string };
    const { position } = req.body as { position: { x: number; y: number } };
    let moved;
    applyMutation(ctx.projectDir, actor, `移动节点 ${id}`, (g) => { moved = moveNode(g, id, position); });
    return { node: moved };
  });

  app.post('/api/edges', async (req, reply) => {
    const body = req.body as {
      kind: 'ref' | 'chain' | 'exec'; source: string; target: string;
      label?: string; targetHandle?: string; replaceEdgeId?: string;
    };
    let edge;
    applyMutation(ctx.projectDir, actor, `创建边 ${body.source} -> ${body.target}`, (g) => {
      edge = createEdge(g, body);
    });
    reply.code(201);
    return { edge };
  });

  app.delete('/api/edges/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!confirmOf(req.query)) {
      return reply.code(400).send({ code: 'CONFIRM_REQUIRED', message: '删除边需 confirm=true' });
    }
    applyMutation(ctx.projectDir, actor, `删除边 ${id}`, (g) => { deleteEdge(g, id); });
    return { ok: true };
  });

  // 修改边：改类型（ref/chain/exec）或标签；改为 chain 时重新校验线性约束
  app.patch('/api/edges/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { patch: { kind?: 'ref' | 'chain' | 'exec'; label?: string } };
    let edge;
    applyMutation(ctx.projectDir, actor, `修改边 ${id}`, (g) => {
      edge = updateEdge(g, id, body.patch ?? {});
    });
    return { edge };
  });

  // 从工作区文件导入节点
  app.post('/api/import', async (req, reply) => {
    const body = req.body as {
      path: string; type: NodeType; title: string;
      filename?: string; position?: { x: number; y: number };
    };
    const content = readWorkspaceFile(ctx.projectDir, body.path);
    const filename = body.filename ?? body.path;
    let node;
    applyMutation(ctx.projectDir, actor, `导入文件 ${body.path}`, (g) => {
      const existing = g.nodes.find((n) => n.fields.filename === filename);
      if (existing) {
        node = updateNode(g, existing.id, { fields: { content } });
      } else {
        node = createNode(g, {
          type: body.type, title: body.title,
          fields: { filename, content },
          position: body.position,
        });
      }
    });
    reply.code(201);
    return { node };
  });

  app.get('/api/snapshots', async () => ({
    snapshots: listSnapshots(ctx.projectDir),
    headSeq: headSeq(ctx.projectDir),
  }));

  // 点击快照直接回滚（免确认）：重置图为目标快照状态并切换 HEAD，不追加新快照
  app.post('/api/snapshots/rollback', async (req, reply) => {
    const body = req.body as { seq: number };
    try {
      return { graph: applyHeadSwitch(ctx.projectDir, body.seq) };
    } catch (e) {
      if (e instanceof DirectorError) {
        return reply.code(400).send({ code: e.code, message: e.message });
      }
      throw e;
    }
  });

  // 撤销（Ctrl+Z）：HEAD 后退到前一个快照
  app.post('/api/snapshots/undo', async (req, reply) => {
    const snaps = listSnapshots(ctx.projectDir);
    const head = headSeq(ctx.projectDir);
    const prev = [...snaps].reverse().find((s) => s.seq < head);
    if (!prev) {
      return reply.code(400).send({ code: 'INVALID_PATCH', message: '没有更早的快照可撤销' });
    }
    return { graph: applyHeadSwitch(ctx.projectDir, prev.seq) };
  });

  // 重做（Ctrl+Y / Ctrl+Shift+Z）：HEAD 前进到下一个（未来）快照
  app.post('/api/snapshots/redo', async (req, reply) => {
    const snaps = listSnapshots(ctx.projectDir);
    const head = headSeq(ctx.projectDir);
    const next = snaps.find((s) => s.seq > head);
    if (!next) {
      return reply.code(400).send({ code: 'INVALID_PATCH', message: '没有更新的快照可重做' });
    }
    return { graph: applyHeadSwitch(ctx.projectDir, next.seq) };
  });

  // 覆盖未来（灰色）快照的一次性批准：确认对话框后调用，
  // 下一次写操作（recordSnapshot）发现未来快照时放行覆盖
  app.post('/api/snapshots/approve-overwrite', async () => {
    approveOverwrite();
    return { ok: true };
  });

  app.get('/api/workspace/list', async () => ({ paths: listWorkspace(ctx.projectDir) }));

  app.get('/api/workspace/search', async (req) => {
    const { q } = req.query as { q: string };
    return { hits: searchWorkspace(ctx.projectDir, q) };
  });

  app.get('/api/workspace/read', async (req) => {
    const { path } = req.query as { path: string };
    return { content: readWorkspaceFile(ctx.projectDir, path) };
  });

  // —— 生成执行：ComfyUI 状态与生成任务 ——
  app.get('/api/comfy/health', async () => ({
    healthy: await ctx.comfy.health(),
    baseUrl: ctx.comfy.baseUrl,
  }));

  // 自定义 ComfyUI 地址：写入 project 节点并热切换客户端
  app.post('/api/comfy/config', async (req, reply) => {
    const body = req.body as { baseUrl?: string };
    const url = (body.baseUrl ?? '').trim();
    if (!url || !/^https?:\/\//.test(url)) {
      return reply.code(400).send({ code: 'INVALID_PATCH', message: '地址需以 http:// 或 https:// 开头' });
    }
    applyMutation(ctx.projectDir, actor, `配置 ComfyUI 地址 ${url}`, (g) => {
      const proj = g.nodes.find((n) => n.type === 'project');
      if (proj) {
        proj.fields.comfyuiUrl = url;
        proj.version += 1;
      } else {
        createNode(g, {
          type: 'project', title: g.projectName,
          fields: { comfyuiUrl: url },
          position: { x: 40, y: 40 },
        });
      }
    });
    ctx.comfy.setBaseUrl(url); // 热切换：后续生成与健康检查立即使用新地址
    const healthy = await ctx.comfy.health();
    return { ok: true, baseUrl: ctx.comfy.baseUrl, healthy };
  });

  app.post('/api/generation/submit', async (req, reply) => {
    const body = req.body as { nodeId: string; confirm?: boolean };
    if (!body.confirm) {
      return reply.code(400).send({ code: 'CONFIRM_REQUIRED', message: '提交生成需 confirm=true' });
    }
    const task = ctx.queue.submit(body.nodeId);
    reply.code(202);
    return { task };
  });

  app.get('/api/generation/status', async (req, reply) => {
    const { nodeId } = req.query as { nodeId: string };
    const task = ctx.queue.status(nodeId);
    if (!task) return reply.code(404).send({ code: 'NODE_NOT_FOUND', message: `无任务: ${nodeId}` });
    return { task };
  });

  app.get('/api/generation/queue', async () => ({ tasks: ctx.queue.list() }));

  app.post('/api/generation/cancel', async (req, reply) => {
    const body = req.body as { nodeId: string; confirm?: boolean };
    if (!body.confirm) {
      return reply.code(400).send({ code: 'CONFIRM_REQUIRED', message: '取消生成需 confirm=true' });
    }
    const ok = ctx.queue.cancel(body.nodeId);
    return { ok };
  });

  // —— 素材库：全局素材（~/.director/assets） ——
  app.get('/api/assets', async () => ({ assets: listAssets() }));

  app.post('/api/assets/import', async (req, reply) => {
    const { sourcePath } = req.body as { sourcePath: string };
    const rec = importAssetFile(sourcePath);
    reply.code(201);
    return { asset: rec };
  });

  app.post('/api/assets/import-text', async (req, reply) => {
    const { name, content } = req.body as { name: string; content: string };
    const rec = importAssetText(name, content);
    reply.code(201);
    return { asset: rec };
  });

  // 浏览器端上传：multipart 字段 file → 临时目录写盘 → importAssetFile 入库（finally 清理临时目录）
  app.post('/api/assets/upload', async (req, reply) => {
    // @fastify/multipart v8 的 req.file() 在非 multipart 请求下会抛错而非返回 undefined，
    // 先按契约校验 content-type 返回 400
    const ct = req.headers['content-type'] ?? '';
    if (!ct.includes('multipart/form-data')) {
      return reply.code(400).send({ code: 'INVALID_PATCH', message: '请求必须为 multipart/form-data' });
    }
    const file = await req.file(); // @fastify/multipart 注入
    if (!file) {
      return reply.code(400).send({ code: 'INVALID_PATCH', message: '缺少 file 字段' });
    }
    const tmpDir = mkdtempSync(join(tmpdir(), 'director-upload-'));
    const tmpPath = join(tmpDir, file.filename || `upload-${randomUUID()}.bin`);
    try {
      await pipeline(file.file, createWriteStream(tmpPath));
      const asset = importAssetFile(tmpPath);
      reply.code(201);
      return { asset };
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  app.delete('/api/assets/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!confirmOf(req.query)) {
      return reply.code(400).send({ code: 'CONFIRM_REQUIRED', message: '删除素材需 confirm=true' });
    }
    deleteAsset(id);
    return { ok: true };
  });

  app.get('/api/assets/:id/content', async (req) => {
    const { id } = req.params as { id: string };
    return { content: readAssetText(id) };
  });

// 项目聊天历史：按项目持久化（.director/chat.json），重启不丢；切换项目随项目加载
app.get('/api/agent/history', async () => ({ messages: readChatHistory(ctx.projectDir) }));

// —— 故事向导（story-teller 角色页）——
// 进度存 .director/story.json；complete 时组装 Markdown 入库为 story_<项目名>.md 素材
app.get('/api/story', async () => ({ story: readStory(ctx.projectDir) }));

app.put('/api/story', async (req) => {
  const body = req.body as { step?: number; answers?: Record<string, string> };
  return { story: saveStory(ctx.projectDir, {
    step: typeof body.step === 'number' ? body.step : undefined,
    answers: body.answers && typeof body.answers === 'object' ? body.answers : undefined,
  }) };
});

app.post('/api/story/complete', async (req, reply) => {
  const story = readStory(ctx.projectDir);
  if (story.completedAt) {
    return reply.code(409).send({ code: 'STORY_ALREADY_COMPLETED', message: '故事已完成，如需重新生成请先重置' });
  }
  const projectName = loadGraph(ctx.projectDir).projectName || '未命名项目';
  const md = buildStoryMarkdown(projectName, story.answers);
  const asset = importAssetText(`story_${projectName}.md`, md);
  completeStory(ctx.projectDir, new Date().toISOString());
  reply.code(201);
  return { asset, story: readStory(ctx.projectDir) };
});

// —— 计划 4 Task 3：pi 桥 SSE 流式对话 ——
  app.post('/api/agent/chat', async (req, reply) => {
    const body = req.body as {
      message: string;
      chips?: Array<{ name: string; content: string }>;
      model?: string;
      thinking?: string;
    };
    // 画布摘要：节点类型计数（agent 上下文，避免全量图塞爆提示词）
    const graph = loadGraph(ctx.projectDir);
    const counts = new Map<string, number>();
    for (const n of graph.nodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
    const graphSummary = [...counts.entries()].map(([t, c]) => `${c}×${t}`).join(' · ') || '空画布';

    const cmd = (process.env.DIRECTOR_PI_CMD ?? 'pi --mode json').split(' ').filter(Boolean);
    // 默认 pi 命令时注入 chat 专用 MCP 配置（只含 director-workbench，避免 openreel 等
    // 无关 MCP 拖慢启动/误操作其他画布）；自定义命令（mock/测试）不加参数
    if (!process.env.DIRECTOR_PI_CMD) {
      const mcpPort = Number(process.env.DIRECTOR_MCP_PORT ?? 4778);
      const mcpFile = writeAgentMcpConfig(mcpPort);
      if (mcpFile) cmd.push('--mcp-config', mcpFile);
    }
    // 模型透传（pi --model 支持 "provider/id" 形式）；不经过 shell，无注入风险
    if (body.model) cmd.push('--model', body.model);
    // 思考强度透传（pi --thinking）；非法级别忽略（防御式：意外值不生效）
    if (body.thinking && THINKING_LEVELS.includes(body.thinking)) {
      cmd.push('--thinking', body.thinking);
    }
    const prompt = buildAgentPrompt({
      message: body.message,
      chips: body.chips ?? [],
      graphSummary,
    });

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (text: string) => reply.raw.write(`data: ${JSON.stringify({ chunk: text })}\n\n`);
    // 用户消息先落盘（不依赖 pi 是否正常退出）；agent 全文在流结束后落盘
    appendChatMessage(ctx.projectDir, 'user', body.message);
    // 流式累积 agent 全文（pi --mode json 的 text_delta 增量拼接）；
    // 节流合并：delta 按 60ms/120 字符成块发送——逐 token 全量转发会让前端
    // 每次重渲染 ReactMarkdown，块级转发兼顾流式观感与渲染性能。
    let agentText = '';
    let pending = '';
    let flushTimer: NodeJS.Timeout | null = null;
    const flushPending = () => {
      if (pending) { send(pending); pending = ''; }
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    };
    const pushDelta = (delta: string) => {
      agentText += delta;
      pending += delta;
      if (pending.length >= 120) flushPending();
      else if (!flushTimer) flushTimer = setTimeout(flushPending, 60);
    };
    // 行回调：json 模式解析 message_update/text_delta 增量；agent_end 表示输出完成
    // （提前终止进程，不等 pi 自然退出）；其他事件忽略；非 JSON 行（自定义命令/mock）
    // 按原行转发（兼容旧行为）。返回 true 时 runAgentStream 会 kill 子进程。
    const sendCollect = (line: string): boolean => {
      const t = line.trim();
      if (t.startsWith('{')) {
        try {
          const ev = JSON.parse(t) as {
            type?: string;
            assistantMessageEvent?: { type?: string; delta?: string };
          };
          if (ev.type === 'message_update' && ev.assistantMessageEvent?.type === 'text_delta') {
            const delta = ev.assistantMessageEvent.delta ?? '';
            if (delta) pushDelta(delta);
          }
          return ev.type === 'agent_end';
        } catch {
          // 解析失败按文本行处理
        }
      }
      agentText += t + '\n';
      send(t);
      return false;
    };
    try {
      const idleMs = Number(process.env.DIRECTOR_AGENT_IDLE_MS) || 45_000;
      // 注入项目上下文（kanban KANBAN_TASK_ID 语义）：agent 进程内可感知当前项目
      const { idleKilled } = await runAgentStream(cmd, prompt, sendCollect, {
        idleTimeoutMs: idleMs,
        env: {
          DIRECTOR_PROJECT_DIR: ctx.projectDir,
          DIRECTOR_PROJECT_NAME: graph.projectName,
        },
      });
      flushPending();
      appendChatMessage(ctx.projectDir, 'agent', agentText);
      if (idleKilled) send('\n\n（输出已空闲停止）');
      reply.raw.write('data: [DONE]\n\n');
    } catch (err) {
      send(`（agent 启动失败：${err instanceof Error ? err.message : String(err)}）`);
      reply.raw.write('data: [DONE]\n\n');
    }
    reply.raw.end();
  });

  // pi 模型列表（内置面板模型下拉数据源）：解析 `pi --list-models` 表格输出
  app.get('/api/agent/models', async () => {
    const cmd = (process.env.DIRECTOR_PI_LIST_CMD ?? 'pi --list-models').split(' ').filter(Boolean);
    const { stdout } = await runAgentCollect(cmd);
    const models: Array<{ id: string; provider: string; thinking: boolean; images: boolean }> = [];
    for (const line of stdout.split('\n')) {
      const cells = line.trim().split(/\s+/);
      // 表头行与空行跳过；合法行：provider model context max-out thinking images
      if (cells.length < 6 || cells[0] === 'provider') continue;
      const [provider, model, , , thinking, images] = cells;
      if (!provider || !model) continue;
      models.push({
        id: `${provider}/${model}`,
        provider: provider!,
        thinking: thinking === 'yes',
        images: images === 'yes',
      });
    }
    return { models };
  });

  // DirectorError → HTTP 状态码
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DirectorError) {
      const status = err.code === 'CONFIRM_REQUIRED' ? 400
        : err.code === 'SNAPSHOT_FUTURE_EXISTS' ? 409
        : err.code === 'NODE_NOT_FOUND' || err.code === 'EDGE_NOT_FOUND' ? 404
        : 400;
      reply.code(status).send({ code: err.code, message: err.message });
      return;
    }
    reply.code(500).send({ code: 'INTERNAL', message: err.message });
  });
}