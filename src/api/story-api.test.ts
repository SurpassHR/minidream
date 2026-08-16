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

  it('GET /api/story 未完成时 md 为 null', async () => {
    const res = await a.inject({ method: 'GET', url: '/api/story' });
    expect(res.statusCode).toBe(200);
    expect(res.json().md).toBeNull();
  });

  it('POST /api/story/complete 响应含 md（buildStoryMarkdown 产物）', async () => {
    await a.inject({
      method: 'PUT', url: '/api/story',
      payload: { answers: { theme: '精灵与哥布林' } },
    });
    const res = await a.inject({ method: 'POST', url: '/api/story/complete', payload: {} });
    expect(res.statusCode).toBe(201);
    const { md } = res.json();
    expect(md).toContain('# ');
    expect(md).toContain('## 主题');
    expect(md).toContain('精灵与哥布林');
    expect(md).toContain('（未填写）'); // 未填步骤占位
  });

  it('GET /api/story 完成后返回 md', async () => {
    await a.inject({
      method: 'PUT', url: '/api/story',
      payload: { answers: { theme: '精灵与哥布林' } },
    });
    await a.inject({ method: 'POST', url: '/api/story/complete', payload: {} });
    const res = await a.inject({ method: 'GET', url: '/api/story' });
    expect(res.statusCode).toBe(200);
    expect(res.json().md).toContain('## 主题');
    expect(res.json().md).toContain('精灵与哥布林');
  });

  it('POST /api/story/complete 重复调用不重复入库', async () => {
    await a.inject({ method: 'POST', url: '/api/story/complete', payload: {} });
    const res2 = await a.inject({ method: 'POST', url: '/api/story/complete', payload: {} });
    expect(res2.statusCode).toBe(409);
    expect(res2.json().code).toBe('STORY_ALREADY_COMPLETED');
    expect(listAssets()).toHaveLength(1);
  });

  it('完成后 PUT /api/story 带 answers 返回 409（STORY_ALREADY_COMPLETED）且不写入', async () => {
    await a.inject({
      method: 'PUT', url: '/api/story',
      payload: { answers: { theme: '精灵与哥布林' } },
    });
    await a.inject({ method: 'POST', url: '/api/story/complete', payload: {} });
    const res = await a.inject({
      method: 'PUT', url: '/api/story',
      payload: { answers: { theme: '被改写' } },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('STORY_ALREADY_COMPLETED');
    // answers 未被写入（GET 重建 md 仍与入库素材一致）
    expect(readStory(dir).answers.theme).toBe('精灵与哥布林');
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

  it('POST /api/story/chat 带 persistAs：落盘用标记而非长指令原文', async () => {
    vi.stubEnv('DIRECTOR_PI_CMD', `node ${join(process.cwd(), 'src/agent/mock-agent.mjs')}`);
    vi.stubEnv('MOCK_REPLY', 'mock');
    const longInstruction = '你是导演工作台的故事编剧……'.repeat(10);
    const res = await a.inject({
      method: 'POST', url: '/api/story/chat',
      payload: { message: longInstruction, persistAs: '（请总结成稿）' },
    });
    expect(res.statusCode).toBe(200);
    // 历史中用户消息为标记而非长指令
    const hist = await a.inject({ method: 'GET', url: '/api/story/chat/history' });
    const messages = hist.json().messages;
    expect(messages[0].who).toBe('user');
    expect(messages[0].text).toBe('（请总结成稿）');
    expect(messages[0].text).not.toContain('故事编剧');
  });
});

describe('API 全局设置', () => {
  it('GET /api/settings 默认值', async () => {
    const res = await a.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toEqual({ comfyUrl: '', agentModel: '', agentThinking: '' });
  });

  it('PUT /api/settings 保存并读回（comfyUrl 热切换写回 project 节点）', async () => {
    const res = await a.inject({
      method: 'PUT', url: '/api/settings',
      payload: { comfyUrl: 'http://127.0.0.1:59999', agentModel: 'anthropic/claude-sonnet-4', agentThinking: 'medium' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.agentModel).toBe('anthropic/claude-sonnet-4');
    // project 节点已写入 comfyuiUrl
    const g = await a.inject({ method: 'GET', url: '/api/graph' });
    const proj = g.json().graph.nodes.find((n: { type: string }) => n.type === 'project');
    expect(proj?.fields.comfyuiUrl).toBe('http://127.0.0.1:59999');
    // 读回持久化
    const r2 = await a.inject({ method: 'GET', url: '/api/settings' });
    expect(r2.json().settings.agentThinking).toBe('medium');
  });
});
