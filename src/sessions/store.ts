// 共享会话存储：AGENT 面板（chat.json）与故事对话式（story-chat.json）共用的多会话结构。
// 文件参数化（调用方传路径）；结构 { sessions: [{id,title,createdAt,updatedAt,messages}], activeId }；
// 旧扁平消息数组（ChatMessage[]）读时自动迁移为「会话 1」（惰性写回：下次写操作落盘新结构）。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DirectorError } from '../types.js';

export interface ChatMessage { who: 'user' | 'agent'; text: string; at: number }
export interface ChatSession { id: string; title: string; createdAt: number; updatedAt: number; messages: ChatMessage[] }
export interface SessionFile { sessions: ChatSession[]; activeId: string | null }
export interface SessionMeta { id: string; title: string; createdAt: number; updatedAt: number }

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
    // 旧结构：扁平消息数组 → 迁移为单个「会话 1」
    if (Array.isArray(data)) {
      const id = newId();
      return { sessions: [{ id, title: '会话 1', createdAt: Date.now(), updatedAt: Date.now(), messages: data }], activeId: id };
    }
    if (typeof data !== 'object' || data === null) return { sessions: [], activeId: null };
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    return {
      sessions: sessions.map((s: Partial<ChatSession>) => ({
        id: String(s.id ?? newId()),
        title: typeof s.title === 'string' && s.title.trim() ? s.title : '新会话',
        createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
        updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now(),
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

export function sessionList(file: string): { sessions: SessionMeta[]; activeId: string | null } {
  const f = readSessions(file);
  return {
    sessions: f.sessions.map((s) => ({ id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt })),
    activeId: f.activeId,
  };
}

export function activeMessages(file: string, sessionId?: string | null): ChatMessage[] {
  const f = readSessions(file);
  const id = sessionId ?? f.activeId;
  return f.sessions.find((s) => s.id === id)?.messages ?? [];
}

export function createSession(file: string): SessionFile {
  const f = readSessions(file);
  const now = Date.now();
  const s: ChatSession = { id: newId(), title: '新会话', createdAt: now, updatedAt: now, messages: [] };
  f.sessions.push(s);
  f.activeId = s.id;
  return writeSessions(file, f);
}

export function renameSession(file: string, id: string, title: string): SessionFile {
  const f = readSessions(file);
  const s = f.sessions.find((x) => x.id === id);
  if (!s) throw new DirectorError('SESSION_NOT_FOUND', `会话不存在: ${id}`);
  const t = title.trim();
  if (t) s.title = Array.from(t).slice(0, TITLE_LIMIT).join('');
  return writeSessions(file, f);
}

export function deleteSession(file: string, id: string): SessionFile {
  const f = readSessions(file);
  const idx = f.sessions.findIndex((s) => s.id === id);
  if (idx < 0) throw new DirectorError('SESSION_NOT_FOUND', `会话不存在: ${id}`);
  f.sessions.splice(idx, 1);
  if (f.activeId === id) {
    // 回退最近 updatedAt 的会话；无会话 → null
    const rest = [...f.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    f.activeId = rest[0]?.id ?? null;
  }
  return writeSessions(file, f);
}

export function appendMessage(
  file: string,
  sessionId: string | null,
  who: ChatMessage['who'],
  text: string,
  maxMessages: number,
): SessionFile {
  const trimmed = text.trim();
  if (!trimmed) return readSessions(file);
  const f = readSessions(file);
  let s = f.sessions.find((x) => x.id === sessionId);
  if (!s) {
    // 无会话自动创建：标题 = 首条用户消息截断 20 字
    const now = Date.now();
    s = { id: newId(), title: who === 'user' ? trimTitle(trimmed) : '新会话', createdAt: now, updatedAt: now, messages: [] };
    f.sessions.push(s);
    f.activeId = s.id;
  }
  // 自动标题：会话尚无用户消息且标题仍为默认「新会话」时，用首条用户消息（截断 20 字）命名
  const isFirstUserMsg = who === 'user' && !s.messages.some((m) => m.who === 'user');
  s.messages.push({ who, text: trimmed, at: Date.now() });
  if (isFirstUserMsg && s.title === '新会话') s.title = trimTitle(trimmed);
  if (s.messages.length > maxMessages) {
    s.messages = s.messages.slice(s.messages.length - maxMessages);
  }
  s.updatedAt = Date.now();
  return writeSessions(file, f);
}
