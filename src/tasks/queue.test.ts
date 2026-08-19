import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskQueue } from './queue.js';

const dirs: string[] = [];
function queueFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'director-task-queue-'));
  dirs.push(dir);
  return join(dir, 'tasks.json');
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('TaskQueue', () => {
  it('submit 先持久化 queued，且同 dedupeKey 不重复创建任务', () => {
    const filePath = queueFile();
    const q = new TaskQueue({ filePath });
    q.register('ollama-vision', async () => ({ prompt: 'ok' }));

    const first = q.submit({
      kind: 'ollama-vision', label: '图像转描述', payload: { assetId: 'a1' }, dedupeKey: 'vision:a1',
    });
    const stored = JSON.parse(readFileSync(filePath, 'utf8')) as { tasks: Array<{ status: string }> };
    expect(stored.tasks[0]?.status).toBe('queued');

    const second = q.submit({
      kind: 'ollama-vision', label: '图像转描述', payload: { assetId: 'a1' }, dedupeKey: 'vision:a1',
    });
    expect(second.task.id).toBe(first.task.id);
  });

  it('全局只运行一个 handler，前一个结束后才运行下一个', async () => {
    const filePath = queueFile();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const q = new TaskQueue({ filePath });
    q.register('ollama-vision', async (task) => {
      order.push(String(task.payload.name));
      if (task.payload.name === 'one') await gate;
      return {};
    });

    const one = q.submit({ kind: 'ollama-vision', label: 'one', payload: { name: 'one' } });
    const two = q.submit({ kind: 'ollama-vision', label: 'two', payload: { name: 'two' } });
    await Promise.resolve();
    expect(order).toEqual(['one']);

    release();
    await Promise.all([one.completion, two.completion]);
    expect(order).toEqual(['one', 'two']);
  });

  it('启动时 running 变 interrupted，queued 自动保留', () => {
    const filePath = queueFile();
    writeFileSync(filePath, JSON.stringify({ version: 1, tasks: [
      { id: 'r', kind: 'ollama-vision', label: '运行中', status: 'running', progress: 20, createdAt: 1, startedAt: 2, updatedAt: 2, payload: {} },
      { id: 'q', kind: 'ollama-vision', label: '排队中', status: 'queued', progress: 0, createdAt: 3, updatedAt: 3, payload: {} },
    ] }));

    const q = new TaskQueue({ filePath });
    expect(q.get('r')?.status).toBe('interrupted');
    expect(q.get('q')?.status).toBe('queued');
    const stored = JSON.parse(readFileSync(filePath, 'utf8')) as { tasks: Array<{ id: string; status: string }> };
    expect(stored.tasks.find((task) => task.id === 'r')?.status).toBe('interrupted');
  });

  it('失败任务不阻塞后续任务，重试会清除旧错误', async () => {
    const filePath = queueFile();
    const q = new TaskQueue({ filePath });
    let calls = 0;
    q.register('ollama-vision', async (task) => {
      if (task.payload.fail && calls++ === 0) throw new Error('一次失败');
      return {};
    });

    const failed = q.submit({ kind: 'ollama-vision', label: '失败', payload: { fail: true } });
    const next = q.submit({ kind: 'ollama-vision', label: '后续', payload: {} });
    expect((await failed.completion).status).toBe('failed');
    expect((await next.completion).status).toBe('success');

    const retried = q.retry(failed.task.id);
    expect(retried).toBeTruthy();
    expect((await retried!.completion).status).toBe('success');
    expect(q.get(failed.task.id)?.error).toBeUndefined();
  });

  it('queued 任务可取消，取消后不执行 handler', async () => {
    const filePath = queueFile();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const q = new TaskQueue({ filePath });
    q.register('ollama-vision', async () => { calls += 1; await gate; return {}; });
    const first = q.submit({ kind: 'ollama-vision', label: '运行中', payload: {} });
    const second = q.submit({ kind: 'ollama-vision', label: '待取消', payload: {} });
    expect(q.cancel(second.task.id)).toBe(true);
    release();
    await first.completion;
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toBe(1);
    expect(q.get(second.task.id)?.status).toBe('cancelled');
  });

  it('损坏的任务文件回退为空队列且不覆盖原文件', () => {
    const filePath = queueFile();
    writeFileSync(filePath, '{broken');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const q = new TaskQueue({ filePath });
    expect(q.list()).toEqual([]);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf8')).toBe('{broken');
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});
