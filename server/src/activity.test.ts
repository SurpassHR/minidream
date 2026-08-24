import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActivityRegistry } from './activity.js';
import { TaskQueue } from './tasks/queue.js';
import type { TaskItem } from './tasks/types.js';
import { DEFAULT_PLUGIN_RESPONSE_POLICY } from './workflow-skill.js';

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

  it('prompt 隐藏策略会在全局活动快照和事件中隐藏任务提示词', () => {
    const queue = new TaskQueue({ dataFile: file, autoStart: false });
    const registry = new ActivityRegistry(queue);
    const controller = new AbortController();
    registry.startSession('session-1', '隐藏 prompt', controller);
    registry.setSessionResponsePolicy('session-1', { ...DEFAULT_PLUGIN_RESPONSE_POLICY, prompt: 'hidden' });
    const received: TaskItem[] = [];
    registry.subscribe(event => {
      if (event.type === 'task:updated') received.push(event.task);
    });
    const task = queue.submit({ workflowId: 'image_krea2_turbo_t2i', prompt: 'secret prompt', sessionId: 'session-1' });
    expect(registry.snapshot().tasks.find(item => item.id === task.id)?.prompt).toBe('');
    expect(received.at(-1)?.prompt).toBe('');
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

  it('断开会话事件订阅不会取消 Agent 或任务，并可回放已错过的事件', () => {
    const queue = new TaskQueue({ dataFile: file, autoStart: false });
    const registry = new ActivityRegistry(queue);
    const controller = new AbortController();
    registry.startSession('session-1', '刷新页面后继续', controller);
    const task = queue.submit({ workflowId: 'image_krea2_turbo_t2i', prompt: 'keep running', sessionId: 'session-1' });
    registry.attachTask('session-1', task.id);
    const firstEvent = { type: 'agent:text' as const, delta: '已经收到' };
    const secondEvent = { type: 'task:progress' as const, taskId: task.id, percent: 42 };
    registry.publishSessionEvent('session-1', firstEvent);
    const disconnected = registry.subscribeSession('session-1', () => undefined, 0);
    disconnected();
    registry.publishSessionEvent('session-1', secondEvent);
    const received: Array<{ sequence: number; event: typeof secondEvent }> = [];
    registry.subscribeSession('session-1', envelope => {
      received.push(envelope as { sequence: number; event: typeof secondEvent });
    }, 1);

    expect(controller.signal.aborted).toBe(false);
    expect(queue.get(task.id)?.status).toBe('queued');
    expect(received).toEqual([{ sequence: 2, event: secondEvent }]);
    expect(registry.getSessionEvents('session-1', 0)).toEqual([
      { sequence: 1, event: firstEvent },
      { sequence: 2, event: secondEvent },
    ]);
  });

  it('notifySessionRenamed 通过全局活动流广播新标题', () => {
    const queue = new TaskQueue({ dataFile: file, autoStart: false });
    const registry = new ActivityRegistry(queue);
    const received: Array<{ type: string; sessionId?: string; title?: string }> = [];
    const unsubscribe = registry.subscribe(event => {
      received.push(event);
    });

    registry.notifySessionRenamed('session-1', '秋夜诗篇');
    unsubscribe();
    registry.notifySessionRenamed('session-2', '忽略我');

    expect(received).toEqual([{ type: 'session:renamed', sessionId: 'session-1', title: '秋夜诗篇' }]);
  });
});
