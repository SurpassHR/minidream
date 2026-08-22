import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface AgentStreamEvent {
  type: 'thinking' | 'text' | 'tool_call' | 'tool_result' | 'error' | 'end';
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

export interface RunAgentOptions {
  sessionId?: string;
  mcpServerUrl?: string;
  systemPrompt?: string;
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  idleTimeoutMs?: number;
  onEvent?: (event: AgentStreamEvent) => void;
}

/**
 * 将用户消息和多模态素材/上下文组装为发送给 Pi Agent 的输入文本
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
  const args: string[] = ['--mode', 'json', '--print'];

  if (options.sessionId) {
    args.push('--session-id', options.sessionId);
  } else {
    args.push('--no-session');
  }

  if (options.systemPrompt?.trim()) {
    args.push('--append-system-prompt', options.systemPrompt.trim());
  }

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    ...(options.env ?? {}),
  };

  if (options.mcpServerUrl) {
    env.MCP_CONFIG = JSON.stringify({
      mcpServers: {
        director: {
          url: options.mcpServerUrl,
        },
      },
    });
  }


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
      onEvent({ type: 'error', error: errorMsg });
      onEvent({ type: 'end' });
      return resolve({ exitCode: -1, error: errorMsg });
    }

    let idleTimer: NodeJS.Timeout | null = null;
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
        handlePiJsonEvent(json, onEvent);
      } catch {
        // 非 JSON 行降级为 text delta
        onEvent({ type: 'text', delta: line + '\n' });
      }
    });

    let stderrBuffer = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderrBuffer += d.toString();
    });

    child.on('close', (code) => {
      if (idleTimer) clearTimeout(idleTimer);
      onEvent({ type: 'end' });
      resolve({
        exitCode: code,
        error: code !== 0 && stderrBuffer ? stderrBuffer : undefined,
      });
    });

    child.on('error', (err) => {
      if (idleTimer) clearTimeout(idleTimer);
      onEvent({ type: 'error', error: err.message });
      onEvent({ type: 'end' });
      resolve({ exitCode: -1, error: err.message });
    });
  });
}

/**
 * 解析 Pi CLI --mode json 产生的事件
 */
function handlePiJsonEvent(json: Record<string, unknown>, onEvent: (event: AgentStreamEvent) => void) {
  // Pi 的标准 JSON event 格式解析
  if (json.type === 'message') {
    const msg = json.message as Record<string, unknown> | undefined;
    if (msg) {
      if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item.type === 'text' && typeof item.text === 'string') {
            onEvent({ type: 'text', delta: item.text });
          } else if (item.type === 'thinking' && typeof item.thinking === 'string') {
            onEvent({ type: 'thinking', delta: item.thinking });
          } else if (item.type === 'toolCall') {
            onEvent({
              type: 'tool_call',
              tool: {
                id: item.id as string,
                name: item.name as string,
                args: item.arguments as Record<string, unknown>,
              },
            });
          }
        }
      }
    }
    return;
  }

  if (json.type === 'thinking') {
    onEvent({ type: 'thinking', delta: String(json.delta ?? json.content ?? '') });
    return;
  }

  if (json.type === 'text') {
    onEvent({ type: 'text', delta: String(json.delta ?? json.content ?? '') });
    return;
  }

  if (json.type === 'tool_call' || json.type === 'toolCall') {
    onEvent({
      type: 'tool_call',
      tool: {
        id: json.id as string,
        name: (json.name ?? json.tool) as string,
        args: (json.args ?? json.arguments ?? {}) as Record<string, unknown>,
      },
    });
    return;
  }

  if (json.type === 'tool_result' || json.type === 'toolResult') {
    onEvent({
      type: 'tool_result',
      result: {
        id: json.id as string,
        name: (json.name ?? json.tool) as string,
        content: json.content ?? json.result,
      },
    });
    return;
  }

  if (json.type === 'error') {
    onEvent({ type: 'error', error: String(json.error ?? json.message ?? 'Unknown agent error') });
  }
}
