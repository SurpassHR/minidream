import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import { buildApp } from '../index.js';
import { saveSettings } from '../settings/settings-store.js';
import { importAssetFile } from '../assets/assets-store.js';

// —— Ollama 图像转提示词 API：mock Ollama 服务 + 隔离 HOME（settings/assets 落到临时目录）——
let ollama: ReturnType<typeof Fastify>;
let ollamaUrl: string;
let home: string;
let dir: string;
let a: Awaited<ReturnType<typeof buildApp>>;
// 记录最近一次 /api/chat 请求体（断言 base64 图像/模型/指令透传）
let lastChatBody: { model: string; messages: Array<{ content: string; images?: string[] }>; stream: boolean } | null = null;

beforeEach(async () => {
  // 隔离 HOME：settings.json 与素材库不污染真实 ~/.director
  home = mkdtempSync(join(tmpdir(), 'director-home-ollama-'));
  vi.stubEnv('HOME', home);
  // mock Ollama 服务
  ollama = Fastify({ logger: false });
  ollama.get('/api/tags', async () => ({ models: [{ name: 'llava:13b' }, { name: 'qwen2.5vl:7b' }] }));
  ollama.post('/api/chat', async (req: FastifyRequest) => {
    lastChatBody = req.body as typeof lastChatBody;
    return { model: lastChatBody!.model, message: { content: '银发精灵骑士，身着墨绿斗篷，手持发光长剑' } };
  });
  await ollama.listen({ port: 0, host: '127.0.0.1' });
  const addr = ollama.server.address();
  if (addr && typeof addr === 'object') ollamaUrl = `http://127.0.0.1:${addr.port}`;
  // 应用实例
  dir = mkdtempSync(join(tmpdir(), 'director-ollama-api-'));
  a = buildApp({ projectDir: dir, comfyBaseUrl: 'http://127.0.0.1:59999' });
  // 预置 Ollama 配置 + 一张图片素材（图像转提示词的输入）
  saveSettings({ ollamaUrl, ollamaModel: 'llava:13b' });
  const imgDir = mkdtempSync(join(tmpdir(), 'director-ollama-img-'));
  const imgPath = join(imgDir, 'ref.png');
  writeFileSync(imgPath, 'fake-png-bytes');
  importAssetFile(imgPath);
  rmSync(imgDir, { recursive: true, force: true });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  delete process.env.DIRECTOR_WATCH_POLLING;
  await a.close();
  await ollama.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  lastChatBody = null;
});

describe('API Ollama 图像转提示词', () => {
  it('GET /api/ollama/models 返回 Ollama 已安装模型', async () => {
    const res = await a.inject({ method: 'GET', url: '/api/ollama/models' });
    expect(res.statusCode).toBe(200);
    expect(res.json().models).toEqual(['llava:13b', 'qwen2.5vl:7b']);
  });

  it('GET /api/ollama/models?url= 用查询参数地址拉取（未保存地址也能预览）', async () => {
    // 清空已保存地址：不带 url 参数时返回空列表
    saveSettings({ ollamaUrl: '' });
    const empty = await a.inject({ method: 'GET', url: '/api/ollama/models' });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().models).toEqual([]);
    // 带 url 查询参数 → 从该地址拉取（设置面板「获取模型」未保存前即可预览）
    const res = await a.inject({ method: 'GET', url: `/api/ollama/models?url=${encodeURIComponent(ollamaUrl)}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().models).toEqual(['llava:13b', 'qwen2.5vl:7b']);
  });

  it('POST /api/ollama/image-to-prompt 读取素材图片调用 Ollama 并返回描述', async () => {
    const assets = (await a.inject({ method: 'GET', url: '/api/assets' })).json().assets as Array<{ id: string; kind: string }>;
    const img = assets.find((x) => x.kind === 'img');
    expect(img).toBeTruthy();
    const res = await a.inject({
      method: 'POST', url: '/api/ollama/image-to-prompt',
      payload: { assetId: img!.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().prompt).toContain('银发精灵骑士');
    // 请求体透传：模型名 + base64 图像（1 张）+ 默认指令
    expect(lastChatBody?.model).toBe('llava:13b');
    expect(lastChatBody?.messages[0]?.images).toHaveLength(1);
    expect(lastChatBody?.messages[0]?.content).toContain('文生图提示词');
    expect(lastChatBody?.stream).toBe(false);
  });

  it('POST 缺 assetId 返回 400', async () => {
    const res = await a.inject({ method: 'POST', url: '/api/ollama/image-to-prompt', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_PATCH');
  });

  it('POST 素材不存在返回 404', async () => {
    const res = await a.inject({
      method: 'POST', url: '/api/ollama/image-to-prompt',
      payload: { assetId: 'missing' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NODE_NOT_FOUND');
  });

  it('POST 非图片素材返回 400', async () => {
    // 写入一个文本素材（非 img）
    const txtDir = mkdtempSync(join(tmpdir(), 'director-ollama-txt-'));
    const txtPath = join(txtDir, 'note.txt');
    writeFileSync(txtPath, 'hello', 'utf8');
    const asset = importAssetFile(txtPath);
    rmSync(txtDir, { recursive: true, force: true });
    const res = await a.inject({
      method: 'POST', url: '/api/ollama/image-to-prompt',
      payload: { assetId: asset.id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_PATCH');
    expect(res.json().message).toContain('不是图片');
  });

  it('故事对话模型不支持视觉时：先调用 Ollama 描述图片，再发送纯文本提示词', async () => {
    vi.stubEnv('DIRECTOR_PI_CMD', `node ${join(process.cwd(), 'src/agent/mock-agent.mjs')}`);
    vi.stubEnv('MOCK_ECHO_STDIN', '1');
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const res = await a.inject({
      method: 'POST', url: '/api/story/chat',
      payload: {
        message: '根据参考图写故事开场',
        model: 'deepseek/deepseek-v4-flash',
        modelSupportsImages: false,
        images: [{ name: '参考图.png', data: `data:image/png;base64,${png}` }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(lastChatBody?.model).toBe('llava:13b');
    expect(lastChatBody?.messages[0]?.images).toHaveLength(1);
    expect(res.body).toContain('银发精灵骑士');
    // 兜底后传给文本模型的是描述提示词，不是 @临时图片参数
    expect(res.body).not.toContain('director-story-img-');
    expect(res.body).toContain('根据参考图写故事开场');
  });

  it('模型能力未知但 pi 报视觉不支持时：自动重试 Ollama 描述后的纯文本请求', async () => {
    const marker = join(home, 'vision-fallback-once');
    vi.stubEnv('DIRECTOR_PI_CMD', `node ${join(process.cwd(), 'src/agent/mock-agent.mjs')}`);
    vi.stubEnv('MOCK_VISION_ERROR_ONCE', marker);
    vi.stubEnv('MOCK_ECHO_STDIN', '1');
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const res = await a.inject({
      method: 'POST', url: '/api/story/chat',
      payload: {
        message: '模型未知时也要参考图片',
        model: 'unknown/vision-model',
        images: [{ name: '参考图.png', data: `data:image/png;base64,${png}` }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(lastChatBody?.model).toBe('llava:13b');
    expect(res.body).toContain('银发精灵骑士');
    expect(res.body).toContain('模型未知时也要参考图片');
    expect(res.body).not.toContain('director-story-img-');
  });

  it('POST 未配置 Ollama（清空地址/模型）返回 400 引导配置', async () => {
    saveSettings({ ollamaUrl: '', ollamaModel: '' });
    const assets = (await a.inject({ method: 'GET', url: '/api/assets' })).json().assets as Array<{ id: string; kind: string }>;
    const img = assets.find((x) => x.kind === 'img');
    const res = await a.inject({
      method: 'POST', url: '/api/ollama/image-to-prompt',
      payload: { assetId: img!.id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('配置 Ollama');
  });

  it('Ollama 不可达时 GET /api/ollama/models 返回空列表（不报错）', async () => {
    saveSettings({ ollamaUrl: 'http://127.0.0.1:59999', ollamaModel: 'llava' });
    const res = await a.inject({ method: 'GET', url: '/api/ollama/models' });
    expect(res.statusCode).toBe(200);
    expect(res.json().models).toEqual([]);
  });
});

describe('API 设置透传', () => {
  it('PUT /api/settings 保存 ollamaUrl/ollamaModel 并读回', async () => {
    const res = await a.inject({
      method: 'PUT', url: '/api/settings',
      payload: { ollamaUrl: 'http://127.0.0.1:11434', ollamaModel: 'qwen2.5vl:7b' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.ollamaUrl).toBe('http://127.0.0.1:11434');
    expect(res.json().settings.ollamaModel).toBe('qwen2.5vl:7b');
    const get = await a.inject({ method: 'GET', url: '/api/settings' });
    expect(get.json().settings.ollamaUrl).toBe('http://127.0.0.1:11434');
  });
});
