import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, unlinkSync } from 'node:fs';
import { createMcpServer, type McpServerInstance } from './server.js';
import { TaskQueue } from '../tasks/queue.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Director MCP Server', () => {
  let mcpServer: McpServerInstance;
  let taskQueue: TaskQueue;
  let serverUrl: string;

  beforeEach(async () => {
    const testDataFile = path.resolve(__dirname, '../../data/test-mcp-tasks.json');
    taskQueue = new TaskQueue({
      dataFile: testDataFile,
      autoStart: false,
      executor: async () => {
        // 模拟执行耗时
        await new Promise(r => setTimeout(r, 100));
        return { outputs: [] };
      },
    });

    mcpServer = createMcpServer({
      taskQueue,
      port: 0,
    });

    const res = await mcpServer.start();
    serverUrl = res.url;
  });

  afterEach(async () => {
    await mcpServer.close();
  });

  function sendRpc(body: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const url = new URL(serverUrl);
      const postData = JSON.stringify(body);
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
          },
        },
        res => {
          let data = '';
          res.on('data', chunk => (data += chunk));
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`Failed to parse response: ${data}`));
            }
          });
        },
      );
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  it('handles initialize request correctly', async () => {
    const res = await sendRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    });

    expect(res.result).toBeDefined();
    expect(res.result.serverInfo.name).toBe('director-workbench-mcp');
    expect(res.result.capabilities.tools).toBeDefined();
  });

  it('lists registered tools with tools/list', async () => {
    const res = await sendRpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });

    expect(res.result).toBeDefined();
    expect(Array.isArray(res.result.tools)).toBe(true);
    const toolNames = res.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain('workflow.list');
    expect(toolNames).toContain('generation.submit');
    expect(toolNames).toContain('generation.status');
    expect(toolNames).toContain('generation.cancel');
  });

  it('calls workflow.list to inspect workflows', async () => {
    const res = await sendRpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'workflow.list',
        arguments: {},
      },
    });

    expect(res.result).toBeDefined();
    expect(res.result.content).toBeDefined();
    const parsed = JSON.parse(res.result.content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('workflow.list 过滤已停用的插件（工作流）', async () => {
    const filtered = createMcpServer({
      taskQueue,
      port: 0,
      isWorkflowEnabled: id => id !== 'image_krea2_turbo_t2i',
    });
    try {
      const res = (await filtered.handleRpcMessage({
        jsonrpc: '2.0',
        id: 30,
        method: 'tools/call',
        params: { name: 'workflow.list', arguments: {} },
      })) as any;
      const parsed = JSON.parse(res.result.content[0].text);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.some((w: any) => w.id === 'image_krea2_turbo_t2i')).toBe(false);
    } finally {
      await filtered.close();
    }
  });

  it('generation.submit 拒绝提交已停用的插件（工作流）', async () => {
    const filtered = createMcpServer({
      taskQueue,
      port: 0,
      isWorkflowEnabled: id => id !== 'image_krea2_turbo_t2i',
    });
    try {
      const res = (await filtered.handleRpcMessage({
        jsonrpc: '2.0',
        id: 31,
        method: 'tools/call',
        params: {
          name: 'generation.submit',
          arguments: { workflowId: 'image_krea2_turbo_t2i', prompt: 'should be rejected' },
        },
      })) as any;
      expect(res.result.isError).toBe(true);
      expect(JSON.stringify(res.result.content)).toMatch(/未启用/);
    } finally {
      await filtered.close();
    }
  });

  it('calls generation.submit and creates a queued task', async () => {
    const res = await sendRpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'generation.submit',
        arguments: {
          workflowId: 'image_krea2_turbo_t2i',
          prompt: 'A futuristic city glowing with neon lights in rain',
        },
      },
    });

    expect(res.result).toBeDefined();
    const parsed = JSON.parse(res.result.content[0].text);
    expect(parsed.taskId).toBeDefined();
    expect(parsed.status).toBe('queued');

    const task = taskQueue.get(parsed.taskId);
    expect(task).toBeDefined();
    expect(task?.prompt).toBe('A futuristic city glowing with neon lights in rain');
  });

  it('calls generation.status to query task status', async () => {
    const submitRes = await sendRpc({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'generation.submit',
        arguments: {
          workflowId: 'image_krea2_turbo_t2i',
          prompt: 'Test status query',
        },
      },
    });
    const { taskId } = JSON.parse(submitRes.result.content[0].text);

    const statusRes = await sendRpc({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'generation.status',
        arguments: { taskId },
      },
    });

    expect(statusRes.result).toBeDefined();
    const task = JSON.parse(statusRes.result.content[0].text);
    expect(task.id).toBe(taskId);
    expect(['queued', 'running']).toContain(task.status);
  });

  it('关闭状态轮询时 tools/list 不暴露 generation.status', async () => {
    const noPoll = createMcpServer({
      taskQueue,
      port: 0,
      isStatusPollingEnabled: () => false,
    });
    try {
      const res = (await noPoll.handleRpcMessage({
        jsonrpc: '2.0',
        id: 40,
        method: 'tools/list',
      })) as any;
      const toolNames = res.result.tools.map((t: any) => t.name);
      expect(toolNames).toContain('workflow.list');
      expect(toolNames).toContain('generation.submit');
      expect(toolNames).not.toContain('generation.status');
      expect(toolNames).toContain('generation.cancel');
      // submit 描述附带“无需轮询”提示，引导 Agent 直接收尾
      const submit = res.result.tools.find((t: any) => t.name === 'generation.submit');
      expect(submit.description).toMatch(/无需轮询/);
    } finally {
      await noPoll.close();
    }
  });

  it('关闭状态轮询时 generation.status 调用返回错误', async () => {
    const noPoll = createMcpServer({
      taskQueue,
      port: 0,
      isStatusPollingEnabled: () => false,
    });
    try {
      const res = (await noPoll.handleRpcMessage({
        jsonrpc: '2.0',
        id: 41,
        method: 'tools/call',
        params: { name: 'generation.status', arguments: { taskId: 'any' } },
      })) as any;
      expect(res.result.isError).toBe(true);
      expect(JSON.stringify(res.result.content)).toMatch(/无需/);
    } finally {
      await noPoll.close();
    }
  });

  it('calls generation.cancel to cancel a queued task', async () => {
    const submitRes = await sendRpc({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'generation.submit',
        arguments: {
          workflowId: 'image_krea2_turbo_t2i',
          prompt: 'Test cancel query',
        },
      },
    });
    const { taskId } = JSON.parse(submitRes.result.content[0].text);

    const cancelRes = await sendRpc({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'generation.cancel',
        arguments: { taskId },
      },
    });

    expect(cancelRes.result).toBeDefined();
    const parsed = JSON.parse(cancelRes.result.content[0].text);
    expect(parsed.canceled).toBe(true);

    const task = taskQueue.get(taskId);
    expect(task?.status).toBe('canceled');
  });
});
