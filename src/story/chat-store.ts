// —— STORY 对话式历史：按项目多会话持久化 ——
// 存储到 <projectDir>/.director/story-chat.json（与 AGENT 面板 chat.json 完全隔离）：
// 重启服务器 / 刷新页面不丢失；切换项目时历史随项目加载，互不串扰。
// 结构见 src/sessions/store.ts（多会话 + 旧扁平数组迁移）。
import { join } from 'node:path';
import {
  activeMessages, appendMessage, createSession, deleteSession,
  renameSession, sessionList,
  type ChatMessage, type SessionFile, type SessionMeta,
} from '../sessions/store.js';

export type { ChatMessage, ChatSession, SessionFile, SessionMeta } from '../sessions/store.js';

const MAX_MESSAGES = 100;

function chatFile(projectDir: string): string {
  return join(projectDir, '.director', 'story-chat.json');
}

// 读取对话历史（指定会话；缺省当前 active）；文件缺失或损坏返回空列表（防御式）
export function readStoryChat(projectDir: string, sessionId?: string | null): ChatMessage[] {
  return activeMessages(chatFile(projectDir), sessionId);
}

// 追加一条消息到指定会话（无会话自动创建）；超过上限裁剪最早；原子写
// sessionId 为 null 时落到当前 active 会话（无任何会话才自动创建）——
// 保证一次对话的 user/agent 两条写同落一个会话（旧 API 不带 sessionId 的向后兼容）
// boardId：自动创建会话时的归组（故事向导剧本项目）；null/undefined = 未归组
export function appendStoryChat(projectDir: string, sessionId: string | null, who: ChatMessage['who'], text: string, boardId?: string | null): SessionFile {
  const id = sessionId ?? sessionList(chatFile(projectDir)).activeId;
  return appendMessage(chatFile(projectDir), id, who, text, MAX_MESSAGES, boardId);
}

// boardId 缺省 = 全部会话（旧数据/AGENT 面板兼容）；传值 = 仅该项目的会话
export function listStorySessions(projectDir: string, boardId?: string | null): { sessions: SessionMeta[]; activeId: string | null } {
  return sessionList(chatFile(projectDir), boardId);
}

export function createStorySession(projectDir: string, boardId?: string | null): SessionFile {
  return createSession(chatFile(projectDir), boardId);
}

export function renameStorySession(projectDir: string, id: string, title: string): SessionFile {
  return renameSession(chatFile(projectDir), id, title);
}

export function deleteStorySession(projectDir: string, id: string): SessionFile {
  return deleteSession(chatFile(projectDir), id);
}
