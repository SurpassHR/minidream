import { afterEach, describe, expect, it, vi } from 'vitest';
import { client } from './client';

afterEach(() => { vi.unstubAllGlobals(); });

// 回归防护：req 封装此前对无 body 的 DELETE 也强制 content-type: application/json，
// Fastify 对"JSON 类型 + 空 body"直接 500（节点删除失效的根因）
describe('client req 封装', () => {
  it('无 body 的 DELETE（deleteNode）不携带 content-type', async () => {
    let captured: RequestInit | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      captured = init;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    await client.deleteNode('n1');
    expect(captured?.method).toBe('DELETE');
    expect(captured?.headers).not.toHaveProperty('content-type');
  });

  it('有 body 的 POST 携带 content-type: application/json', async () => {
    let captured: RequestInit | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      captured = init;
      return new Response(JSON.stringify({ node: { id: 'x', version: 1 } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }));
    await client.createNode({ type: 'shot', title: 'T' });
    expect((captured?.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('非 JSON 错误响应仍抛 ApiError 而非崩溃', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status: 500 })));
    await expect(client.deleteNode('n1')).rejects.toMatchObject({ code: 'HTTP_500' });
  });

  it('listTasks、cancelTask、retryTask 使用统一任务 API', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      if (url === '/api/tasks') return new Response(JSON.stringify({ tasks: [] }), { status: 200 });
      if (url.endsWith('/cancel')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(JSON.stringify({ task: { id: 't1', kind: 'ollama-vision', label: '图像转描述', status: 'queued', progress: 0, createdAt: 1, updatedAt: 1, payload: {} } }), { status: 202 });
    }));
    expect(await client.listTasks()).toEqual([]);
    expect((await client.cancelTask('t1')).ok).toBe(true);
    expect((await client.retryTask('t1')).id).toBe('t1');
    expect(calls.map(([url]) => url)).toEqual(['/api/tasks', '/api/tasks/t1/cancel', '/api/tasks/t1/retry']);
  });

  it('storyChat 保留后端返回的具体错误消息', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ code: 'INVALID_PATCH', message: '当前模型不支持视觉输入，请配置 Ollama' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )));
    await expect(client.storyChat('参考这张图', () => {})).rejects.toThrow('当前模型不支持视觉输入，请配置 Ollama');
  });
});
