import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DirectorError, type ComfyMedia, type ComfyOutput } from '../types.js';

interface HistoryEntry {
  outputs?: Record<string, { images?: ComfyMedia[]; gifs?: ComfyMedia[]; videos?: ComfyMedia[] }>;
}

export class ComfyUIClient {
    baseUrl: string;
  private readonly defaultTimeoutMs: number;

  constructor(baseUrl: string, opts: { timeoutMs?: number } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.defaultTimeoutMs = opts.timeoutMs ?? 30 * 60 * 1000; // 30 分钟
  }

  // 运行时切换地址（工作台 UI 自定义 ComfyUI 端口/地址用）
  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/+$/, '');
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/system_stats`, { signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async submit(workflow: Record<string, unknown>, clientId: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new DirectorError('INVALID_PATCH', `ComfyUI 提交失败(${res.status}): ${text.slice(0, 500)}`);
    }
    const data = (await res.json()) as { prompt_id: string };
    return data.prompt_id;
  }

  async waitForDone(
    promptId: string,
    opts: { intervalMs?: number; timeoutMs?: number } = {},
  ): Promise<ComfyOutput> {
    const intervalMs = opts.intervalMs ?? 1500;
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await fetch(`${this.baseUrl}/history/${promptId}`);
      const data = (await res.json()) as Record<string, HistoryEntry>;
      const entry = data[promptId];
      if (entry) {
        const media: ComfyMedia[] = [];
        for (const out of Object.values(entry.outputs ?? {})) {
          for (const list of [out?.images ?? [], out?.gifs ?? [], out?.videos ?? []]) {
            for (const m of list) media.push(m);
          }
        }
        return { promptId, media };
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new DirectorError('INVALID_PATCH', `生成超时: ${promptId}`);
  }

  async download(media: ComfyMedia, destPath: string): Promise<string> {
    const url =
      `${this.baseUrl}/view?filename=${encodeURIComponent(media.filename)}` +
      `&subfolder=${encodeURIComponent(media.subfolder)}&type=${encodeURIComponent(media.type)}`;
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new DirectorError('INVALID_PATCH', `下载失败(${res.status}): ${media.filename}`);
    }
    mkdirSync(dirname(destPath), { recursive: true });
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(destPath));
    return destPath;
  }
}
