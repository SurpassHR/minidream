import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TaskKind, TaskRecord, TaskStatus } from '../types.js';

export type TaskHandler = (task: TaskRecord) => Promise<Record<string, unknown> | undefined>;
export type TaskListener = (task: TaskRecord) => void;

type QueueFile = { version: 1; tasks: TaskRecord[] };
type SubmitInput = {
  kind: TaskKind;
  label: string;
  projectDir?: string;
  payload: Record<string, unknown>;
  dedupeKey?: string;
};
type Waiter = {
  promise: Promise<TaskRecord>;
  resolve: (task: TaskRecord) => void;
};

export function defaultTaskQueuePath(): string {
  return join(homedir(), '.director', 'task-queue.json');
}

function copyTask(task: TaskRecord): TaskRecord {
  return {
    ...task,
    payload: { ...task.payload },
    result: task.result ? { ...task.result } : undefined,
  };
}

function isStatus(value: unknown): value is TaskStatus {
  return value === 'queued' || value === 'running' || value === 'success'
    || value === 'failed' || value === 'cancelled' || value === 'interrupted';
}

function isTask(value: unknown): value is TaskRecord {
  if (!value || typeof value !== 'object') return false;
  const task = value as Partial<TaskRecord>;
  return typeof task.id === 'string'
    && typeof task.kind === 'string'
    && typeof task.label === 'string'
    && isStatus(task.status)
    && typeof task.progress === 'number'
    && typeof task.createdAt === 'number'
    && typeof task.updatedAt === 'number'
    && typeof task.payload === 'object'
    && task.payload !== null;
}

export class TaskQueue {
  private readonly filePath: string;
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly handlers = new Map<TaskKind, TaskHandler>();
  private readonly listeners = new Set<TaskListener>();
  private readonly waiters = new Map<string, Waiter>();
  private drainPromise: Promise<void> | null = null;
  private started = false;

  constructor(opts: { filePath?: string; autoStart?: boolean } = {}) {
    this.filePath = opts.filePath ?? defaultTaskQueuePath();
    this.load();
    if (opts.autoStart) this.start();
  }

  register(kind: TaskKind, handler: TaskHandler): void {
    this.handlers.set(kind, handler);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    queueMicrotask(() => { void this.drain(); });
  }

  submit(input: SubmitInput): { task: TaskRecord; completion: Promise<TaskRecord> } {
    if (input.dedupeKey) {
      const existing = [...this.tasks.values()].find(
        (task) => task.dedupeKey === input.dedupeKey && (task.status === 'queued' || task.status === 'running'),
      );
      if (existing) return { task: copyTask(existing), completion: this.wait(existing.id) };
    }

    const now = Date.now();
    const task: TaskRecord = {
      id: randomUUID(),
      kind: input.kind,
      label: input.label,
      status: 'queued',
      projectDir: input.projectDir,
      progress: 0,
      createdAt: now,
      updatedAt: now,
      payload: { ...input.payload },
      dedupeKey: input.dedupeKey,
    };
    this.tasks.set(task.id, task);
    try {
      this.persist();
    } catch (err) {
      this.tasks.delete(task.id);
      throw err;
    }
    this.emit(task);
    queueMicrotask(() => { void this.drain(); });
    return { task: copyTask(task), completion: this.wait(task.id) };
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()].map(copyTask);
  }

  get(id: string): TaskRecord | null {
    const task = this.tasks.get(id);
    return task ? copyTask(task) : null;
  }

  wait(id: string): Promise<TaskRecord> {
    const task = this.tasks.get(id);
    if (!task) return Promise.reject(new Error(`任务不存在: ${id}`));
    if (task.status === 'success' || task.status === 'failed' || task.status === 'cancelled') {
      return Promise.resolve(copyTask(task));
    }
    return this.getOrCreateWaiter(id).promise;
  }

  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'queued') return false;
    task.status = 'cancelled';
    task.finishedAt = Date.now();
    task.updatedAt = task.finishedAt;
    this.persist();
    this.emit(task);
    this.resolveWaiter(task);
    return true;
  }

  retry(id: string): { task: TaskRecord; completion: Promise<TaskRecord> } | null {
    const task = this.tasks.get(id);
    if (!task || (task.status !== 'failed' && task.status !== 'interrupted')) return null;
    task.status = 'queued';
    task.progress = 0;
    task.updatedAt = Date.now();
    delete task.startedAt;
    delete task.finishedAt;
    delete task.error;
    delete task.result;
    this.persist();
    this.emit(task);
    queueMicrotask(() => { void this.drain(); });
    return { task: copyTask(task), completion: this.wait(task.id) };
  }

  subscribe(listener: TaskListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<QueueFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.tasks)) return;
      let changed = false;
      for (const item of parsed.tasks) {
        if (!isTask(item)) continue;
        const task = { ...item, payload: { ...item.payload }, result: item.result ? { ...item.result } : undefined };
        if (task.status === 'running') {
          task.status = 'interrupted';
          task.updatedAt = Date.now();
          task.finishedAt = task.updatedAt;
          changed = true;
        }
        this.tasks.set(task.id, task);
      }
      if (changed) this.persist();
    } catch (err) {
      console.error(`任务队列文件读取失败: ${this.filePath}`, err);
    }
  }

  private persist(): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    const file: QueueFile = { version: 1, tasks: this.list() };
    writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
    renameSync(tmp, this.filePath);
  }

  async drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.runDrain().finally(() => { this.drainPromise = null; });
    return this.drainPromise;
  }

  private async runDrain(): Promise<void> {
    for (;;) {
      const task = [...this.tasks.values()].find((item) => item.status === 'queued');
      if (!task) return;
      await this.runOne(task);
    }
  }

  private async runOne(task: TaskRecord): Promise<void> {
    task.status = 'running';
    task.startedAt = Date.now();
    task.updatedAt = task.startedAt;
    this.persist();
    this.emit(task);
    try {
      const handler = this.handlers.get(task.kind);
      if (!handler) throw new Error(`未注册任务执行器: ${task.kind}`);
      const result = await handler(copyTask(task));
      task.status = 'success';
      task.progress = 100;
      task.result = result ? { ...result } : undefined;
      task.updatedAt = Date.now();
      task.finishedAt = task.updatedAt;
      this.persist();
      this.emit(task);
      this.resolveWaiter(task);
    } catch (err) {
      task.status = 'failed';
      task.error = err instanceof Error ? err.message : String(err);
      task.updatedAt = Date.now();
      task.finishedAt = task.updatedAt;
      this.persist();
      this.emit(task);
      this.resolveWaiter(task);
    }
  }

  private getOrCreateWaiter(id: string): Waiter {
    const existing = this.waiters.get(id);
    if (existing) return existing;
    let resolve!: (task: TaskRecord) => void;
    const promise = new Promise<TaskRecord>((r) => { resolve = r; });
    const waiter = { promise, resolve };
    this.waiters.set(id, waiter);
    return waiter;
  }

  private resolveWaiter(task: TaskRecord): void {
    const waiter = this.waiters.get(task.id);
    if (!waiter) return;
    this.waiters.delete(task.id);
    waiter.resolve(copyTask(task));
  }

  private emit(task: TaskRecord): void {
    const copy = copyTask(task);
    for (const listener of this.listeners) listener(copy);
  }
}
