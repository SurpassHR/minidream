import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { basename, join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../index.js';
import { listAssets } from '../assets/assets-store.js';
import { readStory } from '../story/store.js';

let dir: string;
let a: Awaited<ReturnType<typeof buildApp>>;
let fakeHome: string;
let realHome: string;
beforeEach(async () => {
  // 隔离 HOME：素材入库落到临时目录，不污染真实 ~/.director/assets
  realHome = homedir();
  fakeHome = mkdtempSync(join(tmpdir(), 'director-home-'));
  vi.stubEnv('HOME', fakeHome);
  dir = mkdtempSync(join(tmpdir(), 'director-story-api-'));
  mkdirSync(join(dir, 'mmh3'), { recursive: true });
  a = buildApp({ projectDir: dir, comfyBaseUrl: 'http://127.0.0.1:59999' });
});
afterEach(async () => {
  vi.stubEnv('HOME', realHome);
  vi.unstubAllEnvs();
  await a.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('API 故事向导', () => {
  it('GET /api/story 返回空进度', async () => {
    const res = await a.inject({ method: 'GET', url: '/api/story' });
    expect(res.statusCode).toBe(200);
    expect(res.json().story).toEqual({ step: 0, answers: {}, completedAt: null });
  });

  it('PUT /api/story 合并保存答案', async () => {
    const r1 = await a.inject({
      method: 'PUT', url: '/api/story',
      payload: { step: 1, answers: { theme: '战争与和解' } },
    });
    expect(r1.json().story.answers.theme).toBe('战争与和解');
    const r2 = await a.inject({
      method: 'PUT', url: '/api/story',
      payload: { answers: { protagonist: '精灵骑士' } },
    });
    expect(r2.json().story.step).toBe(1);
    expect(r2.json().story.answers.protagonist).toBe('精灵骑士');
    // 落盘持久化
    expect(readStory(dir).answers.theme).toBe('战争与和解');
  });

  it('POST /api/story/complete 组装文档入库并标记完成', async () => {
    // 无项目节点时 projectName 默认为目录 basename（graph-store.loadGraph 行为）
    await a.inject({
      method: 'PUT', url: '/api/story',
      payload: { answers: { theme: '精灵与哥布林' } },
    });
    const res = await a.inject({ method: 'POST', url: '/api/story/complete', payload: {} });
    expect(res.statusCode).toBe(201);
    const { asset, story } = res.json();
    expect(asset.name).toBe(`story_${basename(dir)}.md`);
    expect(asset.kind).toBe('txt');
    expect(story.completedAt).toBeTruthy();
    // 素材已入库
    const assets = listAssets();
    expect(assets.some((x) => x.id === asset.id)).toBe(true);
  });

  it('POST /api/story/complete 重复调用不重复入库', async () => {
    await a.inject({ method: 'POST', url: '/api/story/complete', payload: {} });
    const res2 = await a.inject({ method: 'POST', url: '/api/story/complete', payload: {} });
    expect(res2.statusCode).toBe(409);
    expect(res2.json().code).toBe('STORY_ALREADY_COMPLETED');
    expect(listAssets()).toHaveLength(1);
  });

  it('POST /api/story/reset 清空进度与完成标记', async () => {
    await a.inject({
      method: 'PUT', url: '/api/story',
      payload: { step: 3, answers: { theme: 't' } },
    });
    await a.inject({ method: 'POST', url: '/api/story/complete', payload: {} });
    const res = await a.inject({ method: 'POST', url: '/api/story/reset', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().story).toEqual({ step: 0, answers: {}, completedAt: null });
    // 落盘持久化
    expect(readStory(dir)).toEqual({ step: 0, answers: {}, completedAt: null });
    // reset 后可重新 complete（409 防护解除）
    const res2 = await a.inject({ method: 'POST', url: '/api/story/complete', payload: {} });
    expect(res2.statusCode).toBe(201);
  });
});

describe('API 故事对话', () => {
  it('GET /api/story/chat/history 空历史返回空列表', async () => {
    const res = await a.inject({ method: 'GET', url: '/api/story/chat/history' });
    expect(res.statusCode).toBe(200);
    expect(res.json().messages).toEqual([]);
  });

  it('POST /api/story/chat 流式响应并落盘历史（mock pi 输出）', async () => {
    // mock pi：DIRECTOR_PI_CMD 指向 mock-agent（afterEach 的 unstubAllEnvs 统一清理）；
    // 短回复单段输出（mock-agent 按 5 字符分段，'mock' 恰好一段，避免 SSE 帧拆开断言）
    vi.stubEnv('DIRECTOR_PI_CMD', `node ${join(process.cwd(), 'src/agent/mock-agent.mjs')}`);
    vi.stubEnv('MOCK_REPLY', 'mock');
    const res = await a.inject({
      method: 'POST', url: '/api/story/chat',
      payload: { message: '你好' },
    });
    expect(res.statusCode).toBe(200);
    // SSE 帧协议：data: {"chunk":"..."} 至少一帧 + [DONE]
    expect(res.body).toContain('data: [DONE]');
    expect(res.body).toContain('mock');
    // 历史已落盘（用户消息 + agent 全文）
    const hist = await a.inject({ method: 'GET', url: '/api/story/chat/history' });
    const messages = hist.json().messages;
    expect(messages).toHaveLength(2);
    expect(messages[0].who).toBe('user');
    expect(messages[0].text).toBe('你好');
    expect(messages[1].who).toBe('agent');
    expect(messages[1].text).toBe('mock');
  });

  it('POST /api/story/chat 空消息返回 400', async () => {
    const res = await a.inject({
      method: 'POST', url: '/api/story/chat',
      payload: { message: '   ' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_PATCH');
  });
});
