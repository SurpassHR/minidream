import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { writeSeedExtension } from './seed.js';

export interface AgentStreamEvent {
  type: 'status' | 'thinking' | 'text' | 'tool_call' | 'tool_result' | 'error' | 'end';
  status?: string;
  delta?: string;
  tool?: {
    id?: string;
    name: string;
    args: Record<string, unknown>;
  };
  result?: {
    id?: string;
    name?: string;
    content: unknown;
  };
  error?: string;
}

export interface AgentModel {
  id: string;
  provider: string;
  thinking: boolean;
  images: boolean;
}

/** 解析 `pi --list-models` 的表格输出。 */
export function parsePiModelList(stdout: string): AgentModel[] {
  const models: AgentModel[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const cells = line.trim().split(/\s+/);
    if (cells.length < 6 || cells[0] === 'provider') continue;
    const [provider, model, , , thinking, images] = cells;
    if (!provider || !model) continue;
    models.push({
      id: `${provider}/${model}`,
      provider,
      thinking: thinking === 'yes',
      images: images === 'yes',
    });
  }
  return models;
}

export async function listAgentModels(): Promise<AgentModel[]> {
  return new Promise(resolve => {
    let child: ChildProcess;
    try {
      child = spawn('pi', ['--list-models'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve([]);
      return;
    }
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.once('close', () => resolve(parsePiModelList(stdout)));
    child.once('error', () => resolve([]));
  });
}

export type AgentThinking = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** 会话命名提示词：要求输出简洁中文标题，直接输出标题本身 */
const TITLE_SYSTEM_PROMPT = [
  '你是对话命名助手。根据用户的第一条消息，为这个对话生成一个简洁的中文标题。',
  '要求：',
  '- 不超过 12 个字',
  '- 概括消息的核心主题或意图，不要照抄原句',
  '- 直接输出标题本身，不要引号、不要解释、不要换行',
].join('\n');

export interface TitleGenOptions {
  model?: string;
  thinking?: AgentThinking;
  /** 超时毫秒数；默认 20s */
  timeoutMs?: number;
}

/** 模型可能输出的结束符 token */
const EOS_TOKEN_RE = /^(<\/s>|<\|endoftext\|>|<\|eot_id\|>)+/gi;

/**
 * 从 pi --print 输出中提取标题（取最后一行非状态/错误文本，并清理引号、标点与结束符 token）。
 * 输出疑似散文/句子（过长或含问叹号）时返回空串，交由调用方回退到截断标题。
 */
export function sanitizeTitle(raw: string): string {
  const lines = raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const candidates = lines.filter(line => !/API\s+\d{3}|^\[|^error|重试|retry|unavailable|unexpected/i.test(line));
  const picked = candidates.length ? (candidates[candidates.length - 1] ?? '') : '';
  // 原始行带问叹号（可能是对话/散文）→ 直接判定无效，避免被末尾清理规则掩盖
  if (/[？?！!]/.test(picked)) return '';
  const cleaned = picked
    .replace(EOS_TOKEN_RE, '')
    .replace(/^["'「『【（(，,]+/, '')
    .replace(/["'」』】）).。，,]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  // 标题过长 → 判定为散文而非标题
  if (cleaned.length > 24) return '';
  return Array.from(cleaned).slice(0, 20).join('');
}

/**
 * 为对话生成标题：轻量、无工具的 Pi 调用（--print --no-tools --no-session）。
 * 失败、超时或输出不像标题时自动重试一次；仍失败返回 null，由调用方回退到截断标题，不打断主流程。
 */
export async function generateConversationTitle(
  userMessage: string,
  opts: TitleGenOptions = {},
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const args: string[] = ['--print', '--no-tools', '--no-session', '--thinking', opts.thinking ?? 'off'];
  if (opts.model?.trim()) args.push('--model', opts.model.trim());
  args.push('--append-system-prompt', TITLE_SYSTEM_PROMPT);

  const runOnce = (): Promise<string | null> =>
    new Promise(resolve => {
      let child: ChildProcess;
      try {
        child = spawn('pi', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch {
        resolve(null);
        return;
      }
      let stdout = '';
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const finish = (title: string | null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(title);
      };
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
        }, 2000).unref();
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.once('close', () => {
        const title = sanitizeTitle(stdout);
        finish(title || null);
      });
      child.once('error', () => finish(null));
      child.stdin?.write(userMessage.slice(0, 400));
      child.stdin?.end();
    });

  for (let attempt = 0; attempt < 2; attempt++) {
    const title = await runOnce();
    if (title) return title;
  }
  return null;
}

export interface RunAgentOptions {
  model?: string;
  sessionId?: string;
  mcpServerUrl?: string;
  systemPrompt?: string;
  /** 虚构对话历史：构建为真实交替 user/assistant 消息，经动态生成的 Pi 扩展在每次 LLM 调用前注入请求头部 */
  seedHistory?: FabricatedTurn[];
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  idleTimeoutMs?: number;
  /** Pi 推理强度；默认 minimal，设置为 off 可优先响应速度。 */
  thinking?: AgentThinking;
  onEvent?: (event: AgentStreamEvent) => void;
}

export interface FabricatedTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * 将用户消息和多模态素材/上下文组装为发送给 Pi Agent 的输入文本。
 * 虚构对话历史不再拼接进文本——改由 seed.ts 构建真实交替 user/assistant
 * 消息、经动态生成的 Pi 扩展注入请求头部（参考 custom-first-control-prompt
 * 的请求路径注入机制，零会话日志写入、保持前缀缓存复用）。
 */
export function buildAgentInput(
  optionsOrMessage:
    | string
    | {
        message: string;
        sessionId?: string;
        images?: Array<string | { name?: string; dataUrl?: string }>;
        videos?: Array<string | { name?: string; dataUrl?: string }>;
        context?: string;
      },
  options: {
    sessionId?: string;
    images?: Array<string | { name?: string; dataUrl?: string }>;
    videos?: Array<string | { name?: string; dataUrl?: string }>;
    context?: string;
  } = {}
): string {
  const message =
    typeof optionsOrMessage === 'string'
      ? optionsOrMessage
      : optionsOrMessage.message;
  const opts =
    typeof optionsOrMessage === 'string' ? options : optionsOrMessage;

  const parts: string[] = [];
  if (opts.context?.trim()) {
    parts.push(`【上下文信息】\n${opts.context.trim()}`);
  }
  if (opts.images && opts.images.length > 0) {
    parts.push(
      `【参考图片】\n${opts.images
        .map((img, i) =>
          `[Image ${i + 1}]: ${typeof img === 'string' ? img : img.name || 'image' + (i + 1)}`
        )
        .join('\n')}`
    );
  }
  if (opts.videos && opts.videos.length > 0) {
    parts.push(
      `【参考视频】\n${opts.videos
        .map((vid, i) =>
          `[Video ${i + 1}]: ${typeof vid === 'string' ? vid : vid.name || 'video' + (i + 1)}`
        )
        .join('\n')}`
    );
  }
  parts.push(`【用户指令】\n${message}`);
  return parts.join('\n\n');
}

/**
 * 启动 Pi CLI 子进程并以流式方式处理 JSON 事件流
 */
export async function runAgentStream(
  prompt: string,
  onEventOrOptions: ((event: AgentStreamEvent) => void) | RunAgentOptions,
  legacyOptions?: RunAgentOptions
): Promise<{ exitCode: number | null; error?: string }> {
  let onEvent: (event: AgentStreamEvent) => void;
  let options: RunAgentOptions;

  if (typeof onEventOrOptions === 'function') {
    onEvent = onEventOrOptions;
    options = legacyOptions ?? {};
  } else {
    options = onEventOrOptions ?? {};
    onEvent = options.onEvent ?? (() => {});
  }

  const idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
  // 严格禁用宿主开发工具（bash/read/edit/write/fffind/context_tree_query等），仅允许 mcp 工具与 director 专属 skill
  const args: string[] = [
    '--mode', 'json',
    '--thinking', options.thinking ?? 'minimal',
  ];

  if (options.model?.trim()) {
    args.push('--model', options.model.trim());
  }

  args.push(

    '--tools', 'mcp',
    '--exclude-tools', 'bash,read,edit,write,fffind,ffgrep,grep,find,ls,context_tree_query,subagent,subagent_wait,subagent_supervisor,preview_export,studio_repl_send,studio_repl_status,studio_export_pdf,studio_export_html,ask_user_question,source_check,get_search_content,fetch_content',
  );

  if (options.sessionId) {
    args.push('--session-id', options.sessionId);
  } else {
    args.push('--no-session');
  }

  if (options.systemPrompt?.trim()) {
    args.push('--append-system-prompt', options.systemPrompt.trim());
  }

  let mcpConfigFile: string | null = null;
  if (options.mcpServerUrl) {
    // 写入临时的独立 MCP 配置文件，并使用 --mcp-config 显式指定，彻底隔离用户全局 ~/.pi/mcp.json（如 openreel/codegraph 等）
    const tmpDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/.mcp-tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    mcpConfigFile = path.resolve(tmpDir, `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
    fs.writeFileSync(mcpConfigFile, JSON.stringify({
      mcpServers: {
        director: {
          url: options.mcpServerUrl,
        },
      },
    }, null, 2), 'utf8');
    args.push('--mcp-config', mcpConfigFile);
  }

  // 虚构对话历史：构建为真实交替 user/assistant 消息，经动态生成的 Pi 扩展
  // 在每次 LLM 调用前注入请求头部（参考 custom-first-control-prompt 的请求路径注入：
  // 零会话日志写入、字节级一致保持前缀缓存复用）。扩展文件随进程结束一并清理。
  let seedExtensionFile: string | null = null;
  if (options.seedHistory && options.seedHistory.length > 0) {
    seedExtensionFile = writeSeedExtension(options.seedHistory);
    if (seedExtensionFile) {
      args.push('--extension', seedExtensionFile);
    }
  }

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    ...(options.env ?? {}),
  };
  const cleanupMcpConfig = () => {
    if (mcpConfigFile) {
      try {
        fs.rmSync(mcpConfigFile, { force: true });
      } catch {
        // 清理失败不应覆盖 Agent 的原始结果
      }
      mcpConfigFile = null;
    }
    if (seedExtensionFile) {
      try {
        fs.rmSync(seedExtensionFile, { force: true });
      } catch {
        // 清理失败不应覆盖 Agent 的原始结果
      }
      seedExtensionFile = null;
    }
  };

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn('pi', args, {
        cwd: options.cwd ?? process.cwd(),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const errorMsg = (err as Error).message;
      cleanupMcpConfig();
      onEvent({ type: 'error', error: errorMsg });
      onEvent({ type: 'end' });
      return resolve({ exitCode: -1, error: errorMsg });
    }

    const emitEvent = (event: AgentStreamEvent) => {
      onEvent(event);
    };

    let idleTimer: NodeJS.Timeout | null = null;
    let settled = false;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
        }, 3000).unref();
      }, idleTimeoutMs);
    };

    resetIdleTimer();

    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        child.kill('SIGTERM');
      });
    }

    // 写入用户 prompt
    child.stdin?.write(prompt);
    child.stdin?.end();

    const rl = createInterface({
      input: child.stdout!,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      resetIdleTimer();
      try {
        const json = JSON.parse(trimmed);
        if (handlePiJsonEvent(json, emitEvent)) {
          child.kill('SIGTERM');
        }
      } catch {
        // 非 JSON 行降级为 text delta
        emitEvent({ type: 'text', delta: line + '\n' });
      }
    });

    let stderrBuffer = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderrBuffer += d.toString();
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      cleanupMcpConfig();
      emitEvent({ type: 'end' });
      resolve({
        exitCode: code,
        error: code !== 0 && stderrBuffer ? stderrBuffer : undefined,
      });
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      cleanupMcpConfig();
      emitEvent({ type: 'error', error: err.message });
      emitEvent({ type: 'end' });
      resolve({ exitCode: -1, error: err.message });
    });
  });
}

/**
 * 解析 Pi CLI --mode json 产生的事件
 */
export function handlePiJsonEvent(json: Record<string, unknown>, onEvent: (event: AgentStreamEvent) => void): boolean {
  if (json.type === 'agent_end') {
    return true;
  }

  if (json.type === 'message_end') {
    const message = json.message as Record<string, unknown> | undefined;
    if (message?.role === 'assistant' && message.stopReason === 'error') {
      const errorMessage = message.errorMessage;
      onEvent({
        type: 'error',
        error: typeof errorMessage === 'string' && errorMessage ? errorMessage : 'Agent 响应失败',
      });
    }
    return false;
  }

  // 1. 处理流式增量事件 (message_update -> text_delta / thinking_delta)
  if (json.type === 'message_update') {
    const ame = json.assistantMessageEvent as Record<string, unknown> | undefined;
    if (ame) {
      if (ame.type === 'text_delta' && typeof ame.delta === 'string') {
        onEvent({ type: 'text', delta: ame.delta });
        return false;
      }
      if (ame.type === 'thinking_delta' && typeof ame.delta === 'string') {
        onEvent({ type: 'thinking', delta: ame.delta });
        return false;
      }
    }
  }

  // 2. 处理标准 toolCall / toolResult
  if (json.type === 'tool_execution_start' || json.type === 'tool_call') {
    onEvent({
      type: 'tool_call',
      tool: {
        id: (json.toolCallId || json.id || '') as string,
        name: (json.toolName || json.name || json.tool) as string,
        args: (json.args || json.arguments || {}) as Record<string, unknown>,
      },
    });
    return false;
  }

  if (json.type === 'tool_execution_end' || json.type === 'tool_result') {
    onEvent({
      type: 'tool_result',
      result: {
        id: (json.toolCallId || json.id || '') as string,
        name: (json.toolName || json.name || json.tool) as string,
        content: json.result ?? json.content,
      },
    });
    return false;
  }

  // 3. 处理整条 message。不同 Pi 版本可能将内容放在 message.content 或顶层 content。
  if (json.type === 'message') {
    const message = (json.message && typeof json.message === 'object' ? json.message : json) as Record<string, unknown>;
    const content = message.content ?? json.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const item = block as Record<string, unknown>;
        if (item.type === 'thinking' && typeof item.thinking === 'string') {
          onEvent({ type: 'thinking', delta: item.thinking });
        } else if (item.type === 'text' && typeof item.text === 'string') {
          onEvent({ type: 'text', delta: item.text });
        }
      }
      return false;
    }
    if (typeof content === 'string') {
      onEvent({ type: 'text', delta: content });
    }
    if (typeof message.thinking === 'string') {
      onEvent({ type: 'thinking', delta: message.thinking });
    }
    return false;
  }

  if (json.type === 'thinking') {
    onEvent({ type: 'thinking', delta: String(json.delta ?? json.content ?? '') });
    return false;
  }

  if (json.type === 'text') {
    onEvent({ type: 'text', delta: String(json.delta ?? json.content ?? '') });
    return false;
  }

  if (json.type === 'error') {
    onEvent({ type: 'error', error: String(json.error ?? json.message ?? 'Unknown agent error') });
  }
  return false;
}
