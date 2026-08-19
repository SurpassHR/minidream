import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DirectorError, type GenTask, type TaskRecord } from '../types.js';
import { loadGraph, createEdge } from '../graph/graph-store.js';
import { applyMutation } from '../api/mutations.js';
import { ComfyUIClient } from '../comfy/client.js';
import { buildWorkflow, paramsToVars } from '../comfy/workflow.js';
import { extractLastFrame } from './ffmpeg.js';
import { TaskQueue } from '../tasks/queue.js';

export async function runGenerationTask(
  projectDir: string,
  genNodeId: string,
  comfy: ComfyUIClient,
): Promise<Record<string, unknown>> {
  const graph = loadGraph(projectDir);
  const gen = graph.nodes.find((n) => n.id === genNodeId && n.type === 'generation');
  const paramsId = gen?.fields.paramsNodeId;
  const params = graph.nodes.find((n) => n.id === paramsId && n.type === 'params');
  if (!gen || !params) throw new DirectorError('NODE_NOT_FOUND', '生成节点或参数节点缺失');

  const template = typeof params.fields.template === 'string' ? params.fields.template : 'keyframe-video';
  const vars = paramsToVars(params);
  const workflow = buildWorkflow(template, vars);
  const promptId = await comfy.submit(workflow, randomUUID());
  const out = await comfy.waitForDone(promptId);
  if (out.media.length === 0) throw new DirectorError('INVALID_PATCH', '生成完成但无输出媒体');

  mkdirSync(join(projectDir, 'out'), { recursive: true });
  const videoRel = `out/${genNodeId}.mp4`;
  const videoAbs = join(projectDir, videoRel);
  await comfy.download(out.media[0]!, videoAbs);

  let lastFrameRel: string | null = null;
  try {
    lastFrameRel = `out/${genNodeId}_last_frame.png`;
    await extractLastFrame(videoAbs, join(projectDir, lastFrameRel));
  } catch {
    lastFrameRel = null;
  }

  applyMutation(projectDir, 'user', `生成完成 ${genNodeId}`, (g) => {
    const node = g.nodes.find((n) => n.id === genNodeId);
    if (!node) return;
    node.fields.status = 'success';
    node.fields.result = { videoPath: videoRel, lastFramePath: lastFrameRel ?? '' };
    node.fields.promptId = promptId;
    node.version += 1;
    const nextShotId = node.fields.nextShotId;
    if (lastFrameRel && typeof nextShotId === 'string') {
      const duplicate = g.edges.some(
        (edge) => edge.kind === 'chain' && edge.source === genNodeId && edge.target === nextShotId,
      );
      if (!duplicate) {
        createEdge(g, {
          kind: 'chain', source: genNodeId, target: nextShotId,
          label: '末帧=场景参考',
        });
      }
    }
  });

  return { promptId, videoPath: videoRel, lastFramePath: lastFrameRel ?? '' };
}

function toGenTask(task: TaskRecord): GenTask {
  const nodeId = typeof task.payload.nodeId === 'string' ? task.payload.nodeId : task.id;
  return {
    id: nodeId,
    status: task.status === 'interrupted' ? 'failed' : task.status,
    progress: task.progress,
    error: task.error,
    promptId: typeof task.result?.promptId === 'string' ? task.result.promptId : undefined,
    result: task.result && typeof task.result.videoPath === 'string'
      ? {
        videoPath: task.result.videoPath,
        lastFramePath: typeof task.result.lastFramePath === 'string' ? task.result.lastFramePath : '',
      }
      : undefined,
  };
}

export class GenerationQueue {
  private readonly taskQueue: TaskQueue;
  private readonly legacyTasks = new Map<string, GenTask>();

  constructor(
    private readonly projectDir: string,
    private readonly comfy: ComfyUIClient,
    taskQueue?: TaskQueue,
  ) {
    this.taskQueue = taskQueue ?? new TaskQueue({ filePath: join(projectDir, '.director', 'task-queue.json') });
    this.taskQueue.register('comfy-generation', async (task) => {
      const nodeId = typeof task.payload.nodeId === 'string' ? task.payload.nodeId : '';
      const projectDir = task.projectDir ?? this.projectDir;
      const baseUrl = typeof task.payload.comfyBaseUrl === 'string' ? task.payload.comfyBaseUrl : this.comfy.baseUrl;
      try {
        return await runGenerationTask(projectDir, nodeId, new ComfyUIClient(baseUrl));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        applyMutation(projectDir, 'user', `生成失败 ${nodeId}`, (g) => {
          const node = g.nodes.find((n) => n.id === nodeId);
          if (node) {
            node.fields.status = 'failed';
            node.fields.error = message;
            node.version += 1;
          }
        });
        throw err;
      }
    });
  }

  submit(genNodeId: string): GenTask {
    const graph = loadGraph(this.projectDir);
    const gen = graph.nodes.find((n) => n.id === genNodeId && n.type === 'generation');
    if (!gen) throw new DirectorError('NODE_NOT_FOUND', `生成节点不存在: ${genNodeId}`);
    const paramsId = gen.fields.paramsNodeId;
    const params = graph.nodes.find((n) => n.id === paramsId && n.type === 'params');
    if (!params) throw new DirectorError('NODE_NOT_FOUND', `参数节点不存在: ${String(paramsId)}`);

    const submitted = this.taskQueue.submit({
      kind: 'comfy-generation',
      label: gen.title,
      projectDir: this.projectDir,
      payload: { nodeId: genNodeId, comfyBaseUrl: this.comfy.baseUrl },
      dedupeKey: `comfy-generation:${this.projectDir}:${genNodeId}`,
    });
    return this.toLegacyTask(submitted.task);
  }

  status(genNodeId: string): GenTask | null {
    const task = this.findTask(genNodeId);
    return task ? this.toLegacyTask(task) : null;
  }

  list(): GenTask[] {
    return this.taskQueue.list()
      .filter((task) => task.kind === 'comfy-generation' && task.projectDir === this.projectDir)
      .map((task) => this.toLegacyTask(task));
  }

  cancel(genNodeId: string): boolean {
    const task = this.findTask(genNodeId);
    return task ? this.taskQueue.cancel(task.id) : false;
  }

  drain(): Promise<void> {
    return this.taskQueue.drain();
  }

  private findTask(genNodeId: string): TaskRecord | null {
    return this.taskQueue.list()
      .filter((task) => (
        task.kind === 'comfy-generation'
        && task.projectDir === this.projectDir
        && task.payload.nodeId === genNodeId
      ))
      .reverse()[0] ?? null;
  }

  private toLegacyTask(task: TaskRecord): GenTask {
    const next = toGenTask(task);
    const existing = this.legacyTasks.get(next.id);
    if (!existing) {
      this.legacyTasks.set(next.id, next);
      return next;
    }
    Object.assign(existing, next);
    return existing;
  }
}
