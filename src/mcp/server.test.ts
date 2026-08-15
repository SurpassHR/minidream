import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpServer } from './server.js';
import { loadGraph } from '../graph/graph-store.js';
import { ComfyUIClient } from '../comfy/client.js';
import { GenerationQueue } from '../generation/queue.js';
import type { ProjectContext } from '../api/routes.js';
import { listSnapshots } from '../snapshots/snapshot-store.js';

let dir: string;
let mcp: { url: string; close: () => Promise<void> };
let client: Client;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'director-mcp-'));
  const queue = new GenerationQueue(dir, new ComfyUIClient('http://127.0.0.1:59999'));
  const ctx: ProjectContext = { projectDir: dir, queue, comfy: new ComfyUIClient('http://127.0.0.1:59999') };
  mcp = await startMcpServer({ ctx, port: 0 });
  client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(mcp.url));
  await client.connect(transport);
});
afterEach(async () => {
  await client.close();
  await mcp.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('MCP server', () => {
  it('canvas.get_graph 返回空图', async () => {
    const r = await client.callTool({ name: 'canvas.get_graph', arguments: {} });
    expect(r.isError ?? false).toBe(false);
    const content = r.content as Array<{ text: string }>;
    const graph = content[0]?.text ?? '';
    expect(JSON.parse(graph).projectName).toMatch(/^director-mcp-/);
  });

  it('工具调用触发 onActivity 活动回传（kanban PreToolUse 语义，含标识字段）', async () => {    const activities: string[] = [];
    const ctx2: ProjectContext = {
      projectDir: dir,
      queue: new GenerationQueue(dir, new ComfyUIClient('http://127.0.0.1:59999')),
      comfy: new ComfyUIClient('http://127.0.0.1:59999'),
    };
    const mcp2 = await startMcpServer({ ctx: ctx2, port: 0, onActivity: (text) => activities.push(text) });
    const c2 = new Client({ name: 'test2', version: '1.0.0' });
    const t2 = new StreamableHTTPClientTransport(new URL(mcp2.url));
    await c2.connect(t2);
    try {
      await c2.callTool({ name: 'node.create', arguments: { type: 'shot', title: 'SHOT 01' } });
      await c2.callTool({ name: 'node.delete', arguments: { id: 'nope', confirm: true } });
    } finally {
      await c2.close();
      await mcp2.close();
    }
    expect(activities[0]).toContain('node.create');
    expect(activities[0]).toContain('SHOT 01'); // 标题作为标识字段
    expect(activities[1]).toContain('node.delete');
    expect(activities[1]).toContain('nope'); // id 作为标识字段
  });

  it('项目热切换后 MCP 工具跟随新项目（ctx 可变引用）', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'director-mcp2-'));
    const ctx: ProjectContext = {
      projectDir: dir,
      queue: new GenerationQueue(dir, new ComfyUIClient('http://127.0.0.1:59999')),
      comfy: new ComfyUIClient('http://127.0.0.1:59999'),
    };
    const mcp2 = await startMcpServer({ ctx, port: 0 });
    const c2 = new Client({ name: 'test3', version: '1.0.0' });
    await c2.connect(new StreamableHTTPClientTransport(new URL(mcp2.url)));
    try {
      // 切换项目（模拟 /api/project/switch 替换 ctx 字段）
      ctx.projectDir = dir2;
      ctx.queue = new GenerationQueue(dir2, new ComfyUIClient('http://127.0.0.1:59999'));
      await c2.callTool({ name: 'node.create', arguments: { type: 'shot', title: 'IN-NEW' } });
      // 节点写入新项目目录，而不是旧目录
      const oldGraph = loadGraph(dir);
      const newGraph = loadGraph(dir2);
      expect(oldGraph.nodes.find((n) => n.title === 'IN-NEW')).toBeUndefined();
      expect(newGraph.nodes.find((n) => n.title === 'IN-NEW')).toBeTruthy();
    } finally {
      await c2.close();
      await mcp2.close();
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('node.create 以 agent actor 写画布并留快照', async () => {
    const r = await client.callTool({
      name: 'node.create',
      arguments: { type: 'shot', title: 'SHOT 01' },
    });
    expect(r.isError ?? false).toBe(false);
    const snaps = listSnapshots(dir);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.actor).toBe('agent');
  });

  it('node.delete 缺 confirm 返回错误文本', async () => {
    const created = await client.callTool({ name: 'node.create', arguments: { type: 'shot', title: 'S' } });
    const createdContent = created.content as Array<{ text: string }>;
    const node = JSON.parse(createdContent[0]?.text ?? '{}');
    const r = await client.callTool({ name: 'node.delete', arguments: { id: node.id, confirm: false } });
    expect(r.isError).toBe(true);
  });
});
