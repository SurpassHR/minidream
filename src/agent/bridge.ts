import { spawn } from 'node:child_process';

export interface AgentChatInput {
  message: string;
  chips: Array<{ name: string; content: string }>;
  graphSummary: string;
}

// 组装提示词：chips 上下文 + 画布摘要 + 用户消息（纯函数）
export function buildAgentPrompt(input: AgentChatInput): string {
  const parts: string[] = [];
  parts.push('你是导演工作台内置的 pi 创作 agent。当前画布摘要：' + input.graphSummary);
  if (input.chips.length > 0) {
    parts.push('以下是被引用节点的内容：');
    for (const c of input.chips) {
      parts.push(`\n[${c.name}]\n${c.content}`);
    }
  }
  parts.push('\n用户消息：\n' + input.message);
  return parts.join('\n');
}

// 运行外部 agent 命令，stdout 全部收集后返回（模型列表等一次性输出用）
export function runAgentCollect(cmd: string[]): Promise<{ stdout: string; exitCode: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0]!, cmd.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdin.end();
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve({ stdout, exitCode: code, stderr }));
  });
}

// 运行外部 agent 命令（默认 pi --print），stdout 按行流式回调。
// 空闲超时保护：流式输出停止 idleTimeoutMs 后 kill 子进程并正常结束（pi --print 在部分环境下
// 输出完整后不退出，若不兜底会导致 SSE 永不 [DONE]、调用方永远等待）。
// env：可注入项目上下文（如 DIRECTOR_PROJECT_DIR，kanban KANBAN_TASK_ID 语义）。
export function runAgentStream(
  cmd: string[],
  prompt: string,
  onChunk: (text: string) => boolean | void,
  opts: { idleTimeoutMs?: number; env?: Record<string, string> } = {},
): Promise<{ exitCode: number | null; stderr: string; idleKilled: boolean }> {
  const idleTimeoutMs = opts.idleTimeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0]!, cmd.slice(1), {
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let idleKilled = false;
    let idle: NodeJS.Timeout | null = null;
    // 输出活动时刷新空闲计时；超时后 SIGTERM，5s 仍未退出再 SIGKILL 兜底
    const kick = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        idleKilled = true;
        child.kill('SIGTERM');
        setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 5000).unref();
      }, idleTimeoutMs);
    };
    kick();
    child.stdin.write(prompt);
    child.stdin.end();
    // 行缓冲流式输出；onChunk 返回 true 表示输出已完整（如 agent_end 事件），
    // 立即终止子进程——json 模式 + MCP 连接时 pi 输出完不一定自然退出
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      kick();
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        let done = false;
        try { done = onChunk(line) === true; } catch { /* 回调异常不影响进程 */ }
        if (done) {
          child.kill('SIGTERM');
          break;
        }
      }
    });
    child.stdout.on('end', () => { if (buf) onChunk(buf); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (idle) clearTimeout(idle);
      resolve({ exitCode: code, stderr, idleKilled });
    });
  });
}
