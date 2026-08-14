import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpServer } from './server.js';
import { ComfyUIClient } from '../comfy/client.js';
import { GenerationQueue } from '../generation/queue.js';
import { listSnapshots } from '../snapshots/snapshot-store.js';

let dir: string;
let mcp: { url: string; close: () => Promise<void> };
let client: Client;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'director-mcp-'));
  const queue = new GenerationQueue(dir, new ComfyUIClient('http://127.0.0.1:59999'));
  mcp = await startMcpServer({ projectDir: dir, queue, port: 0 });
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
