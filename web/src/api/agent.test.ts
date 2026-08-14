import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentChat } from './agent';

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

// 构造 SSE 流式 Response：parts 为 ReadableStream 的多个字节块
function sseResponse(parts: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(encoder.encode(p));
      c.close();
    },
  });
  return new Response(stream, { status });
}

describe('agentChat SSE 解析', () => {
  it('多帧流式：按顺序收到全部 chunk 并正常结束', async () => {
    fetchMock.mockResolvedValue(sseResponse([
      'data: {"chunk":"分析中"}\n\n',
      'data: {"chunk":"——结论：节奏递进"}\n\n',
      'data: [DONE]\n\n',
    ]));
    const chunks: string[] = [];
    await agentChat('分析节奏', [], (c) => chunks.push(c));
    expect(chunks).toEqual(['分析中', '——结论：节奏递进']);
    // 请求形状正确
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/agent/chat');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string).message).toBe('分析节奏');
  });

  it('跨块断帧：SSE 帧被拆成多个字节块时缓冲拼接完整', async () => {
    // 一帧的字节被拆成两半 enqueue，中间还夹一个独立帧
    fetchMock.mockResolvedValue(sseResponse([
      'data: {"chu',
      'nk":"hello"}\n\n',
      'data: {"chunk":"world"}\n\n',
      'data: [DONE]\n\n',
    ]));
    const chunks: string[] = [];
    await agentChat('x', [], (c) => chunks.push(c));
    expect(chunks).toEqual(['hello', 'world']);
  });

  it('坏帧忽略：注释帧与坏 JSON 帧不影响后续正常帧', async () => {
    fetchMock.mockResolvedValue(sseResponse([
      ': keep-alive comment\n\n',
      'data: not-json\n\n',
      'data: {"chunk":"ok"}\n\n',
      'data: [DONE]\n\n',
    ]));
    const chunks: string[] = [];
    await expect(agentChat('x', [], (c) => chunks.push(c))).resolves.toBeUndefined();
    expect(chunks).toEqual(['ok']);
  });

  it('HTTP 非 2xx 抛错', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
    await expect(agentChat('x', [], () => {})).rejects.toThrowError(/500/);
  });

  it('chips 随请求体传递', async () => {
    fetchMock.mockResolvedValue(sseResponse(['data: [DONE]\n\n']));
    const chips = [{ name: '@shot_02', content: '动作：拽绳转身' }];
    await agentChat('分析', chips, () => {});
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.chips).toEqual(chips);
  });
});

describe('agentChat 模型透传', () => {
  it('携带 model 时 body 包含 model 字段', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => {
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        start(c) { c.enqueue(enc.encode('data: [DONE]\n\n')); c.close(); },
      });
      return new Response(stream, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await agentChat('hi', [], () => {}, 'mustore/grok-4.5');
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.model).toBe('mustore/grok-4.5');
    vi.unstubAllGlobals();
  });
});
