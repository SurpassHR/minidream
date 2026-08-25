/**
 * 会话存储：JSON 文件持久化（照搬 v1 的共享会话存储方案）。
 * - 结构 { sessions: [{id,title,createdAt,updatedAt,messages}], activeId }
 * - 消息保存完整 ChatMessage（role/content/stages/jobId），刷新后可还原生成结果
 * - 写入采用原子写（tmp + rename），避免半写损坏
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  thinkingDurationMs?: number;
  status?: string;
  toolCalls?: unknown[];
  tasks?: unknown[];
  actionCards?: unknown[];
  stages?: unknown[];
  routes?: unknown[];
  generationPrompts?: string[];
  responseBlocks?: unknown[];
  responseProtocolActive?: boolean;
  responsePolicy?: {
    thinking: 'hidden' | 'collapsed' | 'visible';
    prompt: 'hidden' | 'visible';
    route: 'hidden' | 'visible';
    result: 'outside-bubble';
  };
  jobId?: string;
  assets?: unknown[];
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** 删除消息后递增；用于让 Agent 放弃旧的隐式 Pi 会话上下文。 */
  contextVersion?: number;
  messages: StoredMessage[];
}

export interface SessionFile {
  sessions: ChatSession[];
  activeId: string | null;
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export class SessionError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const TITLE_LIMIT = 20;
let seq = 0;

function newId(): string {
  seq += 1;
  return `s-${Date.now().toString(36)}-${seq.toString(36)}`;
}

function trimTitle(text: string): string {
  const t = text.trim();
  return t ? Array.from(t).slice(0, TITLE_LIMIT).join('') : '新会话';
}

export function readSessions(file: string): SessionFile {
  if (!existsSync(file)) return { sessions: [], activeId: null };
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof data !== 'object' || data === null) return { sessions: [], activeId: null };
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    return {
      sessions: sessions.map((s: Partial<ChatSession>) => ({
        id: String(s.id ?? newId()),
        title: typeof s.title === 'string' && s.title.trim() ? s.title : '新会话',
        createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
        updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now(),
        contextVersion: typeof s.contextVersion === 'number' && s.contextVersion >= 0 ? s.contextVersion : 0,
        messages: Array.isArray(s.messages) ? s.messages : [],
      })),
      activeId: typeof data.activeId === 'string' ? data.activeId : null,
    };
  } catch {
    return { sessions: [], activeId: null };
  }
}

function writeSessions(file: string, f: SessionFile): SessionFile {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(f, null, 2), 'utf8');
  renameSync(tmp, file);
  return f;
}

function toMeta(s: ChatSession): SessionMeta {
  return { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt };
}

export function sessionList(file: string): { sessions: SessionMeta[]; activeId: string | null } {
  const f = readSessions(file);
  return { sessions: f.sessions.map(toMeta), activeId: f.activeId };
}

export function sessionMessages(file: string, id: string): StoredMessage[] {
  const f = readSessions(file);
  const s = f.sessions.find(x => x.id === id);
  if (!s) throw new SessionError('SESSION_NOT_FOUND', `会话不存在: ${id}`);
  return s.messages;
}

export function createSession(file: string): SessionFile {
  const f = readSessions(file);
  const now = Date.now();
  const s: ChatSession = { id: newId(), title: '新会话', createdAt: now, updatedAt: now, contextVersion: 0, messages: [] };
  f.sessions.push(s);
  f.activeId = s.id;
  return writeSessions(file, f);
}

export function renameSession(file: string, id: string, title: string): SessionFile {
  const f = readSessions(file);
  const s = f.sessions.find(x => x.id === id);
  if (!s) throw new SessionError('SESSION_NOT_FOUND', `会话不存在: ${id}`);
  const t = title.trim();
  if (t) s.title = Array.from(t).slice(0, TITLE_LIMIT).join('');
  s.updatedAt = Date.now();
  return writeSessions(file, f);
}

export function selectSession(file: string, id: string): SessionFile {
  const f = readSessions(file);
  if (!f.sessions.some(x => x.id === id)) throw new SessionError('SESSION_NOT_FOUND', `会话不存在: ${id}`);
  f.activeId = id;
  return writeSessions(file, f);
}

export function deleteSession(file: string, id: string): SessionFile {
  return deleteSessions(file, [id]);
}

/** 批量删除会话；先校验全部 id，再一次性写入，避免出现部分删除。 */
export function deleteSessions(file: string, ids: string[]): SessionFile {
  const f = readSessions(file);
  const uniqueIds = [...new Set(ids)];
  for (const id of uniqueIds) {
    if (!f.sessions.some(session => session.id === id)) {
      throw new SessionError('SESSION_NOT_FOUND', `会话不存在: ${id}`);
    }
  }
  if (uniqueIds.length === 0) return f;

  const deleting = new Set(uniqueIds);
  f.sessions = f.sessions.filter(session => !deleting.has(session.id));
  if (f.activeId && deleting.has(f.activeId)) {
    // 回退最近 updatedAt 的会话；无会话 → null
    const rest = [...f.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    f.activeId = rest[0]?.id ?? null;
  }
  return writeSessions(file, f);
}

export interface AppendResult {
  file: SessionFile;
  sessionId: string;
  /** 是否本次调用新建了会话 */
  created: boolean;
}

/** 追加一条消息；会话不存在时自动创建（标题 = 首条用户消息截断 20 字） */
export function appendMessage(file: string, sessionId: string | null, msg: StoredMessage): AppendResult {
  const trimmed = msg.content?.trim?.() ?? '';
  if (!trimmed && !msg.stages) return { file: readSessions(file), sessionId: sessionId ?? '', created: false };
  const f = readSessions(file);
  let s = f.sessions.find(x => x.id === sessionId);
  let created = false;
  if (!s) {
    const now = Date.now();
    s = {
      id: newId(),
      title: msg.role === 'user' ? trimTitle(trimmed || msg.content) : '新会话',
      createdAt: now,
      updatedAt: now,
      contextVersion: 0,
      messages: [],
    };
    f.sessions.push(s);
    f.activeId = s.id;
    created = true;
  }
  s.messages.push(msg);
  s.updatedAt = Date.now();
  return { file: writeSessions(file, f), sessionId: s.id, created };
}

/**
 * 从指定 user 消息开始截断（不保留该消息），用于编辑历史消息后创建新的对话分支。
 * 下一条消息由新的 /api/chat 请求追加，因此旧消息和其后续 assistant/user 内容都不会进入上下文。
 */
export function truncateMessages(file: string, sessionId: string, messageIndex: number): SessionFile {
  const f = readSessions(file);
  const s = f.sessions.find(x => x.id === sessionId);
  if (!s) throw new SessionError('SESSION_NOT_FOUND', `会话不存在: ${sessionId}`);
  const message = s.messages[messageIndex];
  if (!Number.isInteger(messageIndex) || messageIndex < 0 || !message) {
    throw new SessionError('MESSAGE_NOT_FOUND', `消息不存在: ${messageIndex}`);
  }
  if (message.role !== 'user') {
    throw new SessionError('MESSAGE_NOT_EDITABLE', '只能修改用户消息');
  }
  s.messages.splice(messageIndex);
  s.contextVersion = (s.contextVersion ?? 0) + 1;
  s.updatedAt = Date.now();
  return writeSessions(file, f);
}

/** 删除一条用户或助手消息，并使后续 Agent 请求切换到重建上下文。 */
export function deleteMessage(file: string, sessionId: string, messageIndex: number): SessionFile {
  const f = readSessions(file);
  const s = f.sessions.find(x => x.id === sessionId);
  if (!s) throw new SessionError('SESSION_NOT_FOUND', `会话不存在: ${sessionId}`);
  if (!Number.isInteger(messageIndex) || messageIndex < 0 || messageIndex >= s.messages.length) {
    throw new SessionError('MESSAGE_NOT_FOUND', `消息不存在: ${messageIndex}`);
  }
  s.messages.splice(messageIndex, 1);
  s.contextVersion = (s.contextVersion ?? 0) + 1;
  s.updatedAt = Date.now();
  return writeSessions(file, f);
}

/**
 * 更新会话最后一条消息（SSE 终态落库用）。
 * 优先按 jobId 匹配替换；无匹配时若末条 role 相同则替换末条，否则追加。
 */
export function updateLastMessage(file: string, sessionId: string, msg: StoredMessage): SessionFile {
  const f = readSessions(file);
  const s = f.sessions.find(x => x.id === sessionId);
  if (!s) throw new SessionError('SESSION_NOT_FOUND', `会话不存在: ${sessionId}`);
  let idx = -1;
  if (msg.jobId) {
    for (let i = s.messages.length - 1; i >= 0; i--) {
      if (s.messages[i]?.jobId === msg.jobId) {
        idx = i;
        break;
      }
    }
  }
  if (idx < 0 && s.messages.length > 0) {
    const last = s.messages[s.messages.length - 1];
    if (last && last.role === msg.role) idx = s.messages.length - 1;
  }
  if (idx >= 0) s.messages[idx] = msg;
  else s.messages.push(msg);
  s.updatedAt = Date.now();
  return writeSessions(file, f);
}
