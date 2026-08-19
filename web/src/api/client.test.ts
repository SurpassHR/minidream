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

  it('storyChat 保留后端返回的具体错误消息', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ code: 'INVALID_PATCH', message: '当前模型不支持视觉输入，请配置 Ollama' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )));
    await expect(client.storyChat('参考这张图', () => {})).rejects.toThrow('当前模型不支持视觉输入，请配置 Ollama');
  });
});
