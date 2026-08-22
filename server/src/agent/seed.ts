/**
 * 虚构对话历史的请求路径注入（参考 custom-first-control-prompt 的注入机制）。
 *
 * 机制：把配置的虚构历史构建为真实交替的 user/assistant Message 序列，
 * 通过动态生成的 Pi 扩展文件（`--extension` 加载）挂在 `context` 事件上，
 * 在每次 LLM 调用前将种子消息前置注入到消息序列头部。
 *
 * - 零会话日志写入：种子消息只存在于请求路径，不进入 Pi 的 session 日志，
 *   真实轮次编号不受影响，压缩（compaction）也无法遮蔽参考历史。
 * - 前缀缓存复用：种子消息每次请求逐字节一致，保持 LLM 前缀缓存命中。
 * - system 角色映射为 user 消息：Pi 消息序列中没有 system 角色（系统提示词
 *   单独处理），将规则类 system 文本作为用户侧消息注入最贴近 few-shot 惯例。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 配置中的一条虚构历史回合（与 settings.json 的 fabricatedHistory 结构一致） */
export interface SeedTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 注入到 LLM 请求的消息（Pi session-format 的消息结构） */
export interface SeedMessage {
  role: 'user' | 'assistant';
  content: Array<{ type: 'text'; text: string }>;
}

/**
 * 构建注入消息序列：过滤空白内容，system → user，保持 user/assistant 交替。
 * @param history - 配置的虚构历史回合。
 * @returns 可作为 LLM 消息序列前缀的种子消息。
 */
export function buildSeedMessages(history: SeedTurn[]): SeedMessage[] {
  const messages: SeedMessage[] = [];
  for (const turn of history) {
    const text = turn.content?.trim();
    if (!text) continue;
    messages.push({
      role: turn.role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: 'text', text }],
    });
  }
  return messages;
}

/** 注入扩展文件的默认内容模板；`__SEED_JSON__` 由调用方替换为序列化种子消息 */
const EXTENSION_TEMPLATE = `/**
 * 由 director-workbench 动态生成的 Pi 扩展：请求路径注入虚构对话历史。
 * 参考 custom-first-control-prompt 的注入机制：种子消息只在请求路径上
 * （零会话日志写入），每次 LLM 调用前前置注入，保持前缀缓存复用。
 */
const SEED = __SEED_JSON__;

export default function (pi) {
  pi.on('context', (event) => {
    if (!event || !Array.isArray(event.messages) || event.messages.length === 0) return;
    return { messages: [...SEED, ...event.messages] };
  });
}
`;

/**
 * 生成注入扩展文件（临时），返回其绝对路径；无有效种子时返回 null。
 * 生成的扩展文件在 `context` 事件中把种子消息前置到每次 LLM 调用的消息序列头部。
 * @param history - 配置的虚构历史回合。
 * @param tmpDir - 临时文件目录（默认 data/.mcp-tmp，与 MCP 配置文件同目录）。
 * @returns 扩展文件绝对路径，或 null（无可用种子时）。
 */
export function writeSeedExtension(
  history: SeedTurn[],
  tmpDir: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/.mcp-tmp'),
): string | null {
  const seeds = buildSeedMessages(history);
  if (seeds.length === 0) return null;
  mkdirSync(tmpDir, { recursive: true });
  const file = path.resolve(tmpDir, `seed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ts`);
  const content = EXTENSION_TEMPLATE.replace('__SEED_JSON__', JSON.stringify(seeds, null, 2));
  writeFileSync(file, content, 'utf8');
  return file;
}
