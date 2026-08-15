import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { buildApp } from '../index.js';
import { listDesigns } from '../design/store.js';
import { importAssetFile, listAssets } from '../assets/assets-store.js';

let dir: string;
let a: Awaited<ReturnType<typeof buildApp>>;
let fakeHome: string;
let realHome: string;
let wfDir: string;

beforeEach(async () => {
  realHome = homedir();
  fakeHome = mkdtempSync(join(tmpdir(), 'director-home-'));
  vi.stubEnv('HOME', fakeHome);
  // 模板目录指向临时目录：写一个测试用 t2i 模板
  wfDir = mkdtempSync(join(tmpdir(), 'director-wf-'));
  process.env.DIRECTOR_WORKFLOWS_DIR = wfDir;
  writeFileSync(join(wfDir, 'test-t2i.template.json'), JSON.stringify({
    '1': { class_type: 'KSampler', inputs: { text: '${prompt}', seed: '${seed}' } },
  }), 'utf8');
  dir = mkdtempSync(join(tmpdir(), 'director-design-api-'));
  mkdirSync(join(dir, 'mmh3'), { recursive: true });
  a = buildApp({ projectDir: dir, comfyBaseUrl: 'http://127.0.0.1:59999' });
});
afterEach(async () => {
  vi.stubEnv('HOME', realHome);
  vi.unstubAllEnvs();
  delete process.env.DIRECTOR_WORKFLOWS_DIR;
  await a.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(wfDir, { recursive: true, force: true });
});

describe('API workflows', () => {
  it('GET /api/workflows 扫描模板目录去后缀', async () => {
    const res = await a.inject({ method: 'GET', url: '/api/workflows' });
    expect(res.statusCode).toBe(200);
    expect(res.json().workflows).toContain('test-t2i');
  });
});

describe('API designs CRUD', () => {
  it('POST 新建 → GET 列表 → PUT 更新 → DELETE 删除', async () => {
    const created = await a.inject({
      method: 'POST', url: '/api/designs',
      payload: { kind: 'character', name: '精灵骑士' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().design.id;

    const list = await a.inject({ method: 'GET', url: '/api/designs' });
    expect(list.json().designs).toHaveLength(1);

    const upd = await a.inject({
      method: 'PUT', url: `/api/designs/${id}`,
      payload: { patch: { description: '银发绿眸', template: 'test-t2i' } },
    });
    expect(upd.json().design.description).toBe('银发绿眸');

    const del = await a.inject({ method: 'DELETE', url: `/api/designs/${id}?confirm=true` });
    expect(del.json().ok).toBe(true);
    expect(listDesigns(dir)).toHaveLength(0);
  });

  it('非法 kind 返回 400', async () => {
    const res = await a.inject({
      method: 'POST', url: '/api/designs',
      payload: { kind: 'weapon', name: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_PATCH');
  });

  it('DELETE 无 confirm 返回 400', async () => {
    const res = await a.inject({ method: 'DELETE', url: '/api/designs/whatever' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('CONFIRM_REQUIRED');
  });

  it('PUT 未知 id 返回 404', async () => {
    const res = await a.inject({
      method: 'PUT', url: '/api/designs/nope',
      payload: { patch: { name: 'x' } },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('API designs generate', () => {
  let mock: ReturnType<typeof Fastify>;
  let a2: Awaited<ReturnType<typeof buildApp>>;
  let dir2: string;
  let baseUrl: string;
  // mock ComfyUI history 响应体（可变：个别用例覆盖为无输出）
  let historyBody: () => Record<string, unknown>;

  beforeEach(async () => {
    // mock ComfyUI：system_stats / prompt / history / view
    mock = Fastify({ logger: false });
    mock.get('/system_stats', async () => ({}));
    mock.post('/prompt', async () => ({ prompt_id: 'pid-1' }));
    // history 响应由闭包变量决定（Fastify 不允许同路径重复注册，改由用例改写闭包）
    historyBody = () => ({
      'pid-1': {
        outputs: { '9': { images: [{ filename: 'out_1.png', subfolder: '', type: 'output' }] } },
      },
    });
    mock.get('/history/:pid', async (req: FastifyRequest, reply: FastifyReply) => {
      const { pid } = req.params as { pid: string };
      reply.header('content-type', 'application/json');
      return reply.send({ [pid]: historyBody()['pid-1'] });
    });
    mock.get('/view', async (_req: FastifyRequest, reply: FastifyReply) => {
      reply.header('content-type', 'image/png');
      return reply.send(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    });
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const addr = mock.server.address();
    baseUrl = `http://127.0.0.1:${(addr as { port: number }).port}`;

    dir2 = mkdtempSync(join(tmpdir(), 'director-design-gen-'));
    mkdirSync(join(dir2, 'mmh3'), { recursive: true });
    a2 = buildApp({ projectDir: dir2, comfyBaseUrl: baseUrl });
  });
  afterEach(async () => {
    await a2.close();
    await mock.close().catch(() => {}); // 个别用例已关闭 mock，重复 close 容忍
    rmSync(dir2, { recursive: true, force: true });
  });

  it('生成成功：状态 done + 素材入库 + assetId 写回', async () => {
    const created = await a2.inject({
      method: 'POST', url: '/api/designs',
      payload: { kind: 'character', name: '精灵骑士' },
    });
    const id = created.json().design.id;
    await a2.inject({
      method: 'PUT', url: `/api/designs/${id}`,
      payload: { patch: { style: '吉卜力风', description: '银发绿眸的精灵骑士', template: 'test-t2i' } },
    });
    const res = await a2.inject({ method: 'POST', url: `/api/designs/${id}/generate` });
    expect(res.statusCode).toBe(200);
    const design = res.json().design;
    expect(design.status).toBe('done');
    expect(design.assetId).toBeTruthy();
    // 素材已入库且为 img
    const assets = listAssets();
    const asset = assets.find((x) => x.id === design.assetId);
    expect(asset?.kind).toBe('img');
    expect(asset?.name).toMatch(/^design-.*\.png$/);
  });

  it('模板缺 ${prompt} 变量返回 400', async () => {
    // 写一个缺 prompt 的模板
    writeFileSync(join(wfDir, 'no-prompt.template.json'), JSON.stringify({
      '1': { class_type: 'KSampler', inputs: { seed: '${seed}' } },
    }), 'utf8');
    const created = await a2.inject({
      method: 'POST', url: '/api/designs',
      payload: { kind: 'scene', name: '迷雾森林' },
    });
    const id = created.json().design.id;
    await a2.inject({
      method: 'PUT', url: `/api/designs/${id}`,
      payload: { patch: { style: '写实', template: 'no-prompt' } },
    });
    const res = await a2.inject({ method: 'POST', url: `/api/designs/${id}/generate` });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('${prompt}');
  });

  it('描述与风格都为空返回 400', async () => {
    const created = await a2.inject({
      method: 'POST', url: '/api/designs',
      payload: { kind: 'prop', name: '地图' },
    });
    const id = created.json().design.id;
    const res = await a2.inject({ method: 'POST', url: `/api/designs/${id}/generate` });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('请先填写');
  });

  it('ComfyUI 未连接返回 400', async () => {
    await mock.close().catch(() => {}); // 关掉 mock → health 检查失败
    const created = await a2.inject({
      method: 'POST', url: '/api/designs',
      payload: { kind: 'character', name: '哥布林' },
    });
    const id = created.json().design.id;
    await a2.inject({
      method: 'PUT', url: `/api/designs/${id}`,
      payload: { patch: { style: '暗黑', description: '绿皮哥布林', template: 'test-t2i' } },
    });
    const res = await a2.inject({ method: 'POST', url: `/api/designs/${id}/generate` });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('ComfyUI');
    // 状态保持 draft（未进入 generating）
    const list = await a2.inject({ method: 'GET', url: '/api/designs' });
    expect(list.json().designs[0].status).toBe('draft');
  });

  it('生成失败（history 无输出）→ failed + error 写回', async () => {
    // 改写闭包：history 返回空 outputs（不能重复注册路由，Fastify 会抛错）
    historyBody = () => ({ 'pid-1': { outputs: {} } });
    const created = await a2.inject({
      method: 'POST', url: '/api/designs',
      payload: { kind: 'character', name: '精灵' },
    });
    const id = created.json().design.id;
    await a2.inject({
      method: 'PUT', url: `/api/designs/${id}`,
      payload: { patch: { style: '吉卜力风', description: '精灵', template: 'test-t2i' } },
    });
    const res = await a2.inject({ method: 'POST', url: `/api/designs/${id}/generate` });
    expect(res.statusCode).toBe(200);
    expect(res.json().design.status).toBe('failed');
    expect(res.json().design.error).toBeTruthy();
  });
});

describe('API 素材文件端点', () => {
  it('GET /api/assets/:id/file 返回图片字节流', async () => {
    // 先入库一张图（HOME 已隔离到 fakeHome）
    const src = join(fakeHome, 'src.png');
    writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'utf8');
    const rec = importAssetFile(src);
    const res = await a.inject({ method: 'GET', url: `/api/assets/${rec.id}/file` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.rawPayload.length).toBe(4);
  });

  it('GET /api/assets/:id/file 未知 id 返回 404', async () => {
    const res = await a.inject({ method: 'GET', url: '/api/assets/nope/file' });
    expect(res.statusCode).toBe(404);
  });
});
