import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getJob, jobSnapshot, subscribeJob, cancelJob } from './jobs.js';
import { TaskQueue } from './tasks/queue.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'director-job-compat-'));
  file = join(dir, 'tasks.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('legacy job compatibility adapter', () => {
  it('旧 job 快照直接来自 TaskQueue 任务', () => {
    const queue = new TaskQueue({ dataFile: file, autoStart: false });
    const task = queue.submit({ workflowId: 'image_krea2_turbo_t2i', prompt: 'one source of truth' });
    const job = getJob(queue, task.id);

    expect(job).toBeDefined();
    expect(jobSnapshot(job!)).toMatchObject({ id: task.id, workflowId: task.workflowId, status: 'running' });
  });

  it('旧 job 取消接口和事件订阅操作同一个 TaskQueue 任务', () => {
    const queue = new TaskQueue({ dataFile: file, autoStart: false });
    const task = queue.submit({ workflowId: 'image_krea2_turbo_t2i', prompt: 'cancel through adapter' });
    const events: string[] = [];
    const unsubscribe = subscribeJob(queue, task.id, event => events.push(event.type));

    return cancelJob(queue, task.id).then(result => {
      expect(result).toBe(true);
      return new Promise<void>(resolve => {
      const check = () => {
        if (events.includes('cancelled')) {
          unsubscribe();
          expect(queue.get(task.id)?.status).toBe('canceled');
          resolve();
        } else {
          setTimeout(check, 5);
        }
      };
        check();
      });
    });
  });
});
