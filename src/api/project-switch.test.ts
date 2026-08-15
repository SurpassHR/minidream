import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../index.js';
import { loadGraph } from '../graph/graph-store.js';

// 项目注册表（~/.director/projects.json）与素材库一样用函数式求值读取 HOME，
// stub HOME 保证测试隔离，不污染真实 ~/.director
describe('API 项目注册表与热切换', () => {
  let home: string;
  let root: string;
  let projA: string;
  let projB: string;
  let emptyDir: string;
  let b: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'director-home-'));
    vi.stubEnv('HOME', home);
    expect(homedir()).toBe(home); // 确认 stub 生效（避免误写真实注册表）
    root = mkdtempSync(join(tmpdir(), 'director-projects-'));
    projA = join(root, 'proj-a');
    projB = join(root, 'proj-b');
    emptyDir = join(root, 'empty-new');
    // 剧本项目标记：mmh3_prompts / prompts
    mkdirSync(join(projA, 'mmh3_prompts', 'scene_a'), { recursive: true });
    mkdirSync(join(projB, 'mmh3_prompts', 'scene_b'), { recursive: true });
    writeFileSync(
      join(projB, 'mmh3_prompts', 'scene_b', 'shot_01.md'),
      '# SHOT 01\n- 时长：3.75s（90 帧 @24fps）\n',
      'utf8',
    );
    mkdirSync(emptyDir);
    b = buildApp({ projectDir: projA, comfyBaseUrl: 'http://127.0.0.1:59999' });
  });

  afterEach(async () => {
    await b.close();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('空注册表时项目列表为空：当前目录不自动显示（不再误判工作台自身）', async () => {
    const res = await b.inject({ method: 'GET', url: '/api/projects' });
    expect(res.statusCode).toBe(200);
    expect(res.json().projects).toEqual([]);
  });

  it('POST /api/projects/add 添加剧本项目（mmh3_prompts）→ 显示在列表并持久化', async () => {
    const add = await b.inject({ method: 'POST', url: '/api/projects/add', payload: { path: projA } });
    expect(add.statusCode).toBe(200);
    const list = add.json().projects as Array<{ name: string; current: boolean; shots: number }>;
    expect(list.some((p) => p.name === 'proj-a' && p.current)).toBe(true);
    // 持久化：再次 GET 仍在（目录无图数据且无 shot_*.md → shots=-1）
    const res = await b.inject({ method: 'GET', url: '/api/projects' });
    const again = res.json().projects as Array<{ name: string; shots: number }>;
    expect(again.find((p) => p.name === 'proj-a')?.shots).toBe(-1);
    // 无图数据项目从 shot_*.md 统计
    await b.inject({ method: 'POST', url: '/api/projects/add', payload: { path: projB } });
    const res2 = await b.inject({ method: 'GET', url: '/api/projects' });
    const pb = (res2.json().projects as Array<{ name: string; shots: number; duration: number }>)
      .find((p) => p.name === 'proj-b');
    expect(pb?.shots).toBe(1);
    expect(pb?.duration).toBeCloseTo(3.75);
  });

  it('POST /api/projects/add 添加空目录 → 成功（预留创作起点）', async () => {
    const add = await b.inject({ method: 'POST', url: '/api/projects/add', payload: { path: emptyDir } });
    expect(add.statusCode).toBe(200);
    const names = (add.json().projects as Array<{ name: string }>).map((p) => p.name);
    expect(names).toContain('empty-new');
  });

  it('POST /api/projects/add 仅含 .director 的非空目录 → 拒绝（运行时数据不是项目标记）', async () => {
    const fake = join(root, 'fake-project');
    mkdirSync(join(fake, '.director'), { recursive: true });
    writeFileSync(join(fake, '.director', 'project.json'), JSON.stringify({ projectName: 'fake' }), 'utf8');
    const res = await b.inject({ method: 'POST', url: '/api/projects/add', payload: { path: fake } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('PROJECT_NOT_ADDABLE');
  });

  it('POST /api/projects/add 不存在的路径 → 400', async () => {
    const res = await b.inject({ method: 'POST', url: '/api/projects/add', payload: { path: '/nonexistent-xyz' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('PROJECT_NOT_FOUND');
  });

  it('重复添加同一项目幂等（不重复写入注册表）', async () => {
    await b.inject({ method: 'POST', url: '/api/projects/add', payload: { path: projA } });
    const again = await b.inject({ method: 'POST', url: '/api/projects/add', payload: { path: projA } });
    expect(again.statusCode).toBe(200);
    expect(again.json().projects).toHaveLength(1);
  });

  it('POST /api/projects/remove 移除后不再显示；不存在路径幂等', async () => {
    await b.inject({ method: 'POST', url: '/api/projects/add', payload: { path: projA } });
    await b.inject({ method: 'POST', url: '/api/projects/add', payload: { path: projB } });
    const res = await b.inject({ method: 'POST', url: '/api/projects/remove', payload: { path: projA } });
    const names = (res.json().projects as Array<{ name: string }>).map((p) => p.name);
    expect(names).toEqual(['proj-b']);
    const idem = await b.inject({ method: 'POST', url: '/api/projects/remove', payload: { path: projA } });
    expect((idem.json().projects as Array<{ name: string }>).map((p) => p.name)).toEqual(['proj-b']);
  });

  it('POST /api/project/switch 热切换项目并切换读写数据源', async () => {
    await b.inject({ method: 'POST', url: '/api/nodes', payload: { type: 'shot', title: 'A-1' } });
    const res = await b.inject({
      method: 'POST', url: '/api/project/switch',
      payload: { path: projB },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().graph.projectName).toBe('proj-b');
    // 切换后读写都指向新项目；旧项目图不受影响
    const g = await b.inject({ method: 'GET', url: '/api/graph' });
    expect(g.json().graph.nodes).toHaveLength(0);
    await b.inject({ method: 'POST', url: '/api/nodes', payload: { type: 'shot', title: 'B-1' } });
    expect(loadGraph(projB).nodes).toHaveLength(1);
    expect(loadGraph(projA).nodes).toHaveLength(1);
  });

  it('POST /api/project/switch 无效目录返回 400', async () => {
    const res = await b.inject({ method: 'POST', url: '/api/project/switch', payload: { path: '/nonexistent-xyz' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('PROJECT_NOT_FOUND');
  });

  it('项目列表保持固定顺序：切换只更新 current 高亮，不把当前项目挪到最上方', async () => {
    await b.inject({ method: 'POST', url: '/api/projects/add', payload: { path: projA } });
    await b.inject({ method: 'POST', url: '/api/projects/add', payload: { path: projB } });
    const before = await b.inject({ method: 'GET', url: '/api/projects' });
    const beforeList = before.json().projects as Array<{ name: string; current: boolean }>;
    const namesBefore = beforeList.map((p) => p.name);
    const posBefore = namesBefore.indexOf('proj-b');
    expect(posBefore).toBeGreaterThan(-1);
    // 切换到 proj-b 后：列表顺序完全不变，仅 current 标记移动到 proj-b
    await b.inject({ method: 'POST', url: '/api/project/switch', payload: { path: projB } });
    const after = await b.inject({ method: 'GET', url: '/api/projects' });
    const afterList = after.json().projects as Array<{ name: string; current: boolean }>;
    expect(afterList.map((p) => p.name)).toEqual(namesBefore);
    expect(afterList.indexOf(afterList.find((p) => p.name === 'proj-b')!)).toBe(posBefore); // 位置不动
    expect(afterList.find((p) => p.name === 'proj-b')?.current).toBe(true);
    expect(afterList.find((p) => p.name === 'proj-a')?.current).toBe(false);
  });
});
