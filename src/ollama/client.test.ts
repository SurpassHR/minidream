import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OllamaClient } from './client.js';

let mock: ReturnType<typeof Fastify>;
let baseUrl: string;
let dir: string;
// 可变开关：置 true 时 /api/chat 返回空 content（模拟模型不支持图像输入）
let emptyContent = false;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'director-ollama-'));
  emptyContent = false;
  mock = Fastify({ logger: false });
  mock.get('/api/tags', async () => ({ models: [{ name: 'llava:13b' }, { name: 'qwen2.5vl:7b' }] }));
  mock.post('/api/chat', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as { model: string; messages: Array<{ role: string; content: string; images?: string[] }>; stream: boolean };
    if (emptyContent) {
      return { model: body.model, message: { content: '   ' } };
    }
    // 回显模型名 + 首条消息的 content + 是否携带图像，供断言
    const msg = body.messages?.[0];
    reply.header('content-type', 'application/json');
    return {
      model: body.model,
      message: {
        content: `[${body.model}|${msg?.content}|${(msg?.images ?? []).length}img]`,
      },
    };
  });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const addr = mock.server.address();
  if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`;
});
afterEach(async () => {
  await mock.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('OllamaClient', () => {
  it('listModels 返回已安装模型名（排序）', async () => {
    const c = new OllamaClient(baseUrl);
    expect(await c.listModels()).toEqual(['llava:13b', 'qwen2.5vl:7b']);
  });

  it('listModels 对不可达地址抛 DirectorError', async () => {
    const c = new OllamaClient('http://127.0.0.1:59999');
    await expect(c.listModels()).rejects.toThrowError(expect.objectContaining({ code: 'INVALID_PATCH' }));
  });

  it('imageToPrompt 读取图片 base64 并调用 /api/chat，返回描述文本', async () => {
    const img = join(dir, 'ref.png');
    writeFileSync(img, 'fake-png-bytes');
    const c = new OllamaClient(baseUrl);
    const out = await c.imageToPrompt('llava:13b', img, '请描述这张图片');
    // 回显格式 [model|instruction|Nimg]：断言模型与指令透传、图像数量为 1
    expect(out).toBe('[llava:13b|请描述这张图片|1img]');
  });

  it('imageToPrompt 空 content 抛 DirectorError（模型不支持图像时）', async () => {
    emptyContent = true;
    const img = join(dir, 'ref.png');
    writeFileSync(img, 'fake-png-bytes');
    const c = new OllamaClient(baseUrl);
    await expect(c.imageToPrompt('llava:13b', img, '请描述这张图片')).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_PATCH', message: expect.stringContaining('空结果') }),
    );
  });
});
