import EventEmitter from 'node:events';
import type { TaskQueue } from './tasks/queue.js';
import type { TaskItem } from './tasks/types.js';

export type ActiveSessionStatus = 'running' | 'canceled' | 'completed' | 'failed';

export interface ActiveSession {
  sessionId: string;
  message: string;
  startedAt: number;
  taskIds: string[];
  status: ActiveSessionStatus;
}

export type ActivityEvent =
  | { type: 'session:started'; session: ActiveSession }
  | { type: 'session:updated'; session: ActiveSession }
  | { type: 'session:canceled'; session: ActiveSession }
  | { type: 'session:finished'; session: ActiveSession }
  | { type: 'task:updated'; task: TaskItem };

export interface ActivitySnapshot {
  sessions: ActiveSession[];
  tasks: TaskItem[];
}

export class ActivityRegistry {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly emitter = new EventEmitter();
  private readonly onTaskChange: (task: TaskItem) => void;
  private readonly onTaskProgress: (task: TaskItem) => void;

  constructor(private readonly taskQueue: TaskQueue) {
    this.onTaskChange = (task) => {
      this.emit({ type: 'task:updated', task });
    };
    this.onTaskProgress = (task) => {
      this.emit({ type: 'task:updated', task });
    };
    this.taskQueue.on('task:change', this.onTaskChange);
    this.taskQueue.on('task:progress', this.onTaskProgress);
  }

  public startSession(sessionId: string, message: string, controller: AbortController): ActiveSession {
    const session: ActiveSession = {
      sessionId,
      message,
      startedAt: Date.now(),
      taskIds: [],
      status: 'running',
    };
    this.sessions.set(sessionId, session);
    this.controllers.set(sessionId, controller);
    this.emit({ type: 'session:started', session: this.cloneSession(session) });
    return session;
  }

  public attachTask(sessionId: string, taskId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.taskIds.includes(taskId)) return;
    session.taskIds.push(taskId);
    this.emit({ type: 'session:updated', session: this.cloneSession(session) });
    const task = this.taskQueue.get(taskId);
    if (task) this.emit({ type: 'task:updated', task });
  }

  public finishSession(sessionId: string, status: Exclude<ActiveSessionStatus, 'running'>): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.status = status;
    this.controllers.delete(sessionId);
    this.emit({ type: 'session:finished', session: this.cloneSession(session) });
    setTimeout(() => {
      const current = this.sessions.get(sessionId);
      if (current && current.status === status) this.sessions.delete(sessionId);
    }, 60_000).unref();
  }

  public cancelSession(sessionId: string): TaskItem[] {
    const session = this.sessions.get(sessionId);
    const controller = this.controllers.get(sessionId);
    controller?.abort();
    const canceled = this.taskQueue.cancelBySession(sessionId);
    if (session) {
      session.status = 'canceled';
      this.controllers.delete(sessionId);
      this.emit({ type: 'session:canceled', session: this.cloneSession(session) });
    }
    return canceled;
  }

  public getSession(sessionId: string): ActiveSession | undefined {
    const session = this.sessions.get(sessionId);
    return session ? this.cloneSession(session) : undefined;
  }

  public snapshot(): ActivitySnapshot {
    const tasks = this.taskQueue
      .list()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 50);
    return {
      sessions: Array.from(this.sessions.values()).map(session => this.cloneSession(session)),
      tasks,
    };
  }

  public subscribe(listener: (event: ActivityEvent) => void): () => void {
    this.emitter.on('activity', listener);
    return () => this.emitter.off('activity', listener);
  }

  private emit(event: ActivityEvent): void {
    this.emitter.emit('activity', event);
  }

  private cloneSession(session: ActiveSession): ActiveSession {
    return { ...session, taskIds: [...session.taskIds] };
  }
}
