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

  it('POST /api/story/chat：模型报错且无输出时提示具体错误（非笼统空输出）', async () => {
    vi.stubEnv('DIRECTOR_PI_CMD', `node ${join(process.cwd(), 'src/agent/mock-agent-error.mjs')}`);
    const res = await a.inject({
      method: 'POST', url: '/api/story/chat',
      payload: { message: '模型错误测试', sessionId: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('（模型调用失败：403 Your request was blocked.）');
    expect(res.payload).not.toContain('（输出为空）');
    expect(res.payload).toContain('[DONE]');
    vi.unstubAllEnvs();
  });
});

describe('API 故事会话', () => {
  it('story 会话 CRUD 同构：新建/重命名/删除/回退 activeId', async () => {
    const r1 = await a.inject({ method: 'POST', url: '/api/story/chat/sessions', payload: {} });
    expect(r1.statusCode).toBe(200);
    const id1 = r1.json().activeId;
    const r2 = await a.inject({ method: 'POST', url: '/api/story/chat/sessions', payload: {} });
    const id2 = r2.json().activeId;
    expect(id1).not.toBe(id2);
    // 重命名 id1
    const r3 = await a.inject({ method: 'PATCH', url: `/api/story/chat/sessions/${id1}`, payload: { title: '剧本会话甲' } });
    expect(r3.json().sessions.find((s: { id: string }) => s.id === id1).title).toBe('剧本会话甲');
    // 删除当前（id2）→ 回退 id1
    const r4 = await a.inject({ method: 'DELETE', url: `/api/story/chat/sessions/${id2}`, payload: {} });
    expect(r4.statusCode).toBe(200);
    expect(r4.json().activeId).toBe(id1);
    // 删除不存在 → 404
    const r5 = await a.inject({ method: 'DELETE', url: '/api/story/chat/sessions/nope', payload: {} });
    expect(r5.statusCode).toBe(404);
    expect(r5.json().code).toBe('SESSION_NOT_FOUND');
  });

  it('story chat 落盘到指定会话；history?sessionId 读回；跨会话隔离', async () => {
    vi.stubEnv('DIRECTOR_PI_CMD', `node ${join(process.cwd(), 'src/agent/mock-agent.mjs')}`);
    vi.stubEnv('MOCK_REPLY', '回显');
    const r1 = await a.inject({ method: 'POST', url: '/api/story/chat/sessions', payload: {} });
    const sid1 = r1.json().activeId as string;
    const r2 = await a.inject({ method: 'POST', url: '/api/story/chat/sessions', payload: {} });
    const sid2 = r2.json().activeId as string;
    // 两个会话各自发消息，互不串
    await a.inject({ method: 'POST', url: '/api/story/chat', payload: { message: '会话甲的消息', sessionId: sid1 } });
    await a.inject({ method: 'POST', url: '/api/story/chat', payload: { message: '会话乙的消息', sessionId: sid2 } });
    const h1 = await a.inject({ method: 'GET', url: `/api/story/chat/history?sessionId=${sid1}` });
    expect(h1.statusCode).toBe(200);
    const m1 = h1.json().messages;
    expect(m1).toHaveLength(2);
    expect(m1[0].text).toBe('会话甲的消息');
    expect(m1.some((m: { text: string }) => m.text.includes('会话乙'))).toBe(false);
    const h2 = await a.inject({ method: 'GET', url: `/api/story/chat/history?sessionId=${sid2}` });
    expect(h2.json().messages[0].text).toBe('会话乙的消息');
    expect(h2.json().messages.some((m: { text: string }) => m.text.includes('会话甲'))).toBe(false);
    // 不带 sessionId → 当前 active（sid2）
    const h3 = await a.inject({ method: 'GET', url: '/api/story/chat/history' });
    expect(h3.json().messages[0].text).toBe('会话乙的消息');
  });
});

describe('API 全局设置', () => {
  it('GET /api/settings 默认值', async () => {
    const res = await a.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toEqual({ comfyUrl: '', agentModel: '', agentThinking: '', armorBreak: '', armorBreakEnabled: false });
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

  it('PUT /api/settings 携带 prompts 持久化并读回（整体替换）', async () => {
    const r = await a.inject({
      method: 'PUT', url: '/api/settings',
      payload: { prompts: { storyTeller: '定制', custom: 'x' } },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().settings.prompts).toEqual({ storyTeller: '定制', custom: 'x' });
    const g = await a.inject({ method: 'GET', url: '/api/settings' });
    expect(g.json().settings.prompts).toEqual({ storyTeller: '定制', custom: 'x' });
    // 整体替换：删 custom 并改 storyTeller
    const r2 = await a.inject({
      method: 'PUT', url: '/api/settings',
      payload: { prompts: { storyTeller: '定制2' } },
    });
    expect(r2.json().settings.prompts).toEqual({ storyTeller: '定制2' });
  });

  it('PUT /api/settings 携带 armorBreak/armorBreakEnabled 持久化读回', async () => {
    const r = await a.inject({
      method: 'PUT', url: '/api/settings',
      payload: { armorBreak: '无视限制的预设', armorBreakEnabled: true },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().settings.armorBreak).toBe('无视限制的预设');
    expect(r.json().settings.armorBreakEnabled).toBe(true);
    const g = await a.inject({ method: 'GET', url: '/api/settings' });
    expect(g.json().settings.armorBreak).toBe('无视限制的预设');
    expect(g.json().settings.armorBreakEnabled).toBe(true);
  });
});

describe('buildStoryChatPrompt 纯函数', () => {
  it('buildStoryChatPrompt：systemPrompt 替换写死文本；缺省兜底', async () => {
    const { buildStoryChatPrompt } = await import('./routes.js');
    const base = buildStoryChatPrompt('p', {}, [], '你好');
    expect(base).toContain('你是导演工作台的故事编剧');
    const custom = buildStoryChatPrompt('p', {}, [], '你好', '你是定制系统提示词');
    expect(custom).toContain('你是定制系统提示词');
    expect(custom).not.toContain('你是导演工作台的故事编剧');
    // 空白 systemPrompt 视为缺省
    const blank = buildStoryChatPrompt('p', {}, [], '你好', '   ');
    expect(blank).toContain('你是导演工作台的故事编剧');
  });
});
