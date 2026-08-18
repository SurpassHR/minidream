import { readFileSync } from 'node:fs';
import { DirectorError } from '../types.js';

// Ollama 本地视觉模型客户端：图像 → 提示词（物体设计器「🪄 图像转描述」用）。
// 兼容 Ollama REST API（/api/tags 列表、/api/chat 多模态对话，images 传 base64）。
// 地址/模型来自全局设置（settings.json），客户端只负责按给定地址调用。

interface OllamaTagsResponse {
  models?: Array<{ name: string }>;
}

interface OllamaChatResponse {
  message?: { content?: string };
}

export class OllamaClient {
  private readonly baseUrl: string;
  private readonly defaultTimeoutMs: number;

  constructor(baseUrl: string, opts: { timeoutMs?: number } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.defaultTimeoutMs = opts.timeoutMs ?? 120_000; // 本地视觉模型推理通常较慢，给 2 分钟
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

  // 图像 → 提示词：读取本地图片 → base64 → /api/chat（stream:false）→ 返回模型描述文本
  async imageToPrompt(
    model: string,
    imagePath: string,
    instruction: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<string> {
    const b64 = readFileSync(imagePath).toString('base64');
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: instruction, images: [b64] }],
          stream: false,
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? this.defaultTimeoutMs),
      });
    } catch {
      throw new DirectorError('INVALID_PATCH', `无法连接 Ollama: ${this.baseUrl}`);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new DirectorError('INVALID_PATCH', `Ollama 调用失败(${res.status}): ${text.slice(0, 500)}`);
    }
    const data = (await res.json()) as OllamaChatResponse;
    const content = data.message?.content?.trim() ?? '';
    if (!content) {
      throw new DirectorError('INVALID_PATCH', `Ollama 返回空结果（模型 ${model} 是否支持图像输入？）`);
    }
    return content;
  }
}
