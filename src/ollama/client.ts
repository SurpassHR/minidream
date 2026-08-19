import { readFileSync } from 'node:fs';
import { DirectorError } from '../types.js';
import sharp from 'sharp';

// Ollama 本地视觉模型客户端：图像 → 提示词（物体设计器「图像转描述」用）。
// 兼容 Ollama REST API（/api/tags 列表、/api/chat 多模态对话，images 传 base64）。
// 地址/模型来自全局设置（settings.json），客户端只负责按给定地址调用。

interface OllamaTagsResponse {
  models?: Array<{ name: string }>;
}

interface OllamaChatResponse {
  message?: { content?: string };
}

interface OllamaEmbedResponse {
  embeddings?: number[][];
}

const MIN_CONTEXT_TOKENS = 4096;
const MAX_CONTEXT_TOKENS = 32_768;
const OUTPUT_TOKEN_RESERVE = 1024;
const ESTIMATED_IMAGE_TOKEN_BYTES = 768;
// 可选诊断参数：仅在显式设置时传给 Ollama；未设置时交给 Ollama 自动决定卸载策略。
// 注意：num_gpu 表示卸载到 GPU 的层数，不是 GPU 编号或 GPU 数量。
const OLLAMA_NUM_GPU_ENV = 'DIRECTOR_OLLAMA_NUM_GPU';
const MAX_VISION_IMAGE_EDGE = 1536;
const DEFAULT_VISION_TIMEOUT_MS = 300_000;

interface OllamaEmbeddingsLegacyResponse {
  embedding?: number[];
}

function roundContextSize(tokens: number): number {
  const target = Math.max(MIN_CONTEXT_TOKENS, Math.ceil(tokens));
  let size = MIN_CONTEXT_TOKENS;
  while (size < target && size < MAX_CONTEXT_TOKENS) size *= 2;
  return Math.min(size, MAX_CONTEXT_TOKENS);
}

// Ollama 没有在 /api/chat 前提供 tokenizer；图片 token 又取决于视觉模型的切图策略。
// 因此首请求使用文件大小做保守估算，服务端若返回精确 n_prompt_tokens，再按该值重试一次。
export function estimateImageContext(imageBytes: number, instruction: string): number {
  const instructionTokens = Math.ceil(Buffer.byteLength(instruction, 'utf8') / 3);
  const imageTokens = Math.max(512, Math.ceil(imageBytes / ESTIMATED_IMAGE_TOKEN_BYTES));
  return roundContextSize(instructionTokens + imageTokens + OUTPUT_TOKEN_RESERVE);
}

function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const record = err as { name?: unknown; message?: unknown };
  const name = typeof record.name === 'string' ? record.name.toLowerCase() : '';
  const message = typeof record.message === 'string' ? record.message.toLowerCase() : '';
  return name === 'timeouterror' || name === 'aborterror' || message.includes('timeout') || message.includes('timed out');
}

function requestErrorDetail(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = 'cause' in err ? err.cause : undefined;
  const causeText = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  return causeText && causeText !== err.message ? `${err.message}: ${causeText}` : err.message;
}

function configuredNumGpu(): number | undefined {
  const raw = process.env[OLLAMA_NUM_GPU_ENV]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

async function resizeVisionImage(image: Buffer): Promise<Buffer> {
  try {
    const transformer = sharp(image);
    const metadata = await transformer.metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (!width || !height || Math.max(width, height) <= MAX_VISION_IMAGE_EDGE) return image;
    return transformer
      .resize({
        width: MAX_VISION_IMAGE_EDGE,
        height: MAX_VISION_IMAGE_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .toBuffer();
  } catch {
    // 无法解析时保留原始字节，让 Ollama 返回原有的图像格式错误。
    return image;
  }
}

function contextTokensFromError(body: string): number | null {
  let value: unknown = body;
  for (let i = 0; i < 3; i += 1) {
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value) as unknown;
      } catch {
        return null;
      }
    }
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (record.type === 'exceed_context_size_error' && typeof record.n_prompt_tokens === 'number') {
      return record.n_prompt_tokens;
    }
    if (!('error' in record)) return null;
    value = record.error;
  }
  return null;
}

export class OllamaClient {
  private readonly baseUrl: string;
  private readonly defaultTimeoutMs: number;

  constructor(baseUrl: string, opts: { timeoutMs?: number } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_VISION_TIMEOUT_MS; // 本地视觉模型含图像编码，默认给 5 分钟
  }

  // 列出已安装模型（设置面板视觉模型下拉数据源）
  async listModels(): Promise<string[]> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    } catch {
      throw new DirectorError('INVALID_PATCH', `无法连接 Ollama: ${this.baseUrl}`);
    }
    if (!res.ok) {
      throw new DirectorError('INVALID_PATCH', `Ollama 模型列表获取失败(${res.status})`);
    }
    const data = (await res.json()) as OllamaTagsResponse;
    return (data.models ?? []).map((m) => m.name).sort();
  }

  // 文本 → 向量：POST /api/embed（批量）；旧版 Ollama 无此端点时回退逐条 /api/embeddings
  async embed(model: string, texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: texts }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new DirectorError('INVALID_PATCH', `无法连接 Ollama: ${this.baseUrl}`);
    }
    if (res.status === 404 || res.status === 405) {
      // 旧版：逐条 /api/embeddings
      const out: number[][] = [];
      for (const t of texts) {
        const r = await fetch(`${this.baseUrl}/api/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, prompt: t }),
          signal: AbortSignal.timeout(120_000),
        });
        if (!r.ok) {
          const text = await r.text();
          throw new DirectorError('INVALID_PATCH', `Ollama embedding 调用失败(${r.status}): ${text.slice(0, 500)}`);
        }
        const data = (await r.json()) as OllamaEmbeddingsLegacyResponse;
        if (!data.embedding || data.embedding.length === 0) {
          throw new DirectorError('INVALID_PATCH', `Ollama embedding 返回空向量（模型 ${model} 是否支持 embedding？）`);
        }
        out.push(data.embedding);
      }
      return out;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new DirectorError('INVALID_PATCH', `Ollama embedding 调用失败(${res.status}): ${text.slice(0, 500)}`);
    }
    const data = (await res.json()) as OllamaEmbedResponse;
    const embeddings = data.embeddings ?? [];
    if (embeddings.length !== texts.length || embeddings.some((e) => !e || e.length === 0)) {
      throw new DirectorError('INVALID_PATCH', `Ollama embedding 返回数量不匹配（模型 ${model} 是否支持 embedding？）`);
    }
    return embeddings;
  }

  // 显式卸载当前模型 runner。keep_alive=0 只保证当前请求结束后卸载；
  // 请求前再执行一次，可清理来自旧请求/其他客户端残留的视觉模型显存。
  private async unloadModel(model: string): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: false, keep_alive: 0 }),
        signal: AbortSignal.timeout(10_000),
      });
      // 消费响应体，避免保持连接；卸载失败不遮蔽后续真正的视觉请求错误。
      await res.text();
    } catch {
      // 某些旧版/代理可能不支持该探针；后续 /api/chat 仍会给出实际错误。
    }
  }

  // 图像 → 提示词：读取本地图片 → base64 → /api/chat（stream:false）→ 返回模型描述文本
  async imageToPrompt(
    model: string,
    imagePath: string,
    instruction: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<string> {
    await this.unloadModel(model);
    const sourceImage = readFileSync(imagePath);
    const image = await resizeVisionImage(sourceImage);
    const b64 = image.toString('base64');
    let numCtx = estimateImageContext(image.length, instruction);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const numGpu = configuredNumGpu();
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: instruction, images: [b64] }],
            stream: false,
            // 视觉请求完成后立即卸载模型，避免下一张大图继续复用已占用的显存。
            // 代价是后续请求需要重新加载模型，但可避免连续 captioning 的显存累积/碎片问题。
            keep_alive: 0,
            options: {
              num_ctx: numCtx,
              ...(numGpu === undefined ? {} : { num_gpu: numGpu }),
            },
          }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? this.defaultTimeoutMs),
        });
      } catch (err) {
        if (isTimeoutError(err)) {
          throw new DirectorError('INVALID_PATCH', `视觉模型推理超时（已等待 ${Math.round((opts.timeoutMs ?? this.defaultTimeoutMs) / 1000)} 秒）：${this.baseUrl}`);
        }
        throw new DirectorError('INVALID_PATCH', `无法连接 Ollama: ${this.baseUrl}（${requestErrorDetail(err)}）`);
      }
      if (res.ok) {
        const data = (await res.json()) as OllamaChatResponse;
        const content = data.message?.content?.trim() ?? '';
        if (!content) {
          throw new DirectorError('INVALID_PATCH', `Ollama 返回空结果（模型 ${model} 是否支持图像输入？）`);
        }
        return content;
      }

      const text = await res.text();
      const promptTokens = attempt === 0 ? contextTokensFromError(text) : null;
      if (promptTokens !== null) {
        numCtx = roundContextSize(promptTokens + OUTPUT_TOKEN_RESERVE);
        continue;
      }
      throw new DirectorError('INVALID_PATCH', `Ollama 调用失败(${res.status}): ${text.slice(0, 500)}`);
    }
    throw new DirectorError('INVALID_PATCH', `Ollama 调用失败：上下文空间不足（模型 ${model}）`);
  }
}
