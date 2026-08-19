import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OllamaClient } from './client.js';
import sharp from 'sharp';

let mock: ReturnType<typeof Fastify>;
let baseUrl: string;
let dir: string;
// 可变开关：置 true 时 /api/chat 返回空 content（模拟模型不支持图像输入）
let emptyContent = false;
let contextErrorOnce = false;
let chatBodies: Array<{ keep_alive?: string | number; images?: string[]; options?: { num_ctx?: number; num_gpu?: number } }> = [];
let generateBodies: Array<{ model: string; keep_alive?: string | number; stream?: boolean }> = [];

beforeEach(async () => {
  delete process.env.DIRECTOR_OLLAMA_NUM_GPU;
  dir = mkdtempSync(join(tmpdir(), 'director-ollama-'));
  emptyContent = false;
  contextErrorOnce = false;
  chatBodies = [];
  generateBodies = [];
  mock = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024 });
  mock.get('/api/tags', async () => ({ models: [{ name: 'llava:13b' }, { name: 'qwen2.5vl:7b' }] }));
  mock.post('/api/generate', async (req: FastifyRequest) => {
    const body = req.body as { model: string; keep_alive?: string | number; stream?: boolean };
    generateBodies.push(body);
    return { model: body.model, done: true, done_reason: 'unload' };
  });
  mock.post('/api/chat', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as { model: string; messages: Array<{ role: string; content: string; images?: string[] }>; stream: boolean; keep_alive?: string | number; options?: { num_ctx?: number; num_gpu?: number } };
    chatBodies.push({
      keep_alive: body.keep_alive,
      images: body.messages?.[0]?.images,
      options: body.options,
    });
    if (contextErrorOnce) {
      contextErrorOnce = false;
      reply.code(400);
      return { error: JSON.stringify({ error: { code: 400, message: 'request (4125 tokens) exceeds the available context size (4096 tokens)', type: 'exceed_context_size_error', n_prompt_tokens: 4125, n_ctx: 4096 } }) };
    }
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
  vi.unstubAllEnvs();
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

  it('imageToPrompt 将超过 1536 的图片等比缩放后再发送', async () => {
    const img = join(dir, 'large-ref.png');
    const source = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: { r: 120, g: 80, b: 40 } },
    }).png().toBuffer();
    writeFileSync(img, source);
    const c = new OllamaClient(baseUrl);

    await c.imageToPrompt('llava:13b', img, '请描述这张图片');

    const sent = Buffer.from(chatBodies[0]!.images![0]!, 'base64');
    const metadata = await sharp(sent).metadata();
    expect(metadata.width).toBe(1536);
    expect(metadata.height).toBe(1024);
  });

  it('imageToPrompt 保持不超过 1536 的图片尺寸', async () => {
    const img = join(dir, 'small-ref.png');
    const source = await sharp({
      create: { width: 1000, height: 700, channels: 3, background: { r: 120, g: 80, b: 40 } },
    }).png().toBuffer();
    writeFileSync(img, source);
    const c = new OllamaClient(baseUrl);

    await c.imageToPrompt('llava:13b', img, '请描述这张图片');

    const sent = Buffer.from(chatBodies[0]!.images![0]!, 'base64');
    const metadata = await sharp(sent).metadata();
    expect(metadata.width).toBe(1000);
    expect(metadata.height).toBe(700);
  });

  it('imageToPrompt 读取图片 base64 并调用 /api/chat，返回描述文本', async () => {
    const img = join(dir, 'ref.png');
    writeFileSync(img, 'fake-png-bytes');
    const c = new OllamaClient(baseUrl);
    const out = await c.imageToPrompt('llava:13b', img, '请描述这张图片');
    // 回显格式 [model|instruction|Nimg]：断言模型与指令透传、图像数量为 1
    expect(out).toBe('[llava:13b|请描述这张图片|1img]');
  });

  it('imageToPrompt 每次请求前显式卸载已有模型', async () => {
    const img = join(dir, 'ref.png');
    writeFileSync(img, 'fake-png-bytes');
    const c = new OllamaClient(baseUrl);

    await c.imageToPrompt('llava:13b', img, '请描述这张图片');

    expect(generateBodies[0]).toMatchObject({ model: 'llava:13b', keep_alive: 0, stream: false });
  });

  it('imageToPrompt 每次请求都要求 Ollama 完成后卸载模型', async () => {
    const img = join(dir, 'ref.png');
    writeFileSync(img, 'fake-png-bytes');
    const c = new OllamaClient(baseUrl);

    await c.imageToPrompt('llava:13b', img, '请描述这张图片');

    expect(chatBodies[0]?.keep_alive).toBe(0);
  });

  it('imageToPrompt 默认不强制部分 GPU 层卸载', async () => {
    const img = join(dir, 'ref.png');
    writeFileSync(img, 'fake-png-bytes');
    const c = new OllamaClient(baseUrl);

    await c.imageToPrompt('llava:13b', img, '请描述这张图片');

    expect(chatBodies[0]?.options?.num_gpu).toBeUndefined();
  });

  it('imageToPrompt 仅在显式配置时透传 num_gpu', async () => {
    vi.stubEnv('DIRECTOR_OLLAMA_NUM_GPU', '8');
    const img = join(dir, 'ref.png');
    writeFileSync(img, 'fake-png-bytes');
    const c = new OllamaClient(baseUrl);

    await c.imageToPrompt('llava:13b', img, '请描述这张图片');

    expect(chatBodies[0]?.options?.num_gpu).toBe(8);
  });

  it('imageToPrompt 根据输入大小动态设置 num_ctx', async () => {
    const img = join(dir, 'large-ref.png');
    writeFileSync(img, Buffer.alloc(4 * 1024 * 1024));
    const c = new OllamaClient(baseUrl);

    await c.imageToPrompt('llava:13b', img, '请描述这张图片');

    expect(chatBodies[0]?.options?.num_ctx).toBeGreaterThan(4096);
  });

  it('imageToPrompt 遇到上下文超限时按 Ollama 返回的 token 数重试', async () => {
    contextErrorOnce = true;
    const img = join(dir, 'ref.png');
    writeFileSync(img, 'fake-png-bytes');
    const c = new OllamaClient(baseUrl);

    await expect(c.imageToPrompt('llava:13b', img, '请描述这张图片')).resolves.toContain('llava:13b');

    expect(chatBodies).toHaveLength(2);
    expect(chatBodies[1]?.options?.num_ctx).toBeGreaterThanOrEqual(8192);
  });

  it('imageToPrompt 超时时报告视觉推理超时而不是连接失败', async () => {
    const img = join(dir, 'ref.png');
    writeFileSync(img, 'fake-png-bytes');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new DOMException('The operation timed out', 'TimeoutError'),
    );
    try {
      await expect(new OllamaClient(baseUrl).imageToPrompt('llava:13b', img, '请描述这张图片')).rejects.toThrowError(
        expect.objectContaining({ code: 'INVALID_PATCH', message: expect.stringContaining('视觉模型推理超时') }),
      );
    } finally {
      fetchMock.mockRestore();
    }
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
