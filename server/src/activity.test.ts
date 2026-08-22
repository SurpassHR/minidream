import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActivityRegistry } from './activity.js';
import { TaskQueue } from './tasks/queue.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'director-activity-'));
  file = join(dir, 'tasks.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ActivityRegistry', () => {
  it('登记活动会话并关联未完成任务', () => {
    const queue = new TaskQueue({ dataFile: file, autoStart: false });
    const registry = new ActivityRegistry(queue);
    const controller = new AbortController();
    registry.startSession('session-1', '生成赛博朋克雨夜', controller);
    const task = queue.submit({ workflowId: 'image_krea2_turbo_t2i', prompt: 'neon rain', sessionId: 'session-1' });
    registry.attachTask('session-1', task.id);

    const snapshot = registry.snapshot();
    expect(snapshot.sessions[0]).toMatchObject({
      sessionId: 'session-1',
      message: '生成赛博朋克雨夜',
      status: 'running',
      taskIds: [task.id],
    });
    expect(snapshot.tasks.map(t => t.id)).toContain(task.id);
  });

  it('终止会话时 abort Agent 并取消关联任务', () => {
    const queue = new TaskQueue({ dataFile: file, autoStart: false });
    const registry = new ActivityRegistry(queue);
    const controller = new AbortController();
    registry.startSession('session-1', '停止这次生成', controller);
    const task = queue.submit({ workflowId: 'image_krea2_turbo_t2i', prompt: 'cancel', sessionId: 'session-1' });

    const canceled = registry.cancelSession('session-1');

    expect(controller.signal.aborted).toBe(true);
    expect(canceled.map(t => t.id)).toContain(task.id);
    expect(queue.get(task.id)?.status).toBe('canceled');
    expect(registry.snapshot().sessions[0]?.status).toBe('canceled');
  });

  it('活动快照保留终态任务并限制为最近 50 条', () => {
    const queue = new TaskQueue({ dataFile: file, autoStart: false });
    const registry = new ActivityRegistry(queue);
    const taskIds: string[] = [];
    for (let i = 0; i < 51; i++) {
      const task = queue.submit({ workflowId: 'image_krea2_turbo_t2i', prompt: `history-${i}` });
      taskIds.push(task.id);
      queue.cancel(task.id);
    }

    const snapshot = registry.snapshot();
    expect(snapshot.tasks).toHaveLength(50);
    expect(snapshot.tasks.every(task => task.status === 'canceled')).toBe(true);
    expect(snapshot.tasks.some(task => task.id === taskIds[0])).toBe(false);
    expect(snapshot.tasks.some(task => task.id === taskIds[50])).toBe(true);
  });

  it('广播会话和任务活动变化', () => {
    const queue = new TaskQueue({ dataFile: file, autoStart: false });
    const registry = new ActivityRegistry(queue);
    const events: string[] = [];
    const unsubscribe = registry.subscribe(event => events.push(event.type));
    const controller = new AbortController();
    registry.startSession('session-1', '测试广播', controller);
    const task = queue.submit({ workflowId: 'image_krea2_turbo_t2i', prompt: 'event', sessionId: 'session-1' });
    registry.attachTask('session-1', task.id);
    registry.cancelSession('session-1');
    unsubscribe();

    expect(events).toContain('session:started');
    expect(events).toContain('task:updated');
    expect(events).toContain('session:canceled');
  });
});
