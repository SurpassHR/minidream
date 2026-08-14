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

// 运行外部 agent 命令（默认 pi --print），stdout 按行流式回调
export function runAgentStream(
  cmd: string[],
  prompt: string,
  onChunk: (text: string) => void,
): Promise<{ exitCode: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0]!, cmd.slice(1), {
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdin.write(prompt);
    child.stdin.end();
    // 行缓冲流式输出
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) onChunk(line);
    });
    child.stdout.on('end', () => { if (buf) onChunk(buf); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve({ exitCode: code, stderr }));
  });
}
