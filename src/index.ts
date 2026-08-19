import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import type http from 'node:http';
import { join, resolve } from 'node:path';
import { mountRoutes, type ProjectContext } from './api/routes.js';
import { registerWs } from './api/ws.js';
import { ComfyUIClient } from './comfy/client.js';
import { GenerationQueue } from './generation/queue.js';
import { readLastProject, rememberLastProject, resolveComfyUrl } from './projects/projects-store.js';
import { startMcpServer } from './mcp/server.js';

export interface BuildOptions {
  // 未传入时以“未打开项目”启动；显式传入仅用于真实项目启动或测试注入。
  projectDir?: string;
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
  // 使用仓库外的占位路径维持 watcher/队列对象的字符串契约；
  // projectOpen=false 时所有项目 API 会在路由前置钩子中拒绝，不会读写此路径或 cwd。
  const projectDir = opts.projectDir ?? join(process.cwd(), '.director-no-project');
  const ctx: ProjectContext = {
    projectDir,
    projectOpen: opts.projectDir !== undefined,
    comfy: new ComfyUIClient(opts.comfyBaseUrl ? opts.comfyBaseUrl : resolveComfyUrl(projectDir)),
    queue: null as unknown as GenerationQueue,
  };
  ctx.queue = new GenerationQueue(ctx.projectDir, ctx.comfy);
  const server: http.Server = app.server;
  const wsHandle = registerWs(server, () => ctx.projectDir);
  mountRoutes(app, ctx, wsHandle);
  app.addHook('onClose', async () => { await wsHandle.close(); });
  // 显式传入 mcpPort 才启用 MCP（CLI 入口传；测试不传避免固定端口冲突）。
  // 只注册延迟启动函数，不在 buildApp 阶段启动：Director HTTP API 必须先监听，
  // 否则 Vite 会在后端初始化 MCP 时连续请求并收到 ECONNREFUSED。
  if (opts.mcpPort !== undefined) {
    let mcpPromise: Promise<Awaited<ReturnType<typeof startMcpServer>>> | null = null;
    let mcpStarted = false;
    const startMcp = (): Promise<Awaited<ReturnType<typeof startMcpServer>>> => {
      if (!mcpPromise) {
        mcpStarted = true;
        mcpPromise = startMcpServer({
          ctx,
          port: opts.mcpPort!,
          // agent 活动回传：MCP 工具调用 → WS 广播（kanban hooks 语义，best-effort 由 ws 层保证）
          onActivity: (text) => wsHandle.broadcastActivity(text),
        });
      }
      return mcpPromise;
    };
    app.addHook('onClose', async () => {
      if (!mcpPromise) return;
      const handle = await mcpPromise.catch(() => null);
      await handle?.close();
    });
    // 暴露给 CLI 在 HTTP listen 成功后启动；测试用它验证启动顺序。
    (app as unknown as {
      startMcp: typeof startMcp;
      mcpStarted: boolean;
    }).startMcp = startMcp;
    Object.defineProperty(app, 'mcpStarted', {
      get: () => mcpStarted,
      configurable: true,
    });
  }
  // 暴露文件监听就绪 Promise（测试等 watcher 初始化完成后再改文件，避免变更丢失）
  (app as unknown as { __wsReady: Promise<void> }).__wsReady = wsHandle.ready;
  return app;
}

// 直接运行时启动监听
if (import.meta.url === `file://${process.argv[1]}`) {
  const explicitProjectDir = process.argv[2];
  const projectDir = explicitProjectDir ? resolve(explicitProjectDir) : readLastProject() ?? undefined;
  const mcpPort = Number(process.env.DIRECTOR_MCP_PORT ?? 4778);
  if (projectDir) rememberLastProject(projectDir);
  const app = buildApp({ projectDir, mcpPort });
  app.listen({ port: 4777, host: '127.0.0.1' }).then(() => {
    console.log(`Director Server 已启动: http://127.0.0.1:4777 (项目: ${projectDir ?? '未打开'})`);
    const startMcp = (app as unknown as { startMcp: () => Promise<{ url: string }> }).startMcp;
    void startMcp()
      .then((h) => console.log(`MCP Server: ${h.url}`))
      .catch((err) => console.error(`MCP Server 启动失败: ${err instanceof Error ? err.message : String(err)}`));
  });
}
