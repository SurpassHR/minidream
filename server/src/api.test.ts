import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'node:http';
import { createDirectorMCPServer } from './mcp/server.js';
import { TaskQueue } from './tasks/queue.js';
import path from 'node:path';
import fs from 'node:fs';

describe('Server API Routes', () => {
  const tmpTasksFile = path.resolve(__dirname, '../data/test-api-tasks.json');
  const tmpSettingsFile = path.resolve(__dirname, '../data/test-api-settings.json');

  const app = express();
  app.use(express.json());

  const queue = new TaskQueue({
    dataFile: tmpTasksFile,
    settingsFile: tmpSettingsFile,
  });
  const mcp = createDirectorMCPServer(queue);

  app.post('/api/mcp', async (req, res) => {
    try {
      const response = await mcp.handleRpcMessage(req.body);
      res.json(response);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/tasks', (_req, res) => {
    res.json(queue.listTasks());
  });

  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    if (fs.existsSync(tmpTasksFile)) fs.unlinkSync(tmpTasksFile);
    if (fs.existsSync(tmpSettingsFile)) fs.unlinkSync(tmpSettingsFile);
  });

  it('POST /api/mcp 能够处理 JSON-RPC initialize 与 tools/list', async () => {
    const initRes = await fetch(`${baseUrl}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    const initData = await initRes.json();
    expect(initRes.status).toBe(200);
    expect(initData.result.serverInfo.name).toBe('director-workbench-mcp');

    const toolsRes = await fetch(`${baseUrl}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    const toolsData = await toolsRes.json();
    expect(toolsRes.status).toBe(200);
    expect(toolsData.result.tools.some((t: any) => t.name === 'generation.submit')).toBe(true);
  });

  it('GET /api/tasks 可以读取任务列表', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`);
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
  });
});
