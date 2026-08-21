/**
 * ComfyUI 原生 HTTP + WebSocket 客户端。
 * 直连本地或远程 ComfyUI（地址由环境变量 COMFYUI_BASE_URL 配置，默认 http://127.0.0.1:8188）。
 * 不依赖任何第三方 SDK：/prompt /queue /history /view /upload 走 REST，
 * /ws 用 Node 24 内置 WebSocket 收实时进度事件。
 */

export const COMFYUI_BASE_URL = (process.env.COMFYUI_BASE_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '');

export class ComfyUIError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ComfyUIError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${COMFYUI_BASE_URL}${path}`, init);
  } catch (e) {
    throw new ComfyUIError(`无法连接 ComfyUI（${COMFYUI_BASE_URL}）：${(e as Error).message}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ComfyUIError(`ComfyUI ${path} 返回 ${res.status}: ${text.slice(0, 300)}`, res.status);
  }
  return (await res.json()) as T;
}

export interface HealthStatus {
  connected: boolean;
  baseUrl: string;
  system?: { comfyui_version?: string; python_version?: string };
  error?: string;
}

export async function checkHealth(): Promise<HealthStatus> {
  try {
    const stats = (await request<{ system?: Record<string, unknown> }>('/system_stats')) as unknown as {
      system?: { comfyui_version?: string; python_version?: string };
    };
    return { connected: true, baseUrl: COMFYUI_BASE_URL, system: stats?.system };
  } catch (e) {
    return { connected: false, baseUrl: COMFYUI_BASE_URL, error: (e as Error).message };
  }
}

/** GET /object_info — 全部节点类型的输入/输出定义（introspection 的依据） */
export async function getObjectInfo(): Promise<Record<string, any>> {
  return request('/object_info');
}

export interface QueueInfo {
  queue_running: unknown[];
  queue_pending: unknown[];
}

export async function getQueue(): Promise<QueueInfo> {
  return request('/queue');
}

/** POST /upload/{image|video} — 上传素材到 ComfyUI input 目录 */
export async function uploadFile(
  kind: 'image' | 'video',
  filename: string,
  data: Buffer,
): Promise<{ name: string; subfolder: string; type: string }> {
  const form = new FormData();
  form.append(kind, new Blob([new Uint8Array(data)], { type: 'application/octet-stream' }), filename);
  const res = await fetch(`${COMFYUI_BASE_URL}/upload/${kind}`, { method: 'POST', body: form });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ComfyUIError(`上传${kind} ${filename} 失败: ${res.status} ${text.slice(0, 200)}`, res.status);
  }
  return res.json();
}

export interface SubmitResult {
  prompt_id: string;
  number: number;
  node_errors?: Record<string, { errors?: { message?: string; details?: string }[] }>;
}

/**
 * Comfy 云端 API 节点（Krea2 / MiniMax H3 等）的凭证。
 * - COMFY_API_KEY：Comfy 账号生成的 API Key（comfy.org 账户设置页），提交时随 extra_data 注入，
 *   节点自动转为 X-API-KEY 请求头。
 * - COMFY_AUTH_TOKEN：浏览器登录 ComfyUI 后前端持有的 token，同样随 extra_data 注入。
 */
export const COMFY_API_KEY = process.env.COMFY_API_KEY || '';
export const COMFY_AUTH_TOKEN = process.env.COMFY_AUTH_TOKEN || '';

/** POST /prompt — 提交 API 格式工作流 */
export async function submitPrompt(prompt: Record<string, unknown>, clientId: string): Promise<SubmitResult> {
  const extraData: Record<string, unknown> = { comfy_usage_source: 'director-workbench' };
  if (COMFY_API_KEY) extraData.api_key_comfy_org = COMFY_API_KEY;
  if (COMFY_AUTH_TOKEN) extraData.auth_token_comfy_org = COMFY_AUTH_TOKEN;
  const res = await request<SubmitResult>('/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, client_id: clientId, extra_data: extraData }),
  });
  if (res.node_errors && Object.keys(res.node_errors).length > 0) {
    const first = Object.values(res.node_errors)[0] as { errors?: { message?: string }[] };
    const msg = first?.errors?.[0]?.message ?? JSON.stringify(first);
    throw new ComfyUIError(`工作流校验失败：${msg}`);
  }
  return res;
}

/** 取消：排队中从队列删除，运行中中断 */
export async function cancelPrompt(promptId: string): Promise<void> {
  await request('/queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ delete: [promptId] }),
  }).catch(() => undefined);
  await request('/interrupt', { method: 'POST' }).catch(() => undefined);
}

/** GET /history/{promptId} — 取最终输出（images/gifs/videos/text 分键） */
export async function getHistory(promptId: string): Promise<Record<string, any>> {
  return request(`/history/${promptId}`);
}

/** 探测 ComfyUI 目录里是否存在文件（input/output/temp），读取状态后立即断开 body */
export async function fileExists(filename: string, type = 'input'): Promise<boolean> {
  const p = new URLSearchParams({ filename, type });
  const res = await fetch(`${COMFYUI_BASE_URL}/view?${p.toString()}`);
  if (res.status === 404 || res.status === 400) return false;
  if (!res.ok) return true; // 其他状态（如 500）视为存在，不强制上传
  await res.body?.cancel().catch(() => undefined);
  return true;
}

/** 生成结果文件经服务端代理访问（本地/远程 ComfyUI 都无 CORS 问题） */
export function viewUrl(filename: string, subfolder = '', type = 'output'): string {
  const p = new URLSearchParams({ filename, type });
  if (subfolder) p.set('subfolder', subfolder);
  return `/comfyui/view?${p.toString()}`;
}

export interface WsMessage {
  type: string;
  data: any;
}

/**
 * 连接 ComfyUI WebSocket 收实时事件（status/executing/progress/executed/...）。
 * 返回关闭函数。Node >= 22 内置 WebSocket，无需 ws 依赖。
 */
export function watchComfyUI(
  clientId: string,
  onMessage: (msg: WsMessage) => void,
  onClose?: () => void,
  onOpen?: () => void,
): () => void {
  const wsUrl = `${COMFYUI_BASE_URL.replace(/^http/, 'ws')}/ws?clientId=${clientId}`;
  const ws = new WebSocket(wsUrl);
  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send('ping');
  }, 15000);

  ws.addEventListener('open', () => onOpen?.());
  ws.addEventListener('message', (e: MessageEvent) => {
    const raw = typeof e.data === 'string' ? e.data : null;
    if (!raw || raw === 'ping' || raw === 'pong') return;
    try {
      const m = JSON.parse(raw);
      if (m?.type) onMessage(m);
    } catch {
      /* 忽略非 JSON 消息 */
    }
  });
  ws.addEventListener('close', () => {
    clearInterval(ping);
    onClose?.();
  });
  ws.addEventListener('error', () => clearInterval(ping));

  return () => {
    clearInterval(ping);
    try {
      ws.close();
    } catch {
      /* noop */
    }
  };
}
