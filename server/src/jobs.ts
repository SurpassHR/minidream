/**
 * 生成任务管理器：每个 job 对应一次 ComfyUI 执行。
 * - 提交后立即返回 jobId，WebSocket 实时事件缓冲进 job.events
 * - 前端通过 SSE（GET /api/generate/:jobId/events）订阅，迟到订阅可回放已缓冲事件
 * - 结果提取：优先累积 WS executed 事件，结束时以 /history 兜底
 */
import { randomUUID } from 'node:crypto';
import {
  cancelPrompt,
  getHistory,
  viewUrl,
  watchComfyUI,
  type WsMessage,
} from './comfyui.js';
import type { WorkflowSpec } from './workflow.js';

export type JobEvent =
  | { type: 'log'; text: string }
  | { type: 'submitted'; promptId: string }
  | { type: 'executing'; nodeId: string; label: string }
  | { type: 'progress'; completed: number; total: number; percent: number }
  | { type: 'queue'; running: number; pending: number }
  | { type: 'done'; outputs: GenerationOutput[] }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };

export interface GenerationOutput {
  kind: 'image' | 'video' | 'text';
  label?: string;
  url?: string; // /comfyui/view?...
  filename?: string;
  subfolder?: string;
  type?: string;
  text?: string;
}

export interface GenerationJob {
  id: string;
  promptId: string | null;
  workflowId: string;
  clientId: string;
  events: JobEvent[];
  outputs: GenerationOutput[];
  status: 'running' | 'done' | 'cancelled' | 'error';
  error?: string;
  closeWs: (() => void) | null;
  sseClients: Set<(evt: JobEvent) => void>;
  createdAt: number;
  /** finalize 重试次数（history 写入可能有延迟） */
  finalizeAttempts: number;
}

const jobs = new Map<string, GenerationJob>();

export function getJob(id: string): GenerationJob | undefined {
  return jobs.get(id);
}

export function jobSnapshot(job: GenerationJob) {
  return {
    id: job.id,
    workflowId: job.workflowId,
    promptId: job.promptId,
    status: job.status,
    outputs: job.outputs,
    error: job.error,
  };
}

function pushEvent(job: GenerationJob, evt: JobEvent) {
  job.events.push(evt);
  for (const send of job.sseClients) send(evt);
}

/** 把 WS 原始消息翻译成 JobEvent */
function translateWs(job: GenerationJob, msg: WsMessage, spec: WorkflowSpec) {
  const { type, data } = msg;
  switch (type) {
    case 'status': {
      const remaining = data?.status?.exec_info?.queue_remaining ?? 0;
      if (typeof remaining === 'number') pushEvent(job, { type: 'queue', running: 0, pending: remaining });
      break;
    }
    case 'executing': {
      if (data?.node == null) {
        // 全部执行完毕（node=null）
        finalize(job, spec);
      } else {
        const nodeId = String(data.node);
        const out = spec.outputs.find(o => o.nodeId === nodeId);
        const inp = spec.inputs.find(i => i.nodeId === nodeId);
        const label = out?.label ?? inp?.label ?? nodeId;
        pushEvent(job, { type: 'executing', nodeId, label });
      }
      break;
    }
    case 'progress': {
      const value = Number(data?.value ?? 0);
      const max = Number(data?.max ?? 1);
      pushEvent(job, {
        type: 'progress',
        completed: value,
        total: max,
        percent: max > 0 ? Math.round((value / max) * 100) : 0,
      });
      break;
    }
    case 'executed': {
      if (data?.prompt_id && job.promptId && data.prompt_id !== job.promptId) break;
      collectOutputs(job, data?.output);
      break;
    }
    case 'execution_interrupted': {
      if (job.status === 'running') {
        job.status = 'cancelled';
        pushEvent(job, { type: 'cancelled' });
      }
      break;
    }
    case 'execution_error': {
      let message = data?.exception_message || data?.error || '执行出错';
      // 云端 API 节点（Krea2/MiniMax 等）鉴权失败：提示配置凭证
      if (/Unauthorized|login first|No Authorization header/i.test(message)) {
        message =
          '云端生成节点需要 Comfy 账号凭证：请设置环境变量 COMFY_API_KEY（Comfy 账户设置页生成）或 COMFY_AUTH_TOKEN 后重启服务。';
      }
      job.status = 'error';
      job.error = message;
      pushEvent(job, { type: 'error', message });
      break;
    }
    default:
      break;
  }
}

/** 收集单个节点的输出（images/gifs/videos/text 分键） */
function collectOutputs(job: GenerationJob, output: any) {
  if (!output || typeof output !== 'object') return;
  for (const [key, files] of Object.entries(output) as [string, unknown][]) {
    if (key === 'images' || key === 'gifs' || key === 'videos') {
      if (!Array.isArray(files)) continue;
      const kind: GenerationOutput['kind'] = key === 'images' ? 'image' : 'video';
      for (const f of files as { filename?: string; subfolder?: string; type?: string }[]) {
        if (!f?.filename) continue;
        job.outputs.push({
          kind,
          filename: f.filename,
          subfolder: f.subfolder ?? '',
          type: f.type ?? 'output',
          url: viewUrl(f.filename, f.subfolder ?? '', f.type ?? 'output'),
        });
      }
    } else if (key === 'text' && typeof files === 'string') {
      job.outputs.push({ kind: 'text', text: files });
    }
  }
}

/** 执行完成：以 /history 兜底补齐输出并去重。仅当 history 标记 completed 才收尾 */
async function finalize(job: GenerationJob, spec: WorkflowSpec) {
  if (job.status !== 'running' || !job.promptId) return;
  let entry: any;
  try {
    const history = await getHistory(job.promptId);
    entry = history?.[job.promptId];
  } catch (e) {
    job.status = 'error';
    job.error = (e as Error).message;
    pushEvent(job, { type: 'error', message: job.error });
    return;
  }
  // 任务仍在排队/执行中（history 无记录或未 completed）→ 延迟重试（最多 15 次）
  if (!entry || entry.status?.completed !== true) {
    if (job.finalizeAttempts < 15) {
      job.finalizeAttempts += 1;
      setTimeout(() => void finalize(job, spec), 1500);
    }
    return;
  }

  if (entry.status?.status_str === 'error') {
    job.status = 'error';
    job.error = '执行出错（详见 ComfyUI 日志）';
    pushEvent(job, { type: 'error', message: job.error });
    return;
  }

  if (entry.outputs) {
    for (const [nodeId, out] of Object.entries(entry.outputs) as [string, any][]) {        const specOut = spec.outputs.find(o => o.nodeId === nodeId);
        const before = job.outputs.length;
        collectOutputs(job, out);
        for (let i = before; i < job.outputs.length; i++) {
          const o = job.outputs[i];
          if (o && !o.label && specOut) o.label = specOut.label;
        }
    }
  }
  dedupeOutputs(job);
  job.status = 'done';
  pushEvent(job, { type: 'done', outputs: job.outputs });
}

function dedupeOutputs(job: GenerationJob) {
  const seen = new Set<string>();
  job.outputs = job.outputs.filter(o => {
    const key = o.url ?? o.text ?? `${o.kind}:${o.filename}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface StartJobParams {
  workflowId: string;
  spec: WorkflowSpec;
  promptId: string;
  clientId: string;
}

/** 启动一个生成任务（提交已在调用方完成，这里负责 WS 监听与结果收集） */
export function startJob(params: StartJobParams): GenerationJob {
  const job: GenerationJob = {
    id: randomUUID(),
    promptId: params.promptId,
    workflowId: params.workflowId,
    clientId: params.clientId,
    events: [],
    outputs: [],
    status: 'running',
    closeWs: null,
    sseClients: new Set(),
    createdAt: Date.now(),
    finalizeAttempts: 0,
  };
  jobs.set(job.id, job);

  // 兜底清理：任务结束后 10 分钟移除
  setTimeout(() => {
    if (job.status !== 'running') jobs.delete(job.id);
  }, 10 * 60_000);

  // 监听 WS 实时事件；若 WS 连上时任务已结束（快速任务），用 history 兜底
  job.closeWs = watchComfyUI(
    params.clientId,
    msg => translateWs(job, msg, params.spec),
    () => {
      // WS 断开兜底：若还处于 running，轮询 history 判定完成
      if (job.status === 'running') {
        setTimeout(() => void finalize(job, params.spec), 3000);
      }
    },
    () => {
      // WS 刚连上：快速任务可能已执行完，立即查一次 history
      setTimeout(() => void finalize(job, params.spec), 1200);
    },
  );

  return job;
}

export async function cancelJob(id: string): Promise<boolean> {
  const job = jobs.get(id);
  if (!job || !job.promptId) return false;
  await cancelPrompt(job.promptId);
  if (job.status === 'running') {
    job.status = 'cancelled';
    pushEvent(job, { type: 'cancelled' });
  }
  return true;
}

export function subscribeJob(id: string, send: (evt: JobEvent) => void): (() => void) {
  const job = jobs.get(id);
  if (!job) return () => undefined;
  job.sseClients.add(send);
  // 回放已缓冲事件（迟到订阅也能拿到全过程）
  for (const evt of job.events) send(evt);
  return () => job.sseClients.delete(send);
}
