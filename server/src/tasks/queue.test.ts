import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DraftStore } from '../drafts.js';
import { TaskQueue } from './queue.js';
import type { TaskItem } from './types.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'director-tasks-'));
  file = join(dir, 'tasks.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('TaskQueue 基础功能与单测', () => {
  it('初始化时空文件返回空列表', () => {
    const queue = new TaskQueue({ dataFile: file, autoStart: false });
    expect(queue.list()).toEqual([]);
  });

  it('提交任务并落盘持久化', () => {
    const queue = new TaskQueue({ dataFile: file, autoStart: false });
    const task = queue.submit({
      workflowId: 'image_krea2_turbo_t2i',
      prompt: 'a cinematic portrait of a cybernetic deer in neon forest',
    });

    expect(task.id).toBeTruthy();
    expect(task.status).toBe('queued');
    expect(task.type).toBe('image_generation');
    expect(task.stages.length).toBeGreaterThan(0);
    expect(queue.get(task.id)).toEqual(task);

    // 验证持久化重新加载
    const queue2 = new TaskQueue({ dataFile: file, autoStart: false });
    expect(queue2.get(task.id)).toEqual(task);
  });

  it('服务重启时将 running 状态任务恢复为 interrupted', () => {
    const initialData: TaskItem[] = [
      {
        id: 'task-running-1',
        type: 'image_generation',
        status: 'running',
        workflowId: 'image_krea2_turbo_t2i',
        prompt: 'test prompt',
        stages: [{ id: 'stage-1', name: 'Sampling', status: 'active', logs: [] }],
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 500,
      },
      {
        id: 'task-queued-1',
        type: 'video_generation',
        status: 'queued',
        workflowId: 'video-minimax-h3-t2v',
        prompt: 'video prompt',
        stages: [{ id: 'stage-1', name: 'Pending', status: 'pending', logs: [] }],
        createdAt: Date.now() - 200,
        updatedAt: Date.now() - 200,
      },
    ];
    writeFileSync(file, JSON.stringify(initialData, null, 2), 'utf8');

    const queue = new TaskQueue({ dataFile: file, autoStart: false });
    const tasks = queue.list();
    const interruptedTask = tasks.find(t => t.id === 'task-running-1');
    const queuedTask = tasks.find(t => t.id === 'task-queued-1');

    expect(interruptedTask?.status).toBe('interrupted');
    expect(queuedTask?.status).toBe('queued');
  });

  it('任务取消：排队中任务可直接取消', () => {
    const queue = new TaskQueue({ dataFile: file, autoStart: false });
    const task = queue.submit({
      workflowId: 'image_krea2_turbo_t2i',
      prompt: 'to be cancelled',
    });

    const cancelled = queue.cancel(task.id);
    expect(cancelled).toBe(true);
    expect(queue.get(task.id)?.status).toBe('canceled');
  });

  it('运行中任务取消后 executor 返回也不会恢复为 completed', async () => {
    let started!: () => void;
    let release!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    const releasePromise = new Promise<void>(resolve => { release = resolve; });
    const queue = new TaskQueue({
      dataFile: file,
      autoStart: true,
      executor: async (_task, _onProgress, signal) => {
        started();
        await releasePromise;
        expect(signal?.aborted).toBe(true);
        return { outputs: [] };
      },
    });
    const task = queue.submit({ workflowId: 'image_krea2_turbo_t2i', prompt: 'cancel me', sessionId: 'session-1' });
    await startedPromise;
    expect(queue.cancel(task.id)).toBe(true);
    release();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(queue.get(task.id)?.status).toBe('canceled');
  });

  it('可以在提交后绑定会话归属', () => {
    const queue = new TaskQueue({ dataFile: file, autoStart: false });
    const task = queue.submit({ workflowId: 'image_krea2_turbo_t2i', prompt: 'bind later' });

    expect(queue.bindSession(task.id, 'session-1')).toBe(true);
    expect(queue.get(task.id)?.sessionId).toBe('session-1');
  });

  it('按 sessionId 批量取消未完成任务', () => {
    const queue = new TaskQueue({ dataFile: file, autoStart: false });
    const task1 = queue.submit({ workflowId: 'image_krea2_turbo_t2i', prompt: 'one', sessionId: 'session-1' });
    const task2 = queue.submit({ workflowId: 'image_krea2_turbo_t2i', prompt: 'two', sessionId: 'session-1' });
    const task3 = queue.submit({ workflowId: 'image_krea2_turbo_t2i', prompt: 'three', sessionId: 'session-2' });

    const canceled = queue.cancelBySession('session-1');
    expect(canceled.map(t => t.id)).toEqual(expect.arrayContaining([task1.id, task2.id]));
    expect(queue.get(task1.id)?.status).toBe('canceled');
    expect(queue.get(task2.id)?.status).toBe('canceled');
    expect(queue.get(task3.id)?.status).toBe('queued');
  });

  it('订阅任务时能收到进度更新', async () => {
    const queue = new TaskQueue({ dataFile: file, autoStart: true, executor: async (_task, onProgress) => {
      onProgress({ stage: 'Sampling', step: 2, totalSteps: 4, progress: 50 });
      return { outputs: [] };
    }});
    const events: string[] = [];
    const task = queue.submit({ workflowId: 'image_krea2_turbo_t2i', prompt: 'progress' });
    const unsubscribe = queue.subscribeTask(task.id, event => events.push(event));
    await new Promise(resolve => setTimeout(resolve, 30));
    unsubscribe();
    expect(events).toContain('updated');
  });

  it('任务完成前将输出转存为本地草稿 URL', async () => {
    const draftStore = new DraftStore({ indexFile: join(dir, 'drafts.json'), outputDir: join(dir, 'drafts') });
    const queue = new TaskQueue({
      dataFile: file,
      autoStart: true,
      drafts: draftStore,
      executor: async () => ({
        outputs: [{
          kind: 'image',
          url: '/comfyui/view?filename=result.png',
          filename: 'result.png',
          data: Buffer.from('local-image'),
          mime: 'image/png',
        }],
      }),
    });
    const task = queue.submit({ workflowId: 'image_krea2_turbo_t2i', prompt: 'save locally' });

    await new Promise<void>(resolve => {
      const check = () => queue.get(task.id)?.status === 'completed' ? resolve() : setTimeout(check, 10);
      check();
    });

    const result = queue.get(task.id);
    expect(result?.outputs?.[0]?.url).toMatch(/^\/api\/drafts\/draft-/);
    expect(draftStore.list()).toHaveLength(1);
    expect(result?.status).toBe('completed');
  });

  it('本地草稿保存失败时任务不能标记为完成', async () => {
    const draftStore = new DraftStore({ indexFile: join(dir, 'drafts.json'), outputDir: join(dir, 'drafts') });
    const originalSave = draftStore.saveFromBuffer.bind(draftStore);
    draftStore.saveFromBuffer = async () => { throw new Error('disk full'); };
    const queue = new TaskQueue({
      dataFile: file,
      autoStart: true,
      drafts: draftStore,
      executor: async () => ({ outputs: [{ kind: 'image', url: '/comfyui/view?filename=result.png', filename: 'result.png', data: Buffer.from('x') }] }),
    });
    const task = queue.submit({ workflowId: 'image_krea2_turbo_t2i', prompt: 'fail save' });

    await new Promise<void>(resolve => {
      const check = () => queue.get(task.id)?.status === 'failed' ? resolve() : setTimeout(check, 10);
      check();
    });

    expect(queue.get(task.id)?.error).toContain('disk full');
    draftStore.saveFromBuffer = originalSave;
  });

  it('串行排队执行与事件触发', async () => {
    const queue = new TaskQueue({
      dataFile: file,
      autoStart: true,
      executor: async (task, onProgress) => {
        onProgress({ stage: 'Sampling', step: 10, totalSteps: 20, progress: 50 });
        await new Promise(r => setTimeout(r, 50));
        return {
          outputs: [
            {
              kind: 'image',
              url: '/comfyui/view?filename=test.png',
              filename: 'test.png',
            },
          ],
        };
      },
    });

    const events: string[] = [];
    queue.on('task:change', t => {
      events.push(`${t.id}:${t.status}`);
    });

    const task1 = queue.submit({ workflowId: 'image_krea2_turbo_t2i', prompt: 'task 1' });
    const task2 = queue.submit({ workflowId: 'image_krea2_turbo_t2i', prompt: 'task 2' });

    // 等待两个任务全部完成
    await new Promise<void>(resolve => {
      const check = () => {
        const t1 = queue.get(task1.id);
        const t2 = queue.get(task2.id);
        if (t1?.status === 'completed' && t2?.status === 'completed') {
          resolve();
        } else {
          setTimeout(check, 20);
        }
      };
      check();
    });

    const finalT1 = queue.get(task1.id);
    const finalT2 = queue.get(task2.id);
    expect(finalT1?.status).toBe('completed');
    expect(finalT1?.outputs?.[0]?.filename).toBe('test.png');
    expect(finalT2?.status).toBe('completed');
  });
});
