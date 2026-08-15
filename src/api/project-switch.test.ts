
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../index.js';
import { loadGraph } from '../graph/graph-store.js';

describe('API 项目发现与热切换', () => {
  let root: string;
  let projA: string;
  let projB: string;
  let b: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'director-projects-'));
    projA = join(root, 'proj-a');
    projB = join(root, 'proj-b');
    mkdirSync(join(projA, 'mmh3_prompts', 'scene_a'), { recursive: true });
    mkdirSync(join(projB, 'mmh3_prompts', 'scene_b'), { recursive: true });
    writeFileSync(
      join(projB, 'mmh3_prompts', 'scene_b', 'shot_01.md'),
      '# SHOT 01\n- 时长：3.75s（90 帧 @24fps）\n',
      'utf8',
    );
    b = buildApp({ projectDir: projA, comfyBaseUrl: 'http://127.0.0.1:59999' });
  });

  afterEach(async () => {
    await b.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('GET /api/projects 返回当前项目与同根项目（无图数据时从 shot_*.md 统计）', async () => {
    const res = await b.inject({ method: 'GET', url: '/api/projects' });
    expect(res.statusCode).toBe(200);
    const projects = res.json().projects as Array<{
      name: string; current: boolean; shots: number; duration: number;
    }>;
    expect(projects.some((p) => p.current && p.name === 'proj-a')).toBe(true);
    const pb = projects.find((p) => p.name === 'proj-b');
    expect(pb).toBeTruthy();
    expect(pb?.shots).toBe(1);
    expect(pb?.duration).toBeCloseTo(3.75);
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
