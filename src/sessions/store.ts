// 共享会话存储：AGENT 面板（chat.json）与故事对话式（story-chat.json）共用的多会话结构。
// 文件参数化（调用方传路径）；结构 { sessions: [{id,title,createdAt,updatedAt,messages}], activeId }；
// 旧扁平消息数组（ChatMessage[]）读时自动迁移为「会话 1」（惰性写回：下次写操作落盘新结构）。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DirectorError } from '../types.js';

export interface ChatMessage { who: 'user' | 'agent'; text: string; at: number }
export interface ChatSession {
  id: string; title: string; createdAt: number; updatedAt: number; messages: ChatMessage[];
  // 会话归属（故事向导剧本项目用；AGENT 面板与旧数据无此字段 = 未归组）
  boardId?: string;
}
export interface SessionFile { sessions: ChatSession[]; activeId: string | null }
export interface SessionMeta { id: string; title: string; createdAt: number; updatedAt: number }

const TITLE_LIMIT = 20;
const STORY_SYSTEM_TITLE_SKIP = new Set(['（开始访谈）', '（请总结成稿）']);
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
    // 旧结构：扁平消息数组 → 迁移为单个「会话 1」并**立即落盘**——
    // 惰性迁移会让每次读取生成不同的新 id（GET 返回的 id 在随后发送时永远命中不了，
    // 导致每句话都被归为新会话）；立即写回后 id 稳定。
    if (Array.isArray(data)) {
      const now = Date.now();
      const f: SessionFile = {
        sessions: [{ id: newId(), title: '会话 1', createdAt: now, updatedAt: now, messages: data }],
        activeId: null,
      };
      f.activeId = f.sessions[0]!.id;
      try { writeSessions(file, f); } catch { /* 只读目录等：返回内存结果，不抛 */ }
      return f;
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
        boardId: typeof s.boardId === 'string' ? s.boardId : undefined,
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

// 会话列表；boardId 缺省 = 全部（AGENT 面板/旧数据兼容），传值 = 仅该归组的会话
export function sessionList(file: string, boardId?: string | null): { sessions: SessionMeta[]; activeId: string | null } {
  const f = readSessions(file);
  const sessions = boardId
    ? f.sessions.filter((s) => s.boardId === boardId)
    : f.sessions;
  return {
    sessions: sessions.map((s) => ({ id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt })),
    activeId: f.activeId,
  };
}

export function activeMessages(file: string, sessionId?: string | null): ChatMessage[] {
  const f = readSessions(file);
  const id = sessionId ?? f.activeId;
  return f.sessions.find((s) => s.id === id)?.messages ?? [];
}

export function createSession(file: string, boardId?: string | null): SessionFile {
  const f = readSessions(file);
  const now = Date.now();
  const s: ChatSession = { id: newId(), title: '新会话', createdAt: now, updatedAt: now, messages: [], boardId: boardId ?? undefined };
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
  boardId?: string | null,
): SessionFile {
  const trimmed = text.trim();
  if (!trimmed) return readSessions(file);
  const isSystemTitleMarker = who === 'user' && STORY_SYSTEM_TITLE_SKIP.has(trimmed);
  const f = readSessions(file);
  let s = f.sessions.find((x) => x.id === sessionId);
  if (!s && sessionId !== null) {
    // 未知非空 sessionId（跨标签页/陈旧 id）：回退到当前 active 会话，避免静默新建
    // 造成"每句话一个会话"；无 active 时仍走下方自动创建
    s = f.sessions.find((x) => x.id === f.activeId);
  }
  if (!s) {
    // 无会话自动创建：标题 = 首条用户消息截断 20 字；归组到 boardId（无则未归组）
    const now = Date.now();
    s = { id: newId(), title: who === 'user' && !isSystemTitleMarker ? trimTitle(trimmed) : '新会话', createdAt: now, updatedAt: now, messages: [], boardId: boardId ?? undefined };
    f.sessions.push(s);
    f.activeId = s.id;
  }
  // 自动标题：跳过 kickoff/总结标记，寻找第一条真实用户消息（截断 20 字）命名。
  const hasRealUserMessage = s.messages.some(
    (m) => m.who === 'user' && !STORY_SYSTEM_TITLE_SKIP.has(m.text.trim()),
  );
  s.messages.push({ who, text: trimmed, at: Date.now() });
  if (who === 'user' && !isSystemTitleMarker && !hasRealUserMessage && s.title === '新会话') {
    s.title = trimTitle(trimmed);
  }
  if (s.messages.length > maxMessages) {
    s.messages = s.messages.slice(s.messages.length - maxMessages);
  }
  s.updatedAt = Date.now();
  return writeSessions(file, f);
}
