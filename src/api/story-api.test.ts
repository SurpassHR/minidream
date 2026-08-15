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
});
