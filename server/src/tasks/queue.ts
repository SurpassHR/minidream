import EventEmitter from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TaskItem, TaskOutput, TaskOutputCandidate, TaskStage, TaskStatus, TaskSubmitInput, TaskType } from './types.js';
import type { DraftStore } from '../drafts.js';
import { buildPrompt, buildSpecsCached, getWorkflowJson } from '../workflow.js';
import { computeResolution } from '../resolution.js';
import {
  cancelPrompt,
  deleteOutput,
  downloadOutput,
  COMFYUI_BASE_URL,
  getHistory,
  submitPrompt,
  uploadFile,
  viewUrl,
  watchComfyUI,
  type WsMessage,
} from '../comfyui.js';
import { readSettings } from '../settings.js';

export interface ProgressUpdate {
  stage?: string;
  step?: number;
  totalSteps?: number;
  progress?: number;
  log?: string;
}

export type TaskExecutor = (
  task: TaskItem,
  onProgress: (update: ProgressUpdate) => void,
  signal?: AbortSignal,
) => Promise<{ outputs?: TaskOutputCandidate[] }>;

export interface TaskQueueOptions {
  dataFile: string;
  settingsFile?: string;
  drafts?: DraftStore;
  autoStart?: boolean;
  executor?: TaskExecutor;
}

export class TaskQueue extends EventEmitter {
  private dataFile: string;
  private settingsFile?: string;
  private drafts?: DraftStore;
  private tasks: Map<string, TaskItem> = new Map();
  private isProcessing = false;
  private customExecutor?: TaskExecutor;
  private currentAbortController?: AbortController;
  private currentComfyPromptId?: string;
  private lastTimestamp = 0;

  constructor(options: TaskQueueOptions) {
    super();
    this.dataFile = options.dataFile;
    this.settingsFile = options.settingsFile;
    this.drafts = options.drafts;
    this.customExecutor = options.executor;

    this.loadFromDisk();
    if (options.autoStart !== false) {
      this.processNext();
    }
  }

  private loadFromDisk(): void {
    if (!existsSync(this.dataFile)) {
      return;
    }
    try {
      const content = readFileSync(this.dataFile, 'utf8');
      const list = JSON.parse(content);
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item && typeof item === 'object' && item.id) {
            const task: TaskItem = {
              ...item,
              status: item.status === 'running' ? 'interrupted' : item.status,
            };
            this.tasks.set(task.id, task);
            this.lastTimestamp = Math.max(this.lastTimestamp, task.createdAt, task.updatedAt);
          }
        }
      }
    } catch {
      // 容错处理
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.dataFile), { recursive: true });
      const tmp = `${this.dataFile}.tmp`;
      const list = Array.from(this.tasks.values());
      writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
      renameSync(tmp, this.dataFile);
    } catch {
      // 忽略持久化临时异常
    }
  }

  private nextTimestamp(): number {
    this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1);
    return this.lastTimestamp;
  }

  private inferTaskType(workflowId: string): TaskType {
    if (workflowId.toLowerCase().includes('video') || workflowId.toLowerCase().includes('h3')) {
      return 'video_generation';
    }
    return 'image_generation';
  }

  public submit(input: TaskSubmitInput): TaskItem {
    const id = `task-${randomUUID().slice(0, 8)}`;
    const now = this.nextTimestamp();
    const type = input.type || this.inferTaskType(input.workflowId);

    const initialStages: TaskStage[] = [
      { id: 'stage-prepare', name: '准备中', status: 'active', logs: ['任务已提交'] },
      { id: 'stage-queue', name: '排队中', status: 'pending', logs: [] },
      { id: 'stage-sampling', name: '采样计算', status: 'pending', logs: [] },
      { id: 'stage-export', name: '导出产物', status: 'pending', logs: [] },
    ];

    const task: TaskItem = {
      id,
      type,
      status: 'queued',
      workflowId: input.workflowId,
      prompt: input.prompt,
      images: input.images,
      videos: input.videos,
      imageUploads: input.imageUploads,
      videoUploads: input.videoUploads,
      params: input.params,
      sessionId: input.sessionId,
      promptGraph: input.promptGraph,
      ratio: input.ratio,
      size: input.size,
      stages: initialStages,
      createdAt: now,
      updatedAt: now,
    };

    this.tasks.set(id, task);
    this.persist();
    this.emit('task:change', task);

    // 触发调度
    setImmediate(() => this.processNext());

    return task;
  }

  public get(id: string): TaskItem | undefined {
    return this.tasks.get(id);
  }

  public getTask(id: string): TaskItem | undefined {
    return this.get(id);
  }

  /** 在 Agent 工具返回任务 ID 后补充会话归属。 */
  public bindSession(id: string, sessionId: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'queued' && task.status !== 'running') return false;
    task.sessionId = sessionId;
    task.updatedAt = this.nextTimestamp();
    this.persist();
    this.emit('task:change', task);
    return true;
  }

  /** 任务提交后补充生成偏好（比例/尺寸），执行构建 prompt 时换算为分辨率。 */
  public setGenPrefs(id: string, ratio?: string, size?: number): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    task.ratio = ratio;
    task.size = size;
    task.updatedAt = this.nextTimestamp();
    this.persist();
    this.emit('task:change', task);
    return true;
  }

  public list(): TaskItem[] {
    return Array.from(this.tasks.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  public listTasks(): TaskItem[] {
    return this.list();
  }

  public cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;

    if (task.status === 'queued') {
      task.status = 'canceled';
      task.updatedAt = this.nextTimestamp();
      this.persist();
      this.emit('task:change', task);
      return true;
    }

    if (task.status === 'running') {
      task.status = 'canceled';
      task.updatedAt = this.nextTimestamp();
      if (this.currentAbortController) {
        this.currentAbortController.abort();
      }
      if (this.currentComfyPromptId) {
        cancelPrompt(this.currentComfyPromptId).catch(() => {});
      }
      this.persist();
      this.emit('task:change', task);
      return true;
    }

    return false;
  }

  public cancelTask(id: string): TaskItem | undefined {
    const task = this.get(id);
    if (!task) return undefined;
    this.cancel(id);
    return this.get(id);
  }

  /** 取消某个会话下所有排队中或运行中的任务。 */
  public cancelBySession(sessionId: string): TaskItem[] {
    return this.list()
      .filter(task => task.sessionId === sessionId && (task.status === 'queued' || task.status === 'running'))
      .map(task => {
        this.cancel(task.id);
        return this.get(task.id)!;
      });
  }

  public subscribeTask(
    id: string,
    listener: (event: 'updated' | 'completed' | 'failed' | 'canceled', task: TaskItem) => void,
  ): () => void {
    const handler = (task: TaskItem) => {
      if (task.id !== id) return;
      if (task.status === 'completed') {
        listener('completed', task);
      } else if (task.status === 'failed') {
        listener('failed', task);
      } else if (task.status === 'canceled') {
        listener('canceled', task);
      } else {
        listener('updated', task);
      }
    };
    this.on('task:change', handler);
    this.on('task:progress', handler);
    return () => {
      this.off('task:change', handler);
      this.off('task:progress', handler);
    };
  }

  private updateTask(id: string, updater: (task: TaskItem) => void): TaskItem | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    updater(task);
    task.updatedAt = this.nextTimestamp();
    this.persist();
    this.emit('task:change', task);
    return task;
  }

  private async processNext(): Promise<void> {
    if (this.isProcessing) return;

    // 寻找下一个排队中的任务
    const nextTask = Array.from(this.tasks.values())
      .filter(t => t.status === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt)[0];

    if (!nextTask) return;

    this.isProcessing = true;
    this.currentAbortController = new AbortController();

    this.updateTask(nextTask.id, t => {
      t.status = 'running';
      if (t.stages[0]) t.stages[0].status = 'completed';
      if (t.stages[1]) t.stages[1].status = 'active';
    });

    try {
      if (this.customExecutor) {
        const res = await this.customExecutor(
          nextTask,
          progress => {
            this.handleProgress(nextTask.id, progress);
          },
          this.currentAbortController.signal,
        );

        if (this.tasks.get(nextTask.id)?.status === 'canceled') {
          return;
        }

        const outputs = await this.persistOutputs(nextTask.id, res.outputs);
        this.updateTask(nextTask.id, t => {
          t.status = 'completed';
          t.outputs = outputs;
          t.stages.forEach(s => (s.status = 'completed'));
        });
      } else {
        await this.executeRealComfyTask(nextTask, this.currentAbortController.signal);
      }
    } catch (err: any) {
      if (this.tasks.get(nextTask.id)?.status === 'canceled') {
        return;
      }
      this.updateTask(nextTask.id, t => {
        t.status = 'failed';
        t.error = err?.message || String(err);
        const lastActive = t.stages.find(s => s.status === 'active');
        if (lastActive) {
          lastActive.status = 'failed';
          lastActive.logs.push(`错误: ${t.error}`);
        }
      });
    } finally {
      this.isProcessing = false;
      this.currentAbortController = undefined;
      this.currentComfyPromptId = undefined;
      setImmediate(() => this.processNext());
    }
  }

  private handleProgress(taskId: string, progress: ProgressUpdate): void {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return;

    if (progress.stage) {
      const stageObj = task.stages.find(s => s.name === progress.stage || s.id.includes(progress.stage!));
      if (stageObj) {
        stageObj.status = 'active';
        if (progress.step !== undefined) stageObj.step = progress.step;
        if (progress.totalSteps !== undefined) stageObj.totalSteps = progress.totalSteps;
        if (progress.progress !== undefined) stageObj.progress = progress.progress;
        if (progress.log) stageObj.logs.push(progress.log);
      }
    }

    task.updatedAt = this.nextTimestamp();
    this.persist();
    this.emit('task:progress', task);
  }

  private async executeRealComfyTask(task: TaskItem, signal: AbortSignal): Promise<void> {
    const specs = await buildSpecsCached();
    const spec = specs.find(s => s.id === task.workflowId) ?? specs[0];
    if (!spec) {
      throw new Error(`找不到可用的工作流模板: ${task.workflowId}`);
    }

    const workflowJson = getWorkflowJson(spec.id);
    if (!workflowJson) {
      throw new Error(`找不到工作流源文件: ${spec.id}`);
    }

    // 1. 上传任务携带的素材（上传也属于队列执行生命周期）
    const uploaded: Record<string, string> = {};
    const imageInputs = spec.inputs.filter(i => i.kind === 'image');
    const videoInputs = spec.inputs.filter(i => i.kind === 'video');
    for (let i = 0; i < (task.imageUploads?.length ?? 0) && i < imageInputs.length; i++) {
      const upload = task.imageUploads?.[i];
      const inputSpec = imageInputs[i];
      if (!upload || !inputSpec) continue;
      const parsed = /^data:([^;]+);base64,(.*)$/s.exec(upload.dataUrl);
      if (!parsed) throw new Error('图片素材格式无效（需 data URL）');
      const ext = upload.name?.includes('.') ? upload.name.split('.').pop() : 'bin';
      const upRes = await uploadFile('image', `upload-${Date.now()}-${i}.${ext}`, Buffer.from(parsed[2] ?? '', 'base64'));
      uploaded[inputSpec.id] = upRes.subfolder ? `${upRes.subfolder}/${upRes.name}` : upRes.name;
    }
    for (let i = 0; i < (task.videoUploads?.length ?? 0) && i < videoInputs.length; i++) {
      const upload = task.videoUploads?.[i];
      const inputSpec = videoInputs[i];
      if (!upload || !inputSpec) continue;
      const parsed = /^data:([^;]+);base64,(.*)$/s.exec(upload.dataUrl);
      if (!parsed) throw new Error('视频素材格式无效（需 data URL）');
      const ext = upload.name?.includes('.') ? upload.name.split('.').pop() : 'bin';
      const upRes = await uploadFile('video', `upload-${Date.now()}-${i}.${ext}`, Buffer.from(parsed[2] ?? '', 'base64'));
      uploaded[inputSpec.id] = upRes.subfolder ? `${upRes.subfolder}/${upRes.name}` : upRes.name;
    }

    // 2. 兼容外部传入的本地路径或已上传 ComfyUI 文件名
    for (let i = 0; i < (task.images?.length ?? 0) && i < imageInputs.length; i++) {
      const imagePath = task.images?.[i];
      const inputSpec = imageInputs[i];
      if (!imagePath || !inputSpec || uploaded[inputSpec.id]) continue;
      if (imagePath.startsWith('/') || imagePath.startsWith('./')) {
        try {
          const fileBuf = readFileSync(imagePath);
          const upRes = await uploadFile('image', `upload-${Date.now()}-${i}.png`, fileBuf);
          uploaded[inputSpec.id] = upRes.subfolder ? `${upRes.subfolder}/${upRes.name}` : upRes.name;
        } catch {
          uploaded[inputSpec.id] = imagePath;
        }
      } else {
        uploaded[inputSpec.id] = imagePath;
      }
    }
    for (let i = 0; i < (task.videos?.length ?? 0) && i < videoInputs.length; i++) {
      const videoPath = task.videos?.[i];
      const inputSpec = videoInputs[i];
      if (!videoPath || !inputSpec || uploaded[inputSpec.id]) continue;
      uploaded[inputSpec.id] = videoPath;
    }

    // 3. 读取全局 Settings，并在队列内部构建唯一 prompt 图
    const settings = this.settingsFile ? readSettings(this.settingsFile).imageGen : undefined;
    // 插件参数覆盖（设置面板按工作流配置的 unet/clip/vae/lora/sampler/scheduler 等）
    const pluginConfig = this.settingsFile
      ? (readSettings(this.settingsFile).plugins.config?.[spec.id] ?? {})
      : {};
    // 生成比例+尺寸 → 目标宽高（视频工作流分辨率上限远小于图像）
    const maxDimension = spec.outputs.some(o => o.kind === 'video') ? 1344 : 2048;
    const resolution = computeResolution(task.ratio, task.size, maxDimension);
    const prompt = task.promptGraph ?? await buildPrompt(spec, workflowJson, {
      prompt: task.prompt,
      uploaded,
      params: { ...pluginConfig, ...task.params },
      settings,
      resolution,
    });

    if (signal.aborted) return;

    // 4. 连接 WebSocket 监听采样进度
    const clientId = `task-client-${randomUUID().slice(0, 8)}`;
    let stopWatch: (() => void) | undefined;

    try {
      stopWatch = watchComfyUI(clientId, (msg: WsMessage) => {
        if (msg.type === 'progress' && msg.data) {
          const value = Number(msg.data.value);
          const max = Number(msg.data.max);
          if (max > 0) {
            this.handleProgress(task.id, {
              stage: '采样计算',
              step: value,
              totalSteps: max,
              progress: Math.round((value / max) * 100),
            });
          }
        }
      });
    } catch {
      // 忽略 ws 连接失败
    }

    // 5. 提交给 ComfyUI 执行
    this.updateTask(task.id, t => {
      if (t.stages[1]) t.stages[1].status = 'completed';
      if (t.stages[2]) t.stages[2].status = 'active';
    });

    try {
      const subRes = await submitPrompt(prompt, clientId);
      this.currentComfyPromptId = subRes.prompt_id;

      if (signal.aborted) {
        await cancelPrompt(subRes.prompt_id).catch(() => {});
        return;
      }

      // 6. 轮询历史记录获取最终产物
      let history: Record<string, any> | undefined;
      const startTime = Date.now();
      while (Date.now() - startTime < 300000) {
        if (signal.aborted) {
          await cancelPrompt(subRes.prompt_id).catch(() => {});
          return;
        }
        const histRes = await getHistory(subRes.prompt_id).catch(() => undefined);
        if (histRes && histRes[subRes.prompt_id]) {
          history = histRes[subRes.prompt_id];
          break;
        }
        await new Promise(r => setTimeout(r, 1000));
      }

      if (!history) {
        throw new Error('等待生成超时或未获取到输出历史');
      }

      const outputs: TaskOutput[] = [];
      for (const outNode of Object.values(history?.outputs || {})) {
        const nodeOut = outNode as any;
        if (Array.isArray(nodeOut?.images)) {
          for (const img of nodeOut.images) {
            outputs.push({
              kind: 'image',
              filename: img.filename,
              subfolder: img.subfolder,
              type: img.type,
              url: viewUrl(img.filename, img.subfolder || '', img.type || 'output'),
            });
          }
        }
        if (Array.isArray(nodeOut?.gifs)) {
          for (const gif of nodeOut.gifs) {
            outputs.push({
              kind: 'video',
              filename: gif.filename,
              subfolder: gif.subfolder,
              type: gif.type,
              url: viewUrl(gif.filename, gif.subfolder || '', gif.type || 'output'),
            });
          }
        }
        if (Array.isArray(nodeOut?.videos)) {
          for (const vid of nodeOut.videos) {
            outputs.push({
              kind: 'video',
              filename: vid.filename,
              subfolder: vid.subfolder,
              type: vid.type,
              url: viewUrl(vid.filename, vid.subfolder || '', vid.type || 'output'),
            });
          }
        }
      }

      const localOutputs = await this.persistOutputs(task.id, outputs);
      this.updateTask(task.id, t => {
        t.status = 'completed';
        t.outputs = localOutputs;
        t.stages.forEach(s => (s.status = 'completed'));
      });
    } finally {
      if (stopWatch) {
        stopWatch();
      }
    }
  }

  private async persistOutputs(taskId: string, outputs?: TaskOutputCandidate[]): Promise<TaskOutput[]> {
    if (!outputs?.length || !this.drafts) return (outputs ?? []).map(({ data: _data, mime: _mime, ...output }) => output);
    const local: TaskOutputCandidate[] = [];
    for (const output of outputs) {
      let data = output.data;
      let mime = output.mime;
      if (!data && output.filename) {
        const downloaded = await downloadOutput(output.filename, output.subfolder ?? '', output.type ?? 'output');
        data = downloaded.data;
        mime = downloaded.mime;
      }
      if (!data) {
        local.push(output);
        continue;
      }
      const draft = await this.drafts.saveFromBuffer({
        taskId,
        kind: output.kind,
        sourceName: output.filename,
        mime,
        data,
      });
      if (!output.data && output.filename) {
        await deleteOutput(output.filename, output.subfolder ?? '', output.type ?? 'output').catch(() => undefined);
      }
      local.push({
        ...output,
        url: `/api/drafts/${draft.id}/file`,
        filename: draft.filename,
        data: undefined,
        mime: undefined,
      });
    }
    return local.map(({ data: _data, mime: _mime, ...output }) => output);
  }
}
