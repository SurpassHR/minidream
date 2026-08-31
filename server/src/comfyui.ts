/**
 * ComfyUI 原生 HTTP + WebSocket 客户端。
 * 直连本地或远程 ComfyUI（地址由环境变量 COMFYUI_BASE_URL 配置，默认 http://127.0.0.1:8188）。
 * 不依赖任何第三方 SDK：/prompt /queue /history /view /upload 走 REST，
 * /ws 用 Node 24 内置 WebSocket 收实时进度事件。
 */

export const DEFAULT_COMFYUI_BASE_URL = 'http://127.0.0.1:8188';

/** 当前 ComfyUI 地址（运行时可修改：见 setComfyBaseUrl） */
export let COMFYUI_BASE_URL = (process.env.COMFYUI_BASE_URL || DEFAULT_COMFYUI_BASE_URL).replace(/\/+$/, '');

/** 更新 ComfyUI 地址（去空白、去尾部斜杠、校验 http/https），返回规范化后的地址 */
export function setComfyBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!trimmed) throw new ComfyUIError('ComfyUI 地址不能为空');
  if (!/^https?:\/\//i.test(trimmed)) throw new ComfyUIError('ComfyUI 地址需以 http:// 或 https:// 开头');
  COMFYUI_BASE_URL = trimmed;
  return COMFYUI_BASE_URL;
}

export class ComfyUIError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    /** 非 2xx 响应体（JSON 时解析后的对象），供上层生成可读错误 */
    public readonly body?: unknown,
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
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = undefined;
    }
    throw new ComfyUIError(`ComfyUI ${path} 返回 ${res.status}: ${text.slice(0, 300)}`, res.status, body);
  }
  const text = await res.text();
  return text.trim() ? (JSON.parse(text) as T) : (undefined as T);
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

/** POST /prompt — 提交 API 格式工作流（仅本地 ComfyUI，不注入任何云端凭证） */
export async function submitPrompt(prompt: Record<string, unknown>, clientId: string): Promise<SubmitResult> {
  let res: SubmitResult;
  try {
    res = await request<SubmitResult>('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        client_id: clientId,
        extra_data: { comfy_usage_source: 'minidream' },
      }),
    });
  } catch (e) {
    // ComfyUI 400 常见错误转成可读中文（如自定义节点未安装）
    if (e instanceof ComfyUIError && e.status === 400) {
      console.error(`[comfyui] POST /prompt 被拒绝 (400)，完整响应:`);
      console.error(JSON.stringify(e.body, null, 2));
    }
    if (e instanceof ComfyUIError && e.status === 400 && e.body && typeof e.body === 'object') {
      const err = (e.body as any)?.error;
      if (err?.type === 'missing_node_type') {
        const cls = String(err.extra_info?.class_type ?? err.node_title ?? '');
        const title = err.extra_info?.node_title ?? err.node_title;
        const clsPart = cls ? `「${cls}」` : '';
        const titlePart = title && title !== cls ? `（${title}）` : '';
        throw new ComfyUIError(
          `工作流使用了未安装的节点${clsPart}${titlePart}：请先在 ComfyUI 中安装对应的自定义节点` +
            '（ComfyUI Manager → Install Custom Nodes 搜索安装），安装后重启 ComfyUI 再重试。',
        );
      }
      if (typeof err?.message === 'string' && err?.type) {
        throw new ComfyUIError(`ComfyUI 拒绝该工作流：${err.message}`);
      }
    }
    throw e;
  }
  if (res.node_errors && Object.keys(res.node_errors).length > 0) {
    // node_errors: { [nodeId]: { errors: [{ type, message, details }] } }
    const [nodeId, nodeError] = Object.entries(res.node_errors)[0] as [
      string,
      { errors?: { message?: string; details?: string }[] },
    ];
    const first = nodeError?.errors?.[0];
    const msg = first?.message ?? JSON.stringify(nodeError);
    const details = typeof first?.details === 'string' && first.details.trim() ? `（${first.details.trim().slice(0, 300)}）` : '';
    const node = nodeId ? `（节点 ${nodeId}）` : '';
    throw new ComfyUIError(`工作流校验失败：${msg}${details}${node}`);
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

/** 下载 ComfyUI 临时产物，供项目本地草稿存储使用。 */
export async function downloadOutput(
  filename: string,
  subfolder = '',
  type = 'output',
): Promise<{ data: Buffer; mime?: string }> {
  const p = new URLSearchParams({ filename, type });
  if (subfolder) p.set('subfolder', subfolder);
  let res: Response;
  try {
    res = await fetch(`${COMFYUI_BASE_URL}/view?${p.toString()}`);
  } catch (e) {
    throw new ComfyUIError(`无法下载 ComfyUI 产物（${filename}）：${(e as Error).message}`);
  }
  if (!res.ok) {
    throw new ComfyUIError(`下载 ComfyUI 产物 ${filename} 失败：${res.status}` , res.status);
  }
  return {
    data: Buffer.from(await res.arrayBuffer()),
    mime: res.headers.get('content-type') ?? undefined,
  };
}

/** 尽力删除 ComfyUI 临时产物；调用方决定是否忽略失败。 */
export async function deleteOutput(filename: string, subfolder = '', type = 'output'): Promise<void> {
  await request('/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, subfolder, type }),
  });
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
  data?: any;
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
    if (!raw) return;
    // 服务端对心跳 ping 的回应，作为连接存活的信号透传给调用方
    if (raw === 'ping' || raw === 'pong') {
      onMessage({ type: 'heartbeat' });
      return;
    }
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
