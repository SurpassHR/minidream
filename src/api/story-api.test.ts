import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { basename, join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../index.js';
import { listAssets, importAssetFile, importAssetText } from '../assets/assets-store.js';
import { readStory } from '../story/store.js';
import { saveSettings } from '../settings/settings-store.js';

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
  it('MCP 配置可为空，供故事聊天隔离画布工具', async () => {
    const { writeAgentMcpConfig } = await import('./routes.js');
    const file = writeAgentMcpConfig(4778, false);
    expect(file).toBeTruthy();
    expect(JSON.parse(readFileSync(file!, 'utf8'))).toEqual({ mcpServers: {} });
    rmSync(file!, { force: true });
  });


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
    const assets = listAssets(dir);
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
    expect(listAssets(dir)).toHaveLength(1);
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

  it('POST /api/story/chat kickoff 使用 chat choice 契约并落盘系统标记', async () => {
    vi.stubEnv('DIRECTOR_PI_CMD', `node ${join(process.cwd(), 'src/agent/mock-agent.mjs')}`);
    vi.stubEnv('MOCK_ECHO_INPUT', '1');
    const res = await a.inject({
      method: 'POST', url: '/api/story/chat',
      payload: {
        message: '这是新会话。按系统提示词开始访谈：先问用户希望使用哪种访谈语言，然后在文末给出 choice 代码块。',
        persistAs: '（开始访谈）',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('options');
    expect(res.body).toContain('围栏语言标记为 choice');
    expect(res.body).toContain('--system-prompt');
    const hist = await a.inject({ method: 'GET', url: '/api/story/chat/history' });
    expect(hist.json().messages[0].text).toBe('（开始访谈）');
  });

  it('POST /api/story/chat 总结成稿使用 system 要求而不注入 choice 契约', async () => {
    vi.stubEnv('DIRECTOR_PI_CMD', `node ${join(process.cwd(), 'src/agent/mock-agent.mjs')}`);
    vi.stubEnv('MOCK_ECHO_INPUT', '1');
    const res = await a.inject({
      method: 'POST', url: '/api/story/chat',
      payload: { message: '请总结成稿', persistAs: '（请总结成稿）' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('每次回答 100-200 字，聚焦推进故事');
    expect(res.body).not.toContain('```choice');
    expect(res.body).toContain('--system-prompt');
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

  it('POST /api/story/chat 带图片附件：base64 → 临时文件 @file 传给 pi；空文本落盘标记', async () => {
    // mock agent 输出完整 argv（MOCK_ECHO_ARGS）：验证图片附件以 @绝对路径 传入 pi
    vi.stubEnv('DIRECTOR_PI_CMD', `node ${join(process.cwd(), 'src/agent/mock-agent.mjs')}`);
    vi.stubEnv('MOCK_ECHO_ARGS', '1');
    // 1×1 透明 PNG（真实 base64，仅验证写盘/传参链路，不做图片解码）
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const res = await a.inject({
      method: 'POST', url: '/api/story/chat',
      payload: { message: '', images: [{ name: '参考图.png', data: `data:image/png;base64,${png}` }] },
    });
    expect(res.statusCode).toBe(200);
    // mock 输出的 argv 行经 SSE chunk 帧回传：断言 @临时图片路径已注入 pi 参数
    expect(res.body).toContain('data: [DONE]');
    expect(res.body).toContain('@');
    expect(res.body).toContain('img-0.png');
    // 历史：仅图片无文本 → 落盘占位标记（气泡不为空）
    const hist = await a.inject({ method: 'GET', url: '/api/story/chat/history' });
    const messages = hist.json().messages;
    expect(messages[0].who).toBe('user');
    expect(messages[0].text).toBe('[图片附件]');
  });

  it('POST /api/story/chat 带文本与图片：文本原样落盘，图片仍传给 pi', async () => {
    vi.stubEnv('DIRECTOR_PI_CMD', `node ${join(process.cwd(), 'src/agent/mock-agent.mjs')}`);
    vi.stubEnv('MOCK_ECHO_ARGS', '1');
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const res = await a.inject({
      method: 'POST', url: '/api/story/chat',
      payload: { message: '参考这张图写开场', images: [{ name: 'a.png', data: `data:image/png;base64,${png}` }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('img-0.png');
    const hist = await a.inject({ method: 'GET', url: '/api/story/chat/history' });
    expect(hist.json().messages[0].text).toBe('参考这张图写开场');
  });

  it('POST /api/story/chat 文本与视频素材引用：读取文本并注入素材上下文', async () => {
    vi.stubEnv('DIRECTOR_PI_CMD', `node ${join(process.cwd(), 'src/agent/mock-agent.mjs')}`);
    vi.stubEnv('MOCK_ECHO_STDIN', '1');
    const text = importAssetText(dir, '世界观.md', '这是一个被雾笼罩的边境城镇。');
    const videoPath = join(dir, '参考视频.mp4');
    writeFileSync(videoPath, new Uint8Array([0, 1, 2]));
    const video = importAssetFile(dir, videoPath);
    const res = await a.inject({
      method: 'POST', url: '/api/story/chat',
      payload: {
        message: '结合素材继续写开场',
        assetRefs: [
          { id: text.id, name: text.name, kind: 'txt' },
          { id: video.id, name: video.name, kind: 'vid' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('文本素材「世界观.md」');
    expect(res.body).toContain('这是一个被雾笼罩的边境城镇。');
    expect(res.body).toContain('视频素材「参考视频.mp4」');
  });

  it('POST /api/story/chat 图片 data 为空/非法：忽略该图不中断对话（文本仍可发送）', async () => {
    vi.stubEnv('DIRECTOR_PI_CMD', `node ${join(process.cwd(), 'src/agent/mock-agent.mjs')}`);
    vi.stubEnv('MOCK_REPLY', 'ok');
    const res = await a.inject({
      method: 'POST', url: '/api/story/chat',
      payload: { message: '只有文本', images: [{ name: 'bad.png', data: 'data:image/png;base64,###' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('data: [DONE]');
    expect(res.body).toContain('ok');
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
    expect(res.json().settings).toEqual({
      comfyUrl: '', agentModel: '', agentThinking: '', armorBreak: '', armorBreakEnabled: false,
      ollamaUrl: '', ollamaModel: '', ollamaEmbedModel: '',
    });
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

  it('PUT /api/settings 保存主题偏好并在 GET 中读回', async () => {
    const r = await a.inject({
      method: 'PUT', url: '/api/settings',
      payload: { theme: 'light' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().settings.theme).toBe('light');
    const g = await a.inject({ method: 'GET', url: '/api/settings' });
    expect(g.json().settings.theme).toBe('light');
  });
});

describe('buildStoryChatPrompt 纯函数', () => {
  it('即使使用项目自定义角色提示词，也追加故事与画布的隔离边界', async () => {
    const { buildStoryChatPrompt } = await import('./routes.js');
    const parts = buildStoryChatPrompt('p', {}, [], '你好', '你是项目自定义编剧');
    expect(parts.systemPrompt).toContain('故事编剧不得访问、检查、描述、创建、修改、连接、删除或操作画布');
    expect(parts.systemPrompt).toContain('不得声称已经执行任何画布或节点操作');
  });


  it('将角色与协议放入 system prompt，用户上下文单独放入 user prompt', async () => {
    const { buildStoryChatPrompt } = await import('./routes.js');
    const parts = buildStoryChatPrompt(
      'p',
      {},
      [],
      '用户问题',
      '你是严格的故事编剧',
    ) as unknown as { systemPrompt: string; userPrompt: string };
    expect(parts.systemPrompt).toContain('你是严格的故事编剧');
    expect(parts.systemPrompt).toContain('故事编剧不得访问、检查、描述、创建、修改、连接、删除或操作画布');
    expect(parts.systemPrompt).toContain('不得声称已经执行任何画布或节点操作');
    expect(parts.systemPrompt).toContain('文末必须追加且仅追加一个 choice 代码块');
    expect(parts.userPrompt).toContain('用户问题');
    expect(parts.userPrompt).not.toContain('你是严格的故事编剧');
  });

  it('chat 模式注入 choice 契约，system 模式保持总结成稿旧要求', async () => {
    const { buildStoryChatPrompt } = await import('./routes.js');
    const chat = buildStoryChatPrompt('p', {}, [], '你好', undefined, undefined, 'chat');
    expect(chat.systemPrompt).toContain('文末必须追加且仅追加一个 choice 代码块');
    expect(chat.systemPrompt).toContain('不要把「其他 / 自定义 / 我自己说」放进 options');
    expect(chat.systemPrompt).toContain('choice 块必须是合法 JSON');

    const system = buildStoryChatPrompt('p', {}, [], '你好', undefined, undefined, 'system');
    expect(system.systemPrompt).toContain('每次回答 100-200 字，聚焦推进故事');
    expect(system.systemPrompt).toContain('用中文回答');
    expect(system.systemPrompt).not.toContain('```choice');
    expect(system.systemPrompt).not.toContain('choice 代码块');
  });

  it('buildStoryChatPrompt：systemPrompt 替换写死文本；缺省兜底', async () => {
    const { buildStoryChatPrompt, isVisionUnsupportedError } = await import('./routes.js');
    const base = buildStoryChatPrompt('p', {}, [], '你好');
    expect(base.systemPrompt).toContain('你是导演工作台的故事编剧');
    const custom = buildStoryChatPrompt('p', {}, [], '你好', '你是定制系统提示词');
    expect(custom.systemPrompt).toContain('你是定制系统提示词');
    expect(custom.systemPrompt).not.toContain('你是导演工作台的故事编剧');
    // 空白 systemPrompt 视为缺省
    const blank = buildStoryChatPrompt('p', {}, [], '你好', '   ');
    expect(blank.systemPrompt).toContain('你是导演工作台的故事编剧');
    // RAG 注入用户上下文，不混入 system prompt
    const withRag = buildStoryChatPrompt('p', {}, [], '你好', undefined, '知识库检索（RAG）命中：- [设定.md] xxx');
    expect(withRag.userPrompt).toContain('知识库检索（RAG）命中');
    expect(withRag.systemPrompt).not.toContain('知识库检索（RAG）命中');
    expect(isVisionUnsupportedError('model does not support image inputs')).toBe(true);
    expect(isVisionUnsupportedError('403 Your request was blocked.')).toBe(false);
  });
});

describe('API 剧本项目（boards：项目级提示词 + RAG）', () => {
  it('GET /api/story/boards 空库自动落 Minimax-H3 Prompt Writer 默认板', async () => {
    const res = await a.inject({ method: 'GET', url: '/api/story/boards' });
    expect(res.statusCode).toBe(200);
    expect(res.json().boards).toHaveLength(1);
    expect(res.json().boards[0].name).toBe('Minimax-H3 Prompt Writer');
  });

  it('默认 Minimax-H3 Prompt Writer 也可以重命名', async () => {
    const initial = await a.inject({ method: 'GET', url: '/api/story/boards' });
    const defaultBoard = initial.json().boards[0];
    expect(defaultBoard.name).toBe('Minimax-H3 Prompt Writer');
    const renamed = await a.inject({
      method: 'PATCH', url: `/api/story/boards/${defaultBoard.id}`,
      payload: { name: '雾中的邮差' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().boards.find((b: { id: string }) => b.id === defaultBoard.id).name).toBe('雾中的邮差');
  });

  it('创建 / 重命名 / 保存提示词 / RAG 开关与资产 / 删除', async () => {
    const created = await a.inject({ method: 'POST', url: '/api/story/boards', payload: { name: '星尘历险记' } });
    const board = created.json().boards.find((b: { name: string }) => b.name === '星尘历险记');
    expect(board).toBeTruthy();
    const id = board.id;
    const renamed = await a.inject({ method: 'PATCH', url: `/api/story/boards/${id}`, payload: { name: '星尘 v2' } });
    expect(renamed.json().boards.find((b: { id: string }) => b.id === id).name).toBe('星尘 v2');
    // 项目级系统提示词（整体替换，空键清空）
    const prompts = await a.inject({
      method: 'PUT', url: `/api/story/boards/${id}/system-prompts`,
      payload: { storyTeller: '你是星尘历险记的专属编剧', storySummarize: '' },
    });
    expect(prompts.json().board.systemPrompts).toEqual({ storyTeller: '你是星尘历险记的专属编剧' });
    // RAG 开关 + 添加资产（txt 素材）
    const asset = importAssetText(dir, '故事设定', '星尘历险记世界观：2890 年，人类殖民 12 个星系。');
    const on = await a.inject({ method: 'POST', url: `/api/story/boards/${id}/rag/toggle`, payload: { enabled: true } });
    expect(on.json().board.ragEnabled).toBe(true);
    const added = await a.inject({ method: 'POST', url: `/api/story/boards/${id}/rag/assets`, payload: { assetId: asset.id } });
    expect(added.json().board.ragAssets).toContain(asset.id);
    const removed = await a.inject({ method: 'DELETE', url: `/api/story/boards/${id}/rag/assets/${asset.id}` });
    expect(removed.json().board.ragAssets).toEqual([]);
    const del = await a.inject({ method: 'DELETE', url: `/api/story/boards/${id}` });
    expect(del.json().boards.find((b: { id: string }) => b.id === id)).toBeUndefined();
  });

  it('RAG 检索：未配置 Ollama 返回 unconfigured（优雅降级）', async () => {
    const boards = (await a.inject({ method: 'GET', url: '/api/story/boards' })).json().boards;
    const res = await a.inject({
      method: 'POST', url: `/api/story/boards/${boards[0].id}/rag/search`,
      payload: { query: '世界观是什么', topK: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('unconfigured');
    expect(res.json().hits).toEqual([]);
  });

  it('RAG 检索：Ollama embedding 命中片段（mock /api/embed）', async () => {
    saveSettings({ ollamaUrl: 'http://127.0.0.1:59999', ollamaEmbedModel: 'nomic-embed-text' });
    const asset = importAssetText(dir, '设定.md', '第一段：星尘历险记发生在 2890 年，人类殖民 12 个星系，主角是失忆的星图测绘员。'.repeat(10) + '\n\n' + '第二段：空间站回声是叛军母港，主角在废弃空间站醒来。'.repeat(10));
    const boards = (await a.inject({ method: 'GET', url: '/api/story/boards' })).json().boards;
    const id = boards[0].id;
    await a.inject({ method: 'POST', url: `/api/story/boards/${id}/rag/toggle`, payload: { enabled: true } });
    await a.inject({ method: 'POST', url: `/api/story/boards/${id}/rag/assets`, payload: { assetId: asset.id } });
    // mock Ollama /api/embed：全部返回同一向量（余弦=1）→ 验证分块/注入链路
    const embedFetch = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input?: string[] };
      const input = body.input ?? [];
      return new Response(JSON.stringify({ embeddings: input.map(() => [0.1, 0.2, 0.3]) }), { status: 200 });
    });
    vi.stubGlobal('fetch', embedFetch);
    try {
      const res = await a.inject({
        method: 'POST', url: `/api/story/boards/${id}/rag/search`,
        payload: { query: '叛军母港', topK: 2 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('ok');
      expect(res.json().hits).toHaveLength(2);
      expect(res.json().hits[0].name).toBe('设定.md');
      expect(res.json().hits[0].text).toContain('2890');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('story chat 带 boardId：项目提示词回退 + 会话归组', async () => {
    const boards = (await a.inject({ method: 'GET', url: '/api/story/boards' })).json().boards;
    const id = boards[0].id;
    await a.inject({ method: 'PUT', url: `/api/story/boards/${id}/system-prompts`, payload: { storyTeller: '你是项目专属编剧', storySummarize: '' } });
    const s = await a.inject({ method: 'POST', url: '/api/story/chat/sessions', payload: { boardId: id } });
    const sid = s.json().activeId;
    // mock agent（同既有会话隔离测试）：项目提示词注入由后端完成
    vi.stubEnv('DIRECTOR_PI_CMD', `node ${join(process.cwd(), 'src/agent/mock-agent.mjs')}`);
    vi.stubEnv('MOCK_REPLY', '按项目设定创作');
    try {
      const chat = await a.inject({
        method: 'POST', url: '/api/story/chat',
        payload: { message: '帮我写开篇', boardId: id, sessionId: sid },
      });
      expect(chat.statusCode).toBe(200);
      // 会话列表按 boardId 过滤：归组会话可见；未归组会话（无 boardId）不可见
      const plain = await a.inject({ method: 'POST', url: '/api/story/chat/sessions', payload: {} });
      const plainId = plain.json().activeId;
      const list = await a.inject({ method: 'GET', url: `/api/story/chat/sessions?boardId=${id}` });
      expect(list.json().sessions.map((x: { id: string }) => x.id)).toContain(sid);
      expect(list.json().sessions.map((x: { id: string }) => x.id)).not.toContain(plainId);
      // 无 boardId = 全量视图（旧客户端兼容）：两者都在
      const all = await a.inject({ method: 'GET', url: '/api/story/chat/sessions' });
      expect(all.json().sessions.map((x: { id: string }) => x.id)).toEqual(
        expect.arrayContaining([sid, plainId]),
      );
    } finally {
      delete process.env.DIRECTOR_PI_CMD;
      delete process.env.MOCK_REPLY;
    }
  });
});
