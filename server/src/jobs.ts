/**
 * 旧生成接口兼容适配器。
 *
 * 业务任务唯一由 TaskQueue 管理；本模块只把 TaskItem 转换为旧 job API
 * 需要的快照和事件格式，不创建第二个执行器或状态 Map。
 */
import type { TaskQueue } from './tasks/queue.js';
import type { TaskItem } from './tasks/types.js';

export type JobEvent =
  | { type: 'log'; text: string }
  | { type: 'submitted'; promptId: string }
  | { type: 'executing'; nodeId: string; label: string }
  | { type: 'progress'; completed: number; total: number; percent: number }
  | { type: 'queue'; running: number; pending: number }
  | { type: 'done'; outputs: TaskItem['outputs'] }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };

export interface LegacyJob {
  id: string;
  task: TaskItem;
}

export function getJob(taskQueue: TaskQueue, id: string): LegacyJob | undefined {
  const task = taskQueue.get(id);
  return task ? { id: task.id, task } : undefined;
}

export function jobSnapshot(job: LegacyJob) {
  const task = job.task;
  return {
    id: job.id,
    workflowId: task.workflowId,
    promptId: task.id,
    status: task.status === 'queued' || task.status === 'running' ? 'running' :
      task.status === 'completed' ? 'done' :
        task.status === 'canceled' ? 'cancelled' : task.status === 'interrupted' ? 'error' : 'error',
    outputs: task.outputs ?? [],
    error: task.error,
  };
}

function toJobEvent(task: TaskItem, event: 'updated' | 'completed' | 'failed' | 'canceled'): JobEvent {
  if (event === 'completed') return { type: 'done', outputs: task.outputs ?? [] };
  if (event === 'failed') return { type: 'error', message: task.error ?? '任务执行失败' };
  if (event === 'canceled') return { type: 'cancelled' };

  const activeStage = task.stages.find(stage => stage.status === 'active') ?? task.stages[task.stages.length - 1];
  const step = activeStage?.step ?? 0;
  const total = activeStage?.totalSteps ?? 0;
  return {
    type: 'progress',
    completed: step,
    total,
    percent: activeStage?.progress ?? 0,
  };
}

export function subscribeJob(
  taskQueue: TaskQueue,
  id: string,
  send: (event: JobEvent) => void,
): () => void {
  const task = taskQueue.get(id);
  if (!task) return () => undefined;
  const unsubscribe = taskQueue.subscribeTask(id, (event, updatedTask) => {
    send(toJobEvent(updatedTask, event));
  });
  return unsubscribe;
}

export async function cancelJob(taskQueue: TaskQueue, id: string): Promise<boolean> {
  return taskQueue.cancel(id);
}
