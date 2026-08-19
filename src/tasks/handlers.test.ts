import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importAssetFile, listAssets } from '../assets/assets-store.js';
import { saveSettings } from '../settings/settings-store.js';
import { TaskQueue } from './queue.js';
import { registerTaskHandlers } from './handlers.js';

let home: string;
let imageId: string;
let ollama: ReturnType<typeof Fastify>;
let ollamaUrl: string;
let queue: TaskQueue;
let queueDir: string;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'director-home-task-handler-'));
  vi.stubEnv('HOME', home);
  queueDir = mkdtempSync(join(tmpdir(), 'director-task-handler-'));
  ollama = Fastify({ logger: false });
  ollama.post('/api/chat', async () => ({ message: { content: '银发精灵骑士，身着墨绿斗篷' } }));
  ollama.post('/api/embed', async (req: FastifyRequest) => {
    const input = (req.body as { input?: string[] }).input ?? [];
    return { embeddings: input.map(() => [1, 0, 0]) };
  });
  await ollama.listen({ port: 0, host: '127.0.0.1' });
  const address = ollama.server.address();
  if (address && typeof address === 'object') ollamaUrl = `http://127.0.0.1:${address.port}`;
  saveSettings({ ollamaUrl, ollamaModel: 'llava', ollamaEmbedModel: 'embed' });
  const imageDir = mkdtempSync(join(tmpdir(), 'director-task-image-'));
  const imagePath = join(imageDir, 'ref.png');
  writeFileSync(imagePath, 'fake image bytes');
  imageId = importAssetFile(imagePath).id;
  rmSync(imageDir, { recursive: true, force: true });
  queue = new TaskQueue({ filePath: join(queueDir, 'tasks.json') });
  registerTaskHandlers(queue);
});

afterEach(async () => {
  await ollama.close();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
  rmSync(queueDir, { recursive: true, force: true });
});

describe('Task handlers', () => {
  it('Ollama vision 任务返回 prompt，caption 任务写回图片 caption 和文本素材', async () => {
    const prompt = queue.submit({
      kind: 'ollama-vision', label: '图像转描述',
      payload: { operation: 'image-to-prompt', assetId: imageId },
    });
    expect((await prompt.completion).result?.prompt).toContain('银发精灵骑士');

    const caption = queue.submit({
      kind: 'ollama-vision', label: '生成 caption',
      payload: { operation: 'caption', assetId: imageId },
    });
    const done = await caption.completion;
    expect(done.result?.caption).toContain('银发精灵骑士');
    expect(listAssets().find((asset) => asset.id === imageId)?.caption).toContain('银发精灵骑士');
    expect(listAssets().some((asset) => asset.kind === 'txt' && asset.name === 'ref.txt')).toBe(true);
  });

  it('Ollama embedding 任务返回与输入数量一致的向量', async () => {
    const task = queue.submit({
      kind: 'ollama-embedding', label: '知识库检索',
      payload: { model: 'embed', texts: ['北境', '冬季'] },
    });
    const done = await task.completion;
    expect(done.status).toBe('success');
    expect(done.result?.embeddings).toEqual([[1, 0, 0], [1, 0, 0]]);
  });
});
