import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import type http from 'node:http';
import { mountRoutes } from './api/routes.js';
import { registerWs } from './api/ws.js';
import { ComfyUIClient } from './comfy/client.js';
import { GenerationQueue } from './generation/queue.js';
import { loadGraph } from './graph/graph-store.js';
import { startMcpServer } from './mcp/server.js';

export interface BuildOptions {
  projectDir: string;
  comfyBaseUrl?: string; // 测试注入 mock 地址
  mcpPort?: number;      // 显式传入才启动 MCP server（测试不传，避免端口冲突）
}

// 从 project 节点读 ComfyUI 地址，缺省 localhost:8188
function resolveComfyUrl(projectDir: string, override?: string): string {
  if (override) return override;
  const graph = loadGraph(projectDir);
  const proj = graph.nodes.find((n) => n.type === 'project');
  const u = proj?.fields.comfyuiUrl;
  return typeof u === 'string' && u.length > 0 ? u : 'http://localhost:8188';
}

// 构建 Fastify 应用实例；测试用 inject，不需要监听端口
// watcher/wss 随 app.close() 一并关闭（onClose 钩子）
export function buildApp(opts: BuildOptions) {
  const app = Fastify({ logger: false });
  // 素材库 multipart 上传：单文件、上限 500MB（计划 5 全局约束）
  void app.register(multipart, { limits: { fileSize: 500 * 1024 * 1024, files: 1 } });
  // 健康检查（Task 1 交付，验收冒烟依赖）
  app.get('/health', async () => ({ ok: true }));
  const comfyUrl = resolveComfyUrl(opts.projectDir, opts.comfyBaseUrl);
  const comfy = new ComfyUIClient(comfyUrl);
  const queue = new GenerationQueue(opts.projectDir, comfy);
  mountRoutes(app, opts.projectDir, queue, comfy);
  const server: http.Server = app.server;
  const wsHandle = registerWs(server, opts.projectDir);
  app.addHook('onClose', async () => { await wsHandle.close(); });
  // 显式传入 mcpPort 才启动 MCP server（CLI 入口传；测试不传避免固定端口冲突）
  let mcpHandle: Awaited<ReturnType<typeof startMcpServer>> | null = null;
  if (opts.mcpPort !== undefined) {
    const mcpPromise = startMcpServer({ projectDir: opts.projectDir, queue, port: opts.mcpPort });
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
