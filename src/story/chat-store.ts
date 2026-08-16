// story-teller 对话式历史：按项目持久化到 <projectDir>/.director/story-chat.json
// 与 AGENT 面板 chat.json 完全隔离（独立文件、独立端点）；上限 100 条裁剪最早
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChatMessage } from '../agent/chat-history.js';

const MAX_MESSAGES = 100;

function chatFile(projectDir: string): string {
  return join(projectDir, '.director', 'story-chat.json');
}

// 读取对话历史；文件缺失或损坏返回空列表（防御式）
export function readStoryChat(projectDir: string): ChatMessage[] {
  const f = chatFile(projectDir);
  if (!existsSync(f)) return [];
  try {
    const data = JSON.parse(readFileSync(f, 'utf8')) as ChatMessage[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

// 追加一条消息；超过上限裁剪最早（保留最近 MAX_MESSAGES 条）；原子写（tmp + rename）
export function appendStoryChat(projectDir: string, who: 'user' | 'agent', text: string): ChatMessage[] {
  const trimmed = text.trim();
  if (!trimmed) return readStoryChat(projectDir);
  const messages = [...readStoryChat(projectDir), { who, text: trimmed, at: Date.now() }];
  const kept = messages.length > MAX_MESSAGES ? messages.slice(messages.length - MAX_MESSAGES) : messages;
  const f = chatFile(projectDir);
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(kept, null, 2), 'utf8');
  renameSync(tmp, f);
  return kept;
}
