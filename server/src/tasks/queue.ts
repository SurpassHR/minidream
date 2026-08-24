import EventEmitter from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TaskItem, TaskOutput, TaskOutputCandidate, TaskStage, TaskStatus, TaskSubmitInput, TaskType } from './types.js';
import { inferMimeType, type DraftStore } from '../drafts.js';
import { buildPrompt, buildSpecsCached, getWorkflowJson } from '../workflow.js';
import { extractHistoryOutputs } from './history-outputs.js';
import { computeResolution } from '../resolution.js';
import {
  cancelPrompt,
  deleteOutput,
  downloadOutput,
  fileExists,
  COMFYUI_BASE_URL,
  getHistory,
  submitPrompt,
  uploadFile,
  watchComfyUI,
  type WsMessage,
} from '../comfyui.js';
import { readSessions } from '../sessions.js';
import { readSettings } from '../settings.js';
import { buildGenerationMetadata } from '../image-metadata.js';

/**
 * 会话素材标签 → 真实产物 的映射：与前端 extractSessionAssets 同口径，
 * 按会话消息顺序累计 image/video 产物并命名为 image1/image2/video1/video2…。
 * 用于把 Agent 误传的 `@imageN`/`@videoN` 标签解析为真实文件。
 */
export function resolveSessionAssetLabels(
  sessionsFile: string | undefined,
  sessionId: string | undefined,
): Map<string, TaskOutput> {
  const map = new Map<string, TaskOutput>();
  if (!sessionsFile || !sessionId) return map;
  let file;
  try {
    file = readSessions(sessionsFile);
  } catch {
    return map;
  }
  const session = file.sessions.find(s => s.id === sessionId);
  if (!session) return map;
  const counts: Record<'image' | 'video', number> = { image: 0, video: 0 };
  const seen = new Set<string>();
  const collect = (output: TaskOutput | undefined) => {
    if (!output || (output.kind !== 'image' && output.kind !== 'video') || !output.url || seen.has(output.url)) return;
    seen.add(output.url);
    counts[output.kind] += 1;
    map.set(`${output.kind}${counts[output.kind]}`, output);
  };
  for (const msg of session.messages) {
    for (const task of (msg.tasks ?? []) as Array<{ outputs?: TaskOutput[] }>) {
      for (const output of task.outputs ?? []) collect(output);
    }
    for (const stage of (msg.stages ?? []) as Array<{ outputs?: TaskOutput[] }>) {
      for (const output of stage.outputs ?? []) collect(output);
    }
  }
  return map;
}

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
  /** 会话存储文件；提供后支持把 @imageN/@videoN 标签解析为会话历史中的真实产物 */
  sessionsFile?: string;
  drafts?: DraftStore;
  autoStart?: boolean;
  executor?: TaskExecutor;
}

/**
 * 从 ComfyUI history 中提取执行错误（status=error 时的 execution_error 消息）。
 * 返回 null 表示执行成功。
 */
export function extractHistoryError(history: Record<string, any> | undefined): string | null {
  if (history?.status?.status_str !== 'error') return null;
  const execErrorMsg = (history.status.messages ?? []).find((m: unknown[]) => m?.[0] === 'execution_error');
  if (!execErrorMsg) return 'ComfyUI 执行出错：未知错误';
  const data = execErrorMsg[1] as
    | {
        message?: string;
        exception_message?: string;
        exception_type?: string;
        node_type?: string;
        node_id?: number | string;
      }
    | undefined;
  const exception = data?.exception_message || data?.message || '未知错误';
  const node = data?.node_type
    ? `（节点 ${data.node_type}${data.node_id !== undefined ? ` #${data.node_id}` : ''}）`
    : '';
  console.error('[comfyui] 执行错误详情:', JSON.stringify(data, null, 2));
  return `ComfyUI 执行出错：${exception}${node}`;
}

export class TaskQueue extends EventEmitter {
  private dataFile: string;
  private settingsFile?: string;
  private sessionsFile?: string;
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
    this.sessionsFile = options.sessionsFile;
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
              outputs: Array.isArray(item.outputs)
                ? item.outputs.map((output: TaskOutput) => ({
                  ...output,
                  kind: output.kind === 'image' && inferMimeType(output.filename)?.startsWith('video/')
                    ? 'video'
                    : output.kind,
                }))
                : item.outputs,
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
    console.log(
      `[task:${nextTask.id}] 开始执行 workflowId=${nextTask.workflowId} type=${nextTask.type} ` +
        `images=${nextTask.images?.length ?? 0} videos=${nextTask.videos?.length ?? 0} ` +
        `prompt=${(nextTask.prompt || '').slice(0, 300)}`,
    );

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
      console.error(`[task:${nextTask.id}] 任务执行失败 workflowId=${nextTask.workflowId} type=${nextTask.type}`);
      console.error(`[task:${nextTask.id}] 错误:`, err);
      if (err?.stack) console.error(`[task:${nextTask.id}] 堆栈:`, err.stack);
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

    // 0. 计算节点屏蔽（bypass）集（与 buildPrompt 同口径）：
    //    上传素材按顺序落到第一个“未被屏蔽”的帧输入，才能让 LLM 通过
    //    bypass-<nodeId> 正确选择首帧/尾帧（例如只传尾帧时屏蔽首帧节点）。
    const bypassNodeIds = new Set(
      spec.params
        .filter(p => p.bypass === true && (task.params?.[p.id] === true || task.params?.[p.id] === 'true'))
        .map(p => p.nodeId),
    );

    // 1. 上传任务携带的素材（上传也属于队列执行生命周期）
    const uploaded: Record<string, string> = {};
    const imageInputs = spec.inputs.filter(i => i.kind === 'image' && !bypassNodeIds.has(i.nodeId));
    const videoInputs = spec.inputs.filter(i => i.kind === 'video' && !bypassNodeIds.has(i.nodeId));
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

    // 1.5 兜底解析 @imageN/@videoN 会话素材标签：Agent 可能把用户指令中的引用标签
    // 原样传入（而不是真实文件名），把它解析为会话历史中的真实产物并上传到 input 目录。
    const logToTask = (text: string) => {
      const stage = task.stages.find(s => s.status === 'active') ?? task.stages[task.stages.length - 1];
      stage?.logs.push(text);
    };
    const sessionLabels = resolveSessionAssetLabels(this.sessionsFile, task.sessionId);
    const resolveLabel = async (raw: string, kind: 'image' | 'video'): Promise<string> => {
      const trimmed = raw.trim();
      if (!/^@?(image|video)\d+$/i.test(trimmed)) return raw;
      const key = trimmed.replace(/^@/, '').toLowerCase();
      const output = sessionLabels.get(key);
      if (!output?.filename) {
        logToTask(`素材标签 ${trimmed} 未能在会话历史中解析到对应产物，按原值提交`);
        console.warn(`[task:${task.id}] 无法解析会话素材标签 ${trimmed}（会话中无对应产物），按原值提交`);
        return raw;
      }
      // 产物可能是本地草稿（/api/drafts/<id>/file）或 ComfyUI output 目录文件，
      // 而 LoadImage/LoadVideo 只读 ComfyUI input 目录：统一取到字节后上传到 input。
      let data: Buffer;
      const draftMatch = /^\/api\/drafts\/([\w-]+)\/file$/.exec(output.url ?? '');
      if (draftMatch?.[1]) {
        const draftPath = this.drafts?.filePath(draftMatch[1]);
        if (!draftPath) {
          logToTask(`素材标签 ${trimmed} 对应草稿 ${draftMatch[1]} 不存在，按原值提交`);
          console.warn(`[task:${task.id}] 素材标签 ${trimmed} 对应草稿不存在，按原值提交`);
          return raw;
        }
        data = readFileSync(draftPath);
      } else {
        if (await fileExists(output.filename, 'input')) return output.filename;
        const downloaded = await downloadOutput(output.filename, output.subfolder ?? '', output.type ?? 'output');
        data = downloaded.data;
      }
      const ext = output.filename.split('.').pop() || (kind === 'image' ? 'png' : 'mp4');
      try {
        const upRes = await uploadFile(kind, `asset-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`, data);
        const resolved = upRes.subfolder ? `${upRes.subfolder}/${upRes.name}` : upRes.name;
        logToTask(`素材标签 ${trimmed} → 已解析为 ${resolved}`);
        return resolved;
      } catch (error) {
        logToTask(`素材标签 ${trimmed} 对应产物上传到 ComfyUI 失败（${(error as Error).message}），按原值提交`);
        console.warn(`[task:${task.id}] 素材标签 ${trimmed} 对应产物上传失败，按原值提交:`, (error as Error).message);
        return raw;
      }
    };
    const resolvedImages = task.images ? await Promise.all(task.images.map(v => resolveLabel(String(v), 'image'))) : undefined;
    const resolvedVideos = task.videos ? await Promise.all(task.videos.map(v => resolveLabel(String(v), 'video'))) : undefined;

    // 2. 兼容外部传入的本地路径或已上传 ComfyUI 文件名
    for (let i = 0; i < (resolvedImages?.length ?? 0) && i < imageInputs.length; i++) {
      const imagePath = resolvedImages?.[i];
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
    for (let i = 0; i < (resolvedVideos?.length ?? 0) && i < videoInputs.length; i++) {
      const videoPath = resolvedVideos?.[i];
      const inputSpec = videoInputs[i];
      if (!videoPath || !inputSpec || uploaded[inputSpec.id]) continue;
      uploaded[inputSpec.id] = videoPath;
    }
    console.log(`[task:${task.id}] 素材映射:`, uploaded);

    // 3. 读取全局 Settings，并在队列内部构建唯一 prompt 图
    const settings = this.settingsFile ? readSettings(this.settingsFile).imageGen : undefined;
    // combo 与普通 widget 的默认值统一保存在工作流 manifest，由节点视图维护。
    // 生成比例+尺寸 → 目标宽高（视频工作流分辨率上限远小于图像）
    const isVideo = spec.outputs.some(o => o.kind === 'video');
    const maxDimension = isVideo ? 1344 : 2048;
    const resolution = computeResolution(task.ratio, task.size, maxDimension);
    console.log(`[task:${task.id}] 目标分辨率:`, resolution ?? '(沿用工作流默认)');
    // 文本输入由 prompt 注入驱动（primary/启发式写入对应 text 节点），
    // 这些节点即使被勾选为参数也不能用 default 兜底——否则参数循环会用模板默认提示词覆盖刚注入的 prompt。
    const textInputKeys = new Set(spec.inputs.filter(i => i.kind === 'text').map(i => `${i.nodeId}:${i.field}`));
    const defaultParams = Object.fromEntries(
      spec.params
        .filter(param => !textInputKeys.has(`${param.nodeId}:${param.field}`))
        .map(param => [param.id, param.default]),
    );
    const prompt = task.promptGraph ?? await buildPrompt(spec, workflowJson, {
      prompt: task.prompt,
      uploaded,
      params: { ...defaultParams, ...task.params },
      settings,
      resolution,
    });
    console.log(`[task:${task.id}] 构建 prompt 图完成，共 ${Object.keys(prompt).length} 个节点:`);
    for (const [nid, node] of Object.entries(prompt)) {
      const n = node as any;
      console.log(`  - ${nid}: ${n?.class_type}${n?._meta?.title ? ` (${n._meta.title})` : ''}`);
    }

    const effectiveParams: Record<string, unknown> = {};
    for (const node of Object.values(prompt)) {
      const inputs = (node as any)?.inputs;
      if (!inputs || typeof inputs !== 'object') continue;
      for (const field of ['seed', 'noise_seed', 'steps', 'cfg', 'denoise', 'sampler_name', 'scheduler', 'width', 'height', 'batch_size']) {
        const value = (inputs as Record<string, unknown>)[field];
        if (value !== undefined && value !== null && typeof value !== 'object' && effectiveParams[field] === undefined) {
          effectiveParams[field] = value;
        }
      }
    }
    this.updateTask(task.id, current => {
      current.generationParams = {
        ...effectiveParams,
        ...(resolution ? { width: resolution.width, height: resolution.height } : {}),
      };
    });

    if (signal.aborted) return;

    // 4. 连接 WebSocket 监听执行状态（进度 + 完成信号 + 心跳）
    const clientId = `task-client-${randomUUID().slice(0, 8)}`;
    let stopWatch: (() => void) | undefined;
    let activePromptId: string | undefined;
    let wsLive = false; // WebSocket 已连接且未断开
    let wsFinished = false; // 已收到本 prompt 执行完成的信号（executing node=null）
    let lastActivity = Date.now();
    // ws 在线时以心跳判断任务是否存活，不再设固定超时；以下仅作异常兜底：
    const WS_QUIET_TIMEOUT = 5 * 60 * 1000; // 心跳静默阈值（模型加载/VAE 解码等阶段可能长时间无事件）
    const ABSOLUTE_CAP = 3 * 60 * 60 * 1000; // ws 在线时的绝对等待上限，防止任务永久占用队列
    const FALLBACK_TIMEOUT = (isVideo ? 30 : 10) * 60 * 1000; // ws 不可用时的轮询超时

    try {
      stopWatch = watchComfyUI(
        clientId,
        (msg: WsMessage) => {
          lastActivity = Date.now();
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
          if (msg.type === 'executing' && msg.data?.prompt_id === activePromptId) {
            // node 为 null 表示该 prompt 的所有节点已执行完毕
            if (msg.data.node === null || msg.data.node === undefined) {
              wsFinished = true;
            }
          }
        },
        () => {
          wsLive = false; // 连接断开
        },
        () => {
          wsLive = true; // 连接建立
        },
      );
    } catch {
      // 忽略 ws 连接失败（转轮询兜底）
      wsLive = false;
    }

    // 5. 提交给 ComfyUI 执行
    this.updateTask(task.id, t => {
      if (t.stages[1]) t.stages[1].status = 'completed';
      if (t.stages[2]) t.stages[2].status = 'active';
    });

    try {
      console.log(`[task:${task.id}] 提交到 ComfyUI（${COMFYUI_BASE_URL}）...`);
      const subRes = await submitPrompt(prompt, clientId);
      this.currentComfyPromptId = subRes.prompt_id;
      activePromptId = subRes.prompt_id;
      console.log(`[task:${task.id}] 已提交，prompt_id=${subRes.prompt_id}`);

      if (signal.aborted) {
        await cancelPrompt(subRes.prompt_id).catch(() => {});
        return;
      }

      // 6. 等待执行完成：优先依赖 WebSocket（完成信号 + 心跳），history 轮询仅作兜底
      let history: Record<string, any> | undefined;
      const startTime = Date.now();
      let lastHistoryCheck = 0;
      while (true) {
        if (signal.aborted) {
          await cancelPrompt(subRes.prompt_id).catch(() => {});
          return;
        }

        // 检查 history 的时机：ws 已通知完成 / ws 不可用 / 周期性兜底（30s）。
        // 周期检查覆盖「完成信号丢失」或「ws 晚于任务结束才连上」的窗口。
        const shouldCheckHistory = wsFinished || !wsLive || Date.now() - lastHistoryCheck >= 30000;
        if (shouldCheckHistory) {
          lastHistoryCheck = Date.now();
          const histRes = await getHistory(subRes.prompt_id).catch((e: unknown) => {
            console.warn(`[task:${task.id}] 轮询 history 失败:`, (e as Error)?.message ?? e);
            return undefined;
          });
          if (histRes && histRes[subRes.prompt_id]) {
            history = histRes[subRes.prompt_id];
            break;
          }
          if (wsFinished) {
            // 完成信号刚收到，history 可能尚未写入，稍候高频重试
            await new Promise(r => setTimeout(r, 500));
            continue;
          }
        }

        if (!wsLive) {
          // WebSocket 不可用（未连接/已断开/心跳失联）→ 轮询 history 兜底
          if (Date.now() - startTime > FALLBACK_TIMEOUT) {
            throw new Error(
              isVideo
                ? `等待生成超过 ${FALLBACK_TIMEOUT / 60000} 分钟仍未完成（WebSocket 不可用）`
                : '等待生成超时或未获取到输出历史',
            );
          }
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }

        // WebSocket 在线：心跳新鲜即认为任务仍在执行，不设总超时
        if (Date.now() - lastActivity > WS_QUIET_TIMEOUT) {
          console.warn(`[task:${task.id}] WebSocket 心跳静默超过 ${WS_QUIET_TIMEOUT / 60000} 分钟，转回轮询 history`);
          wsLive = false;
          continue;
        }
        if (Date.now() - startTime > ABSOLUTE_CAP) {
          throw new Error(`等待生成超过 ${ABSOLUTE_CAP / 3600000} 小时仍未完成（WebSocket 在线但无完成信号）`);
        }
        await new Promise(r => setTimeout(r, 1000));
      }

      if (!history) {
        throw new Error('等待生成超时或未获取到输出历史');
      }

      // ComfyUI 执行出错（如节点异常）时标记失败，而不是当作完成
      const historyError = extractHistoryError(history);
      if (historyError) throw new Error(historyError);

      const outputs: TaskOutput[] = extractHistoryOutputs(history?.outputs || {}, spec.outputs);
      console.log(`[task:${task.id}] ComfyUI 执行完成，产出:`, outputs.map(o => `${o.kind}:${o.filename}`));

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
    const task = this.tasks.get(taskId);
    const generation = task ? buildGenerationMetadata(task) : undefined;
    if (!outputs?.length || !this.drafts) {
      return (outputs ?? []).map(({ data: _data, mime: _mime, ...output }) => ({
        ...output,
        ...(generation ? { generation } : {}),
      }));
    }
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
        local.push({
          ...output,
          ...(generation ? { generation } : {}),
        });
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
        ...(generation ? { generation } : {}),
        url: `/api/drafts/${draft.id}/file`,
        filename: draft.filename,
        data: undefined,
        mime: undefined,
      });
    }
    return local.map(({ data: _data, mime: _mime, ...output }) => output);
  }
}
