import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { client } from './client';

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('API client', () => {
  it('createNode 发 POST /api/nodes', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ node: { id: 'n1', version: 1 } }), { status: 201 }));
    const node = await client.createNode({ type: 'shot', title: 'SHOT 01' });
    expect(node.id).toBe('n1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/nodes');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string).type).toBe('shot');
  });

  it('deleteNode 自动带 confirm=true', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await client.deleteNode('n1');
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('/api/nodes/n1?confirm=true');
  });

  it('非 2xx 抛错并带后端错误码', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 'NODE_NOT_FOUND', message: 'x' }), { status: 404 }));
    await expect(client.getGraph()).rejects.toThrowError(
      expect.objectContaining({ code: 'NODE_NOT_FOUND' }),
    );
  });

  it('listProjects 拉取 /api/projects', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ projects: [
      { path: '/p/a', name: 'a', current: true, shots: 2, duration: 7.5, mode: 'KEYFRAME' },
    ] }), { status: 200 }));
    const projects = await client.listProjects();
    expect(projects[0]?.name).toBe('a');
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('/api/projects');
  });

  it('switchProject 发 POST /api/project/switch 并返回新图', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      graph: { projectName: 'b', nodes: [], edges: [] },
      projects: [],
    }), { status: 200 }));
    const r = await client.switchProject('/p/b');
    expect(r.graph.projectName).toBe('b');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/project/switch');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string).path).toBe('/p/b');
  });
});