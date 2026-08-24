import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync, unlinkSync, rmSync, mkdtempSync } from 'node:fs';
import { createMcpServer, type McpServerInstance } from './server.js';
import { TaskQueue } from '../tasks/queue.js';
import { writeCustomSkill } from '../workflow-skill.js';

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
    expect(toolNames).toContain('workflow.skill');
    expect(toolNames).toContain('generation.submit');
    expect(toolNames).toContain('generation.status');
    expect(toolNames).toContain('generation.cancel');
  });

  it('workflow.skill 返回插件的详细使用说明', async () => {
    const res = (await mcpServer.handleRpcMessage({
      jsonrpc: '2.0',
      id: 60,
      method: 'tools/call',
      params: { name: 'workflow.skill', arguments: { workflowId: 'image_krea2_turbo_t2i' } },
    })) as any;
    expect(res.result.isError).toBeFalsy();
    const text = res.result.content[0].text as string;
    expect(text).toMatch(/^---\nname: image_krea2_turbo_t2i/);
    expect(text).toMatch(/可控制参数/);
    expect(text).toMatch(/text-551/);
    expect(text).toMatch(/text-555/);
  });

  it('workflow.skill 优先返回自定义插件 Skill', async () => {
    const skillsDir = mkdtempSync(path.join(os.tmpdir(), 'mcp-skills-'));
    try {
      writeCustomSkill('image_krea2_turbo_t2i', `---\nname: image_krea2_turbo_t2i\nresponse:\n  prompt: hidden\n---\n\n# 自定义 Skill\n\n## 回复协议\n\n隐藏提示词\n`, skillsDir);
      const customServer = createMcpServer({ taskQueue, port: 0, skillsDir });
      const res = (await customServer.handleRpcMessage({
        jsonrpc: '2.0', id: 601, method: 'tools/call',
        params: { name: 'workflow.skill', arguments: { workflowId: 'image_krea2_turbo_t2i' } },
      })) as any;
      expect(res.result.content[0].text).toContain('# 自定义 Skill');
      expect(res.result.content[0].text).toContain('prompt: hidden');
      await customServer.close();
    } finally {
      rmSync(skillsDir, { recursive: true, force: true });
    }
  });

  it('workflow.skill 拒绝未启用或未知的插件', async () => {
    const filtered = createMcpServer({ taskQueue, port: 0, isWorkflowEnabled: id => id !== 'image_krea2_turbo_t2i' });
    try {
      const disabled = (await filtered.handleRpcMessage({
        jsonrpc: '2.0', id: 61, method: 'tools/call',
        params: { name: 'workflow.skill', arguments: { workflowId: 'image_krea2_turbo_t2i' } },
      })) as any;
      expect(disabled.result.isError).toBe(true);
      expect(JSON.stringify(disabled.result.content)).toMatch(/未启用/);

      const missing = (await filtered.handleRpcMessage({
        jsonrpc: '2.0', id: 62, method: 'tools/call',
        params: { name: 'workflow.skill', arguments: { workflowId: 'no_such_plugin' } },
      })) as any;
      expect(missing.result.isError).toBe(true);
      expect(JSON.stringify(missing.result.content)).toMatch(/未找到/);
    } finally {
      await filtered.close();
    }
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

  it('generation.submit 放大意图 + 参考图时自动路由到 SeedVR2 放大工作流', async () => {
    const res = await sendRpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'generation.submit',
        arguments: {
          workflowId: 'image_krea2_turbo_t2i',
          prompt: '将这张图片放大并提高清晰度',
          images: ['chat-1-0.png'],
        },
      },
    });

    const parsed = JSON.parse(res.result.content[0].text);
    expect(parsed.workflowId).toBe('image_seedvr2_upscale');
    expect(parsed.message).toMatch(/自动路由/);
    expect(parsed.route).toEqual(expect.objectContaining({
      requestedWorkflowId: 'image_krea2_turbo_t2i',
      finalWorkflowId: 'image_seedvr2_upscale',
      intent: 'image_upscale',
      referenceImageCount: 1,
      forced: true,
    }));
    expect(parsed.route.reason).toMatch(/放大意图/);
    expect(taskQueue.get(parsed.taskId)?.workflowId).toBe('image_seedvr2_upscale');
    expect(taskQueue.get(parsed.taskId)?.images).toEqual(['chat-1-0.png']);
  });

  it('generation.submit 无参考图或非放大意图时不路由', async () => {
    const resNoImg = await sendRpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'generation.submit',
        arguments: {
          workflowId: 'image_krea2_turbo_t2i',
          prompt: '放大一张夕阳下的城市图',
        },
      },
    });
    const parsedNoImg = JSON.parse(resNoImg.result.content[0].text);
    expect(parsedNoImg.workflowId).toBe('image_krea2_turbo_t2i');

    const resNoIntent = await sendRpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'generation.submit',
        arguments: {
          workflowId: 'image_krea2_turbo_t2i',
          prompt: '根据参考图生成一张赛博朋克城市',
          images: ['chat-1-0.png'],
        },
      },
    });
    const parsedNoIntent = JSON.parse(resNoIntent.result.content[0].text);
    expect(parsedNoIntent.workflowId).toBe('image_krea2_turbo_t2i');
    expect(parsedNoIntent.route).toEqual(expect.objectContaining({
      requestedWorkflowId: 'image_krea2_turbo_t2i',
      finalWorkflowId: 'image_krea2_turbo_t2i',
      intent: 'image_to_image',
      referenceImageCount: 1,
      forced: false,
    }));
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

  it('generation.status 返回脱敏数据，不暴露文件名/路径/URL', async () => {
    const queue = new TaskQueue({
      dataFile: path.resolve(__dirname, '../../data/test-mcp-tasks-sanitize.json'),
      autoStart: true,
      executor: async () => ({
        outputs: [{ kind: 'image', url: '/api/drafts/draft-abc/file', filename: 'draft-abc.png', data: Buffer.from('x') }],
      }),
    });
    const server = createMcpServer({ taskQueue: queue, port: 0 });
    try {
      const submitRes = (await server.handleRpcMessage({
        jsonrpc: '2.0',
        id: 50,
        method: 'tools/call',
        params: { name: 'generation.submit', arguments: { workflowId: 'image_krea2_turbo_t2i', prompt: 'test' } },
      })) as any;
      const { taskId } = JSON.parse(submitRes.result.content[0].text);

      // 等待任务完成
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (queue.get(taskId)?.status === 'completed') break;
        await new Promise(r => setTimeout(r, 50));
      }

      const statusRes = (await server.handleRpcMessage({
        jsonrpc: '2.0',
        id: 51,
        method: 'tools/call',
        params: { name: 'generation.status', arguments: { taskId } },
      })) as any;
      const text = statusRes.result.content[0].text;
      expect(text).toContain('"status": "completed"');
      expect(text).toContain('"outputCount": 1');
      expect(text).not.toMatch(/draft-abc|"url"|"filename"|subfolder/);
    } finally {
      await server.close();
    }
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
