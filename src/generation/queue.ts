import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DirectorError, type GenTask } from '../types.js';
import { loadGraph, createEdge } from '../graph/graph-store.js';
import { applyMutation } from '../api/mutations.js';
import { ComfyUIClient } from '../comfy/client.js';
import { buildWorkflow, paramsToVars } from '../comfy/workflow.js';
import { extractLastFrame } from './ffmpeg.js';

type TaskListener = (task: GenTask) => void;
const taskListeners: TaskListener[] = [];
export function onTaskChanged(fn: TaskListener): void { taskListeners.push(fn); }

export class GenerationQueue {
  private readonly tasks = new Map<string, GenTask>();
  private drainPromise: Promise<void> | null = null;

  constructor(
    private readonly projectDir: string,
    private readonly comfy: ComfyUIClient,
  ) {}

  private emit(task: GenTask): void { for (const fn of taskListeners) fn({ ...task }); }

  submit(genNodeId: string): GenTask {
    const existing = this.tasks.get(genNodeId);
    if (existing && ['queued', 'running'].includes(existing.status)) return existing;

    const graph = loadGraph(this.projectDir);
    const gen = graph.nodes.find((n) => n.id === genNodeId && n.type === 'generation');
    if (!gen) throw new DirectorError('NODE_NOT_FOUND', `生成节点不存在: ${genNodeId}`);
    const paramsId = gen.fields.paramsNodeId;
    const params = graph.nodes.find((n) => n.id === paramsId && n.type === 'params');
    if (!params) throw new DirectorError('NODE_NOT_FOUND', `参数节点不存在: ${String(paramsId)}`);

    const task: GenTask = { id: genNodeId, status: 'queued', progress: 0 };
    this.tasks.set(genNodeId, task);
    this.emit(task);
    // 微任务延迟启动排空：submit 同步返回时任务保持 queued（供调用方观察/取消）
    queueMicrotask(() => { void this.drain(); });
    return task;
  }

  status(genNodeId: string): GenTask | null {
    return this.tasks.get(genNodeId) ?? null;
  }

  list(): GenTask[] {
    return [...this.tasks.values()];
  }

  cancel(genNodeId: string): boolean {
    const t = this.tasks.get(genNodeId);
    if (!t || t.status !== 'queued') return false;
    t.status = 'cancelled';
    this.emit(t);
    return true;
  }

  // promise 去重：并发/重复调用 drain 返回同一排空过程，await 能等到真实完成
  drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.runDrain().finally(() => { this.drainPromise = null; });
    return this.drainPromise;
  }

  private async runDrain(): Promise<void> {
    for (;;) {
      const next = [...this.tasks.values()].find((t) => t.status === 'queued');
      if (!next) break;
      await this.runOne(next);
    }
  }

  private async runOne(task: GenTask): Promise<void> {
    task.status = 'running';
    this.emit(task);
    try {
      const graph = loadGraph(this.projectDir);
      const gen = graph.nodes.find((n) => n.id === task.id);
      const paramsId = gen?.fields.paramsNodeId;
      const params = graph.nodes.find((n) => n.id === paramsId && n.type === 'params');
      if (!gen || !params) throw new DirectorError('NODE_NOT_FOUND', '生成节点或参数节点缺失');

      const template = typeof params.fields.template === 'string' ? params.fields.template : 'keyframe-video';
      const vars = paramsToVars(params);
      const workflow = buildWorkflow(template, vars);

      const clientId = randomUUID();
      const promptId = await this.comfy.submit(workflow, clientId);
      task.promptId = promptId;
      this.emit(task);

      const out = await this.comfy.waitForDone(promptId);
      if (out.media.length === 0) {
        throw new DirectorError('INVALID_PATCH', '生成完成但无输出媒体');
      }

      mkdirSync(join(this.projectDir, 'out'), { recursive: true });
      const videoRel = `out/${task.id}.mp4`;
      const videoAbs = join(this.projectDir, videoRel);
      await this.comfy.download(out.media[0]!, videoAbs);

      // 末帧抽取失败不 fail 任务：跳过链式连线
      let lastFrameRel: string | null = null;
      try {
        lastFrameRel = `out/${task.id}_last_frame.png`;
        await extractLastFrame(videoAbs, join(this.projectDir, lastFrameRel));
      } catch {
        lastFrameRel = null;
      }

      task.progress = 100;
      applyMutation(this.projectDir, 'user', `生成完成 ${task.id}`, (g) => {
        const node = g.nodes.find((n) => n.id === task.id);
        if (node) {
          node.fields.status = 'success';
          node.fields.result = { videoPath: videoRel, lastFramePath: lastFrameRel ?? '' };
          node.fields.promptId = promptId;
          node.version += 1;
          // 链式参考边：末帧成功抽取且指定了下一分镜
          const nextShotId = node.fields.nextShotId;
          if (lastFrameRel && typeof nextShotId === 'string') {
            const dup = g.edges.some(
              (e) => e.kind === 'chain' && e.source === task.id && e.target === nextShotId,
            );
            if (!dup) {
              createEdge(g, {
                kind: 'chain', source: task.id, target: nextShotId,
                label: '末帧=场景参考',
              });
            }
          }
        }
      });

      task.status = 'success';
      task.result = { videoPath: videoRel, lastFramePath: lastFrameRel ?? '' };
      this.emit(task);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      task.status = 'failed';
      task.error = message;
      this.emit(task);
      applyMutation(this.projectDir, 'user', `生成失败 ${task.id}`, (g) => {
        const node = g.nodes.find((n) => n.id === task.id);
        if (node) {
          node.fields.status = 'failed';
          node.fields.error = message;
          node.version += 1;
        }
      });
    }
  }
}
