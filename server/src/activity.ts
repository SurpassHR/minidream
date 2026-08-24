import EventEmitter from 'node:events';
import type { TaskQueue } from './tasks/queue.js';
import type { TaskItem } from './tasks/types.js';
import type { PluginResponsePolicy } from './workflow-skill.js';

export type ActiveSessionStatus = 'running' | 'canceled' | 'completed' | 'failed';

export interface ActiveSession {
  sessionId: string;
  message: string;
  startedAt: number;
  taskIds: string[];
  status: ActiveSessionStatus;
}

/** 与聊天 SSE 共用的、可在连接断开后回放的会话事件。 */
export interface SessionStreamEvent {
  type: string;
  [key: string]: unknown;
}

export interface SessionEventEnvelope {
  sequence: number;
  event: SessionStreamEvent;
}

export type ActivityEvent =
  | { type: 'session:started'; session: ActiveSession }
  | { type: 'session:updated'; session: ActiveSession }
  | { type: 'session:canceled'; session: ActiveSession }
  | { type: 'session:finished'; session: ActiveSession }
  | { type: 'session:renamed'; sessionId: string; title: string }
  | { type: 'task:updated'; task: TaskItem };

export interface ActivitySnapshot {
  sessions: ActiveSession[];
  tasks: TaskItem[];
}

export class ActivityRegistry {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly sessionEvents = new Map<string, SessionEventEnvelope[]>();
  private readonly sessionSubscribers = new Map<string, Set<(event: SessionEventEnvelope) => void>>();
  private readonly responsePolicies = new Map<string, PluginResponsePolicy>();
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
    this.sessionEvents.set(sessionId, []);
    this.sessionSubscribers.set(sessionId, new Set());
    this.responsePolicies.delete(sessionId);
    this.emit({ type: 'session:started', session: this.cloneSession(session) });
    return session;
  }

  public setSessionResponsePolicy(sessionId: string, policy: PluginResponsePolicy): void {
    this.responsePolicies.set(sessionId, policy);
  }

  public attachTask(sessionId: string, taskId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.taskIds.includes(taskId)) return;
    session.taskIds.push(taskId);
    this.emit({ type: 'session:updated', session: this.cloneSession(session) });
    const task = this.taskQueue.get(taskId);
    if (task) this.emit({ type: 'task:updated', task: this.taskForActivity(task) });
  }

  public finishSession(sessionId: string, status: Exclude<ActiveSessionStatus, 'running'>): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.status = status;
    this.controllers.delete(sessionId);
    this.emit({ type: 'session:finished', session: this.cloneSession(session) });
    setTimeout(() => {
      const current = this.sessions.get(sessionId);
      if (current && current.status === status) {
        this.sessions.delete(sessionId);
        this.sessionEvents.delete(sessionId);
        this.sessionSubscribers.delete(sessionId);
        this.responsePolicies.delete(sessionId);
      }
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

  /** 将 Agent/任务事件写入当前运行实例，并广播给所有连接订阅者。 */
  public publishSessionEvent(sessionId: string, event: SessionStreamEvent): number {
    if (!this.sessions.has(sessionId)) return 0;
    const events = this.sessionEvents.get(sessionId) ?? [];
    const envelope: SessionEventEnvelope = {
      sequence: (events.at(-1)?.sequence ?? 0) + 1,
      event: { ...event },
    };
    events.push(envelope);
    this.sessionEvents.set(sessionId, events);
    for (const listener of this.sessionSubscribers.get(sessionId) ?? []) {
      listener(this.cloneEnvelope(envelope));
    }
    return envelope.sequence;
  }

  public getSessionEvents(sessionId: string, afterSequence = 0): SessionEventEnvelope[] {
    return (this.sessionEvents.get(sessionId) ?? [])
      .filter(envelope => envelope.sequence > afterSequence)
      .map(envelope => this.cloneEnvelope(envelope));
  }

  /** 订阅会话事件；订阅建立时先回放指定序号之后的事件。 */
  public subscribeSession(
    sessionId: string,
    listener: (event: SessionEventEnvelope) => void,
    afterSequence = 0,
  ): () => void {
    const subscribers = this.sessionSubscribers.get(sessionId);
    if (!subscribers) return () => undefined;
    subscribers.add(listener);
    for (const event of this.getSessionEvents(sessionId, afterSequence)) {
      listener(event);
    }
    return () => subscribers.delete(listener);
  }

  public snapshot(): ActivitySnapshot {
    const tasks = this.taskQueue
      .list()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 50)
      .map(task => this.taskForActivity(task));
    return {
      sessions: Array.from(this.sessions.values()).map(session => this.cloneSession(session)),
      tasks,
    };
  }

  /** 会话被自动/手动重命名后广播到全局活动流（供侧边栏实时更新标题）。 */
  public notifySessionRenamed(sessionId: string, title: string): void {
    this.emit({ type: 'session:renamed', sessionId, title });
  }

  public subscribe(listener: (event: ActivityEvent) => void): () => void {
    this.emitter.on('activity', listener);
    return () => this.emitter.off('activity', listener);
  }

  private emit(event: ActivityEvent): void {
    if (event.type === 'task:updated') {
      this.emitter.emit('activity', { ...event, task: this.taskForActivity(event.task) });
      return;
    }
    this.emitter.emit('activity', event);
  }

  private taskForActivity(task: TaskItem): TaskItem {
    const policy = task.sessionId ? this.responsePolicies.get(task.sessionId) : undefined;
    if (!policy || policy.prompt !== 'hidden') return task;
    return {
      ...task,
      prompt: '',
      outputs: task.outputs?.map(output => output.generation
        ? { ...output, generation: { ...output.generation, prompt: '' } }
        : output),
    };
  }

  private cloneSession(session: ActiveSession): ActiveSession {
    return { ...session, taskIds: [...session.taskIds] };
  }

  private cloneEnvelope(envelope: SessionEventEnvelope): SessionEventEnvelope {
    return { sequence: envelope.sequence, event: { ...envelope.event } };
  }
}
