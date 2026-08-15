import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import type http from 'node:http';
import { mountRoutes, type ProjectContext } from './api/routes.js';
import { registerWs } from './api/ws.js';
import { ComfyUIClient } from './comfy/client.js';
import { GenerationQueue } from './generation/queue.js';
import { resolveComfyUrl } from './projects/projects-store.js';
import { startMcpServer } from './mcp/server.js';

export interface BuildOptions {
  projectDir: string;
  comfyBaseUrl?: string; // 测试注入 mock 地址
  mcpPort?: number;      // 显式传入才启动 MCP server（测试不传，避免端口冲突）
}

// 构建 Fastify 应用实例；测试用 inject，不需要监听端口
// watcher/wss 随 app.close() 一并关闭（onClose 钩子）
export function buildApp(opts: BuildOptions) {
  const app = Fastify({ logger: false });
  // 素材库 multipart 上传：单文件、上限 500MB（计划 5 全局约束）
  void app.register(multipart, { limits: { fileSize: 500 * 1024 * 1024, files: 1 } });
  // 健康检查（Task 1 交付，验收冒烟依赖）
  app.get('/health', async () => ({ ok: true }));
  // 项目上下文：单一可变事实来源，/api/project/switch 热切换时整体替换（routes.ts 维护）
  const ctx: ProjectContext = {
    projectDir: opts.projectDir,
    comfy: new ComfyUIClient(opts.comfyBaseUrl ? opts.comfyBaseUrl : resolveComfyUrl(opts.projectDir)),
    queue: null as unknown as GenerationQueue,
  };
  ctx.queue = new GenerationQueue(ctx.projectDir, ctx.comfy);
  const server: http.Server = app.server;
  const wsHandle = registerWs(server, () => ctx.projectDir);
  mountRoutes(app, ctx, wsHandle);
  app.addHook('onClose', async () => { await wsHandle.close(); });
  // 显式传入 mcpPort 才启动 MCP server（CLI 入口传；测试不传避免固定端口冲突）
  if (opts.mcpPort !== undefined) {
    const mcpPromise = startMcpServer({
      ctx,
      port: opts.mcpPort,
      // agent 活动回传：MCP 工具调用 → WS 广播（kanban hooks 语义，best-effort 由 ws 层保证）
      onActivity: (text) => wsHandle.broadcastActivity(text),
    });
    mcpPromise.then((h) => console.log(`MCP Server: ${h.url}`));
    app.addHook('onClose', async () => { (await mcpPromise).close(); });
    // 暴露给调用方（测试/CLI 可查）
    (app as unknown as { __mcpReady: Promise<Awaited<ReturnType<typeof startMcpServer>>> }).__mcpReady = mcpPromise;
  }
  // 暴露文件监听就绪 Promise（测试等 watcher 初始化完成后再改文件，避免变更丢失）
  (app as unknown as { __wsReady: Promise<void> }).__wsReady = wsHandle.ready;
  return app;
}

// 直接运行时启动监听
if (import.meta.url === `file://${process.argv[1]}`) {
  const projectDir = process.argv[2] ?? process.cwd();
  const mcpPort = Number(process.env.DIRECTOR_MCP_PORT ?? 4778);
  const app = buildApp({ projectDir, mcpPort });
  app.listen({ port: 4777, host: '127.0.0.1' }).then(() => {
    console.log(`Director Server 已启动: http://127.0.0.1:4777 (项目: ${projectDir})`);
  });
}
