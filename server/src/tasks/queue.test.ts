import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
