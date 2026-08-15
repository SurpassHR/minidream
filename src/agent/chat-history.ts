import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// —— 聊天历史：按项目持久化 ——
// 存储到 <projectDir>/.director/chat.json（与图数据/快照同级的运行时数据目录）：
// 重启服务器 / 刷新页面不丢失；切换项目时历史随项目加载，互不串扰。
// 聊天记录不参与画布快照（快照只管 nodes/edges），独立文件、独立读写。

export interface ChatMessage {
  who: 'user' | 'agent';
  text: string;
  at: number;
}

const MAX_MESSAGES = 300;

function chatFile(projectDir: string): string {
  return join(projectDir, '.director', 'chat.json');
}

// 读取项目聊天历史；文件缺失或损坏时返回空列表（防御式）
export function readChatHistory(projectDir: string): ChatMessage[] {
  const f = chatFile(projectDir);
  if (!existsSync(f)) return [];
  try {
    const data = JSON.parse(readFileSync(f, 'utf8')) as ChatMessage[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

// 追加一条消息；超过上限裁剪最早的消息（保留最近 MAX_MESSAGES 条）；原子写（tmp + rename）
export function appendChatMessage(projectDir: string, who: 'user' | 'agent', text: string): ChatMessage[] {
  const trimmed = trim(text);
  if (!trimmed) return readChatHistory(projectDir);
  const messages = [...readChatHistory(projectDir), { who, text: trimmed, at: Date.now() }];
  const kept = messages.length > MAX_MESSAGES ? messages.slice(messages.length - MAX_MESSAGES) : messages;
  const f = chatFile(projectDir);
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(kept, null, 2), 'utf8');
  renameSync(tmp, f);
  return kept;
}

function trim(s: string): string {
  return s.trim();
}
