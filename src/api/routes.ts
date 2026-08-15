import type { FastifyInstance } from 'fastify';
import { DirectorError, type Actor, type NodeType } from '../types.js';
import {
  createNode, updateNode, deleteNode, moveNode, createEdge, deleteEdge, loadGraph,
} from '../graph/graph-store.js';
import { syncNodeToFile } from '../sync/dual-writer.js';
import { listSnapshots, graphAtSnapshot } from '../snapshots/snapshot-store.js';
import { listWorkspace, readWorkspaceFile, searchWorkspace } from '../workspace/accessor.js';
import { readFileSync, existsSync, mkdtempSync, createWriteStream, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { applyMutation } from './mutations.js';
import { GenerationQueue } from '../generation/queue.js';
import { ComfyUIClient } from '../comfy/client.js';
import { listAssets, importAssetFile, importAssetText, deleteAsset, readAssetText } from '../assets/assets-store.js';
import { buildAgentPrompt, runAgentCollect, runAgentStream } from '../agent/bridge.js';
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

export function mountRoutes(
  app: FastifyInstance,
  ctx: ProjectContext,
  ws: WsHandle,
): void {
  const actor: Actor = 'user';

  app.get('/api/graph', async () => ({ graph: loadGraph(ctx.projectDir) }));

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
    const body = req.body as { kind: 'ref' | 'chain' | 'exec'; source: string; target: string; label?: string };
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

  app.get('/api/snapshots', async () => ({ snapshots: listSnapshots(ctx.projectDir) }));

  app.post('/api/snapshots/rollback', async (req, reply) => {
    const body = req.body as { seq: number; reason: string; confirm?: boolean };
    if (!body.confirm) {
      return reply.code(400).send({ code: 'CONFIRM_REQUIRED', message: '回滚需 confirm=true' });
    }
    // 走 applyMutation 管线（唯一写入口）：快照留痕 + WS 广播由管线保证
    let resultGraph;
    applyMutation(ctx.projectDir, actor, `回滚至 SN-${body.seq}: ${body.reason}`, (g) => {
      const target = graphAtSnapshot(ctx.projectDir, body.seq);
      g.nodes = target.nodes;
      g.edges = target.edges;
      g.projectName = target.projectName;
      resultGraph = g;
    });
    return { graph: resultGraph };
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

  // —— 计划 4 Task 3：pi 桥 SSE 流式对话 ——
  app.post('/api/agent/chat', async (req, reply) => {
    const body = req.body as {
      message: string;
      chips?: Array<{ name: string; content: string }>;
      model?: string;
    };
    // 画布摘要：节点类型计数（agent 上下文，避免全量图塞爆提示词）
    const graph = loadGraph(ctx.projectDir);
    const counts = new Map<string, number>();
    for (const n of graph.nodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
    const graphSummary = [...counts.entries()].map(([t, c]) => `${c}×${t}`).join(' · ') || '空画布';

    const cmd = (process.env.DIRECTOR_PI_CMD ?? 'pi --print').split(' ').filter(Boolean);
    // 模型透传（pi --model 支持 "provider/id" 形式）；不经过 shell，无注入风险
    if (body.model) cmd.push('--model', body.model);
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
    try {
      await runAgentStream(cmd, prompt, send);
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
        : err.code === 'NODE_NOT_FOUND' || err.code === 'EDGE_NOT_FOUND' ? 404
        : 400;
      reply.code(status).send({ code: err.code, message: err.message });
      return;
    }
    reply.code(500).send({ code: 'INTERNAL', message: err.message });
  });
}