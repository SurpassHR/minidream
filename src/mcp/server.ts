import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type express from 'express';
import { loadGraph } from '../graph/graph-store.js';
import { createNode, updateNode, deleteNode, moveNode, createEdge, deleteEdge } from '../graph/graph-store.js';
import { listWorkspace, readWorkspaceFile, searchWorkspace } from '../workspace/accessor.js';
import { listSnapshots, graphAtSnapshot } from '../snapshots/snapshot-store.js';
import { listAssets, importAssetFile, importAssetText } from '../assets/assets-store.js';
import { applyMutation } from '../api/mutations.js';
import type { GenerationQueue } from '../generation/queue.js';
import type { EdgeKind, NodeType } from '../types.js';

export interface McpHandle { url: string; close: () => Promise<void> }

// 创建已注册全部 17 个工具的 McpServer 实例。
// 说明：McpServer.connect() 仅允许一次（SDK 1.30 限制），且 stateless transport 不可跨请求复用，
// 因此采用官方 stateful 多 session 模式：每个客户端 session 对应一个 transport + 一个 server 实例。
function createMcpServer(projectDir: string, queue: GenerationQueue): McpServer {
  const server = new McpServer({ name: 'director-workbench', version: '0.1.0' });
  const actor = 'agent' as const;

  server.registerTool('canvas.get_graph', { description: '读取当前画布图（节点+边）' }, async () => ({
    content: [{ type: 'text', text: JSON.stringify(loadGraph(projectDir)) }],
  }));

  server.registerTool('node.create', {
    description: '创建画布节点',
    inputSchema: {
      type: z.string().describe('节点类型: project|script|subject|shot|keyframe|prompt|params|generation|asset'),
      title: z.string(),
      fields: z.record(z.string(), z.unknown()).optional(),
      position: z.object({ x: z.number(), y: z.number() }).optional(),
    },
  }, async (args) => {
    let nodeId = '';
    applyMutation(projectDir, actor, `agent 创建节点 ${args.title}`, (g) => {
      const n = createNode(g, {
        type: args.type as NodeType, title: String(args.title),
        fields: (args.fields as Record<string, unknown>) ?? {},
        position: (args.position as { x: number; y: number }) ?? { x: 0, y: 0 },
      });
      nodeId = n.id;
    });
    const node = loadGraph(projectDir).nodes.find((n) => n.id === nodeId);
    return { content: [{ type: 'text', text: JSON.stringify(node) }] };
  });

  server.registerTool('node.update', {
    description: '更新节点（patch.title / patch.fields 合并）',
    inputSchema: {
      id: z.string(),
      patch: z.record(z.string(), z.unknown()),
    },
  }, async (args) => {
    let node;
    applyMutation(projectDir, actor, `agent 更新节点 ${args.id}`, (g) => {
      node = updateNode(g, String(args.id), args.patch as Record<string, unknown>);
    });
    return { content: [{ type: 'text', text: JSON.stringify(node) }] };
  });

  server.registerTool('node.delete', {
    description: '删除节点（破坏性，confirm 必须为 true）',
    inputSchema: {
      id: z.string(),
      confirm: z.boolean().optional(),
    },
  }, async (args) => {
    if (args.confirm !== true) {
      return { content: [{ type: 'text', text: '错误：删除节点需 confirm=true' }], isError: true };
    }
    applyMutation(projectDir, actor, `agent 删除节点 ${args.id}`, (g) => { deleteNode(g, String(args.id)); });
    return { content: [{ type: 'text', text: 'ok' }] };
  });

  server.registerTool('node.move', {
    description: '移动节点坐标',
    inputSchema: {
      id: z.string(),
      x: z.number(),
      y: z.number(),
    },
  }, async (args) => {
    let node;
    applyMutation(projectDir, actor, `agent 移动节点 ${args.id}`, (g) => {
      node = moveNode(g, String(args.id), { x: Number(args.x), y: Number(args.y) });
    });
    return { content: [{ type: 'text', text: JSON.stringify(node) }] };
  });

  server.registerTool('edge.create', {
    description: '创建连线（kind: ref=创作引用 | chain=链式参考 | exec=执行流）',
    inputSchema: {
      kind: z.string(),
      source: z.string(),
      target: z.string(),
      label: z.string().optional(),
    },
  }, async (args) => {
    let edge;
    applyMutation(projectDir, actor, `agent 创建边 ${args.source}->${args.target}`, (g) => {
      edge = createEdge(g, {
        kind: args.kind as EdgeKind, source: String(args.source),
        target: String(args.target), label: args.label ? String(args.label) : undefined,
      });
    });
    return { content: [{ type: 'text', text: JSON.stringify(edge) }] };
  });

  server.registerTool('edge.delete', {
    description: '删除连线（破坏性，confirm 必须为 true）',
    inputSchema: {
      id: z.string(),
      confirm: z.boolean().optional(),
    },
  }, async (args) => {
    if (args.confirm !== true) {
      return { content: [{ type: 'text', text: '错误：删除连线需 confirm=true' }], isError: true };
    }
    applyMutation(projectDir, actor, `agent 删除边 ${args.id}`, (g) => { deleteEdge(g, String(args.id)); });
    return { content: [{ type: 'text', text: 'ok' }] };
  });

  server.registerTool('workspace.list', { description: '列举工作区文件（排除 .director/out/node_modules/.git）' }, async () => ({
    content: [{ type: 'text', text: JSON.stringify(listWorkspace(projectDir)) }],
  }));

  server.registerTool('workspace.search', {
    description: '检索工作区（文件名 glob 或内容匹配，返回命中行）',
    inputSchema: {
      q: z.string(),
    },
  }, async (args) => ({
    content: [{ type: 'text', text: JSON.stringify(searchWorkspace(projectDir, String(args.q)))}],
  }));

  server.registerTool('workspace.read', {
    description: '读取工作区文本文件',
    inputSchema: {
      path: z.string(),
    },
  }, async (args) => ({
    content: [{ type: 'text', text: readWorkspaceFile(projectDir, String(args.path)) }],
  }));

  server.registerTool('generation.submit', {
    description: '提交生成任务（generation 节点，破坏性，confirm 必须为 true）',
    inputSchema: {
      nodeId: z.string(),
      confirm: z.boolean().optional(),
    },
  }, async (args) => {
    if (args.confirm !== true) {
      return { content: [{ type: 'text', text: '错误：提交生成需 confirm=true' }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(queue.submit(String(args.nodeId))) }] };
  });

  server.registerTool('generation.status', {
    description: '查询生成任务状态',
    inputSchema: {
      nodeId: z.string(),
    },
  }, async (args) => ({
    content: [{ type: 'text', text: JSON.stringify(queue.status(String(args.nodeId)) ?? null) }],
  }));

  server.registerTool('generation.cancel', {
    description: '取消排队中的生成任务（confirm 必须为 true）',
    inputSchema: {
      nodeId: z.string(),
      confirm: z.boolean().optional(),
    },
  }, async (args) => {
    if (args.confirm !== true) {
      return { content: [{ type: 'text', text: '错误：取消生成需 confirm=true' }], isError: true };
    }
    return { content: [{ type: 'text', text: String(queue.cancel(String(args.nodeId))) }] };
  });

  server.registerTool('snapshot.list', { description: '列出版本快照（seq/时间/actor/原因）' }, async () => ({
    content: [{ type: 'text', text: JSON.stringify(listSnapshots(projectDir)) }],
  }));

  server.registerTool('snapshot.diff', {
    description: '查看某快照时刻的画布重建结果',
    inputSchema: {
      seq: z.number(),
    },
  }, async (args) => ({
    content: [{ type: 'text', text: JSON.stringify(graphAtSnapshot(projectDir, Number(args.seq))) }],
  }));

  server.registerTool('snapshot.rollback', {
    description: '回滚到指定快照（破坏性，confirm 必须为 true）',
    inputSchema: {
      seq: z.number(),
      reason: z.string(),
      confirm: z.boolean().optional(),
    },
  }, async (args) => {
    if (args.confirm !== true) {
      return { content: [{ type: 'text', text: '错误：回滚需 confirm=true' }], isError: true };
    }
    // 走 applyMutation 管线（唯一写入口）：快照留痕 + WS 广播由管线保证，与 REST 通道一致
    let resultGraph;
    applyMutation(projectDir, actor, `回滚至 SN-${args.seq}: ${String(args.reason)}`, (g) => {
      const target = graphAtSnapshot(projectDir, Number(args.seq));
      g.nodes = target.nodes;
      g.edges = target.edges;
      g.projectName = target.projectName;
      resultGraph = g;
    });
    return { content: [{ type: 'text', text: JSON.stringify(resultGraph) }] };
  });

  server.registerTool('assets.list', { description: '列出全局素材库' }, async () => ({
    content: [{ type: 'text', text: JSON.stringify(listAssets()) }],
  }));

  server.registerTool('assets.import', {
    description: '导入文件到全局素材库（txt/md/png/jpg/webp/mp4/webm/mov）',
    inputSchema: {
      sourcePath: z.string(),
    },
  }, async (args) => ({
    content: [{ type: 'text', text: JSON.stringify(importAssetFile(String(args.sourcePath))) }],
  }));

  server.registerTool('assets.import_text', {
    description: '导入文本素材（名称+内容）',
    inputSchema: {
      name: z.string(),
      content: z.string(),
    },
  }, async (args) => ({
    content: [{ type: 'text', text: JSON.stringify(importAssetText(String(args.name), String(args.content))) }],
  }));

  return server;
}

export async function startMcpServer(opts: {
  projectDir: string;
  queue: GenerationQueue;
  port: number;
}): Promise<McpHandle> {
  const { projectDir, queue } = opts;
  const app = createMcpExpressApp(); // 内置 express.json() 预解析 body + 本机 DNS 防重绑
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const servers = new Map<string, McpServer>();

  // POST：初始化请求新建 session（transport+server 各一），后续请求按 mcp-session-id 复用
  app.post('/mcp', async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    try {
      const transport = sessionId ? transports.get(sessionId) : undefined;
      if (sessionId && transport) {
        await transport.handleRequest(req, res, req.body);
      } else if (!sessionId && isInitializeRequest(req.body)) {
        const server = createMcpServer(projectDir, queue);
        let t: StreamableHTTPServerTransport;
        t = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, t);
            servers.set(sid, server);
          },
        });
        t.onclose = () => {
          const sid = t.sessionId;
          if (sid) { transports.delete(sid); servers.delete(sid); }
        };
        await server.connect(t);
        await t.handleRequest(req, res, req.body);
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: 无有效 session ID' },
          id: null,
        });
      }
    } catch (err) {
      console.error('MCP POST 处理错误:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // GET：SSE 流（按 sessionId 找 transport）
  app.get('/mcp', async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Session not found' },
        id: null,
      });
      return;
    }
    await transport.handleRequest(req, res);
  });

  // DELETE：终止 session
  app.delete('/mcp', async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Session not found' },
        id: null,
      });
      return;
    }
    await transport.handleRequest(req, res);
  });

  const httpServer = await new Promise<http.Server>((resolve) => {
    const s = app.listen(opts.port, '127.0.0.1', () => resolve(s));
  });
  const port = (httpServer.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () => {
      for (const s of servers.values()) await s.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
