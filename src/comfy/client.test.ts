import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComfyUIClient } from './client.js';

let mock: ReturnType<typeof Fastify>;
let baseUrl: string;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'director-comfy-'));
  // mock ComfyUI 服务器
  mock = Fastify({ logger: false });
  mock.get('/system_stats', async () => ({ system: { comfyui_version: '0.3.0' } }));
  mock.post('/prompt', async (req: FastifyRequest, _reply: FastifyReply) => {
    const body = req.body as { prompt: unknown; client_id: string };
    expect(body.prompt).toBeTruthy();
    return { prompt_id: 'pid-1' };
  });
  let pollCount = 0;
  mock.get('/history/:pid', async (req: FastifyRequest) => {
    const { pid } = req.params as { pid: string };
    pollCount += 1;
    // 第 3 次轮询才返回完成；仅 'pid-1' 会完成（'never-done' 永远 pending，供超时测试）
    if (pollCount < 3 || pid !== 'pid-1') return {};
    return {
      [pid]: {
        outputs: {
          '9': { gifs: [{ filename: 'out.mp4', subfolder: 'mmh3', type: 'output' }] },
        },
      },
    };
  });
  mock.get('/view', async (req: FastifyRequest, reply: FastifyReply) => {
    const { filename } = req.query as { filename: string };
    reply.header('content-type', 'video/mp4');
    return Buffer.from(`fake-video:${filename}`);
  });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const addr = mock.server.address();
  if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`;
});
afterEach(async () => {
  await mock.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ComfyUIClient', () => {
  it('health 返回 true', async () => {
    const c = new ComfyUIClient(baseUrl);
    expect(await c.health()).toBe(true);
  });

  it('health 对不可达地址返回 false', async () => {
    const c = new ComfyUIClient('http://127.0.0.1:59999');
    expect(await c.health()).toBe(false);
  });

  it('submit 返回 prompt_id', async () => {
    const c = new ComfyUIClient(baseUrl);
    expect(await c.submit({ '1': { class_type: 'Test' } }, 'client-1')).toBe('pid-1');
  });

  it('waitForDone 轮询至完成并收集媒体', async () => {
    const c = new ComfyUIClient(baseUrl);
    const out = await c.waitForDone('pid-1', { intervalMs: 10, timeoutMs: 5000 });
    expect(out.promptId).toBe('pid-1');
    expect(out.media).toHaveLength(1);
    expect(out.media[0]?.filename).toBe('out.mp4');
  });

  it('waitForDone 超时抛错', async () => {
    const c = new ComfyUIClient(baseUrl, { timeoutMs: 80 });
    // 换个一直 pending 的 prompt id
    await expect(c.waitForDone('never-done', { intervalMs: 10, timeoutMs: 80 })).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_PATCH' }),
    );
  });

  it('download 保存文件', async () => {
    const c = new ComfyUIClient(baseUrl);
    const dest = join(dir, 'out.mp4');
    const p = await c.download({ filename: 'out.mp4', subfolder: 'mmh3', type: 'output' }, dest);
    expect(p).toBe(dest);
    expect(readFileSync(dest, 'utf8')).toBe('fake-video:out.mp4');
    expect(existsSync(dest)).toBe(true);
  });
});
