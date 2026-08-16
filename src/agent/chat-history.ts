// —— AGENT 聊天历史：按项目多会话持久化 ——
// 存储到 <projectDir>/.director/chat.json（与图数据/快照同级的运行时数据目录）：
// 重启服务器 / 刷新页面不丢失；切换项目时历史随项目加载，互不串扰。
// 结构见 src/sessions/store.ts（多会话 + 旧扁平数组迁移）。
import { join } from 'node:path';
import {
  activeMessages, appendMessage, createSession, deleteSession,
  renameSession, sessionList,
  type ChatMessage, type SessionFile, type SessionMeta,
} from '../sessions/store.js';

export type { ChatMessage, SessionFile, SessionMeta } from '../sessions/store.js';

const MAX_MESSAGES = 300;

function chatFile(projectDir: string): string {
  return join(projectDir, '.director', 'chat.json');
}

// 读取项目聊天历史（指定会话；缺省当前 active）；文件缺失或损坏返回空列表（防御式）
export function readChatHistory(projectDir: string, sessionId?: string | null): ChatMessage[] {
  return activeMessages(chatFile(projectDir), sessionId);
}

// 追加一条消息到指定会话（无会话自动创建）；超过上限裁剪最早；原子写
// sessionId 为 null 时落到当前 active 会话（无任何会话才自动创建）——
// 保证一次对话的 user/agent 两条写同落一个会话（旧 API 不带 sessionId 的向后兼容）
export function appendChatMessage(projectDir: string, sessionId: string | null, who: ChatMessage['who'], text: string): SessionFile {
  const id = sessionId ?? sessionList(chatFile(projectDir)).activeId;
  return appendMessage(chatFile(projectDir), id, who, text, MAX_MESSAGES);
}

export function listChatSessions(projectDir: string): { sessions: SessionMeta[]; activeId: string | null } {
  return sessionList(chatFile(projectDir));
}

export function createChatSession(projectDir: string): SessionFile {
  return createSession(chatFile(projectDir));
}

export function renameChatSession(projectDir: string, id: string, title: string): SessionFile {
  return renameSession(chatFile(projectDir), id, title);
}

export function deleteChatSession(projectDir: string, id: string): SessionFile {
  return deleteSession(chatFile(projectDir), id);
}
