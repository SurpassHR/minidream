import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../index.js';
import { listDesigns } from '../design/store.js';

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
