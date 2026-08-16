import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendChatMessage, createChatSession, deleteChatSession,
  listChatSessions, readChatHistory, renameChatSession,
} from './chat-history.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'director-chat-hist-'));
  mkdirSync(join(dir, '.director'), { recursive: true });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('chat-history 会话封装', () => {
  it('旧扁平数组历史迁移为「会话 1」并可读回', () => {
    writeFileSync(join(dir, '.director', 'chat.json'), JSON.stringify([
      { who: 'user', text: '旧消息', at: 1 },
    ]), 'utf8');
    const hist = readChatHistory(dir);
    expect(hist).toEqual([{ who: 'user', text: '旧消息', at: 1 }]);
  });

  it('appendChatMessage 落入指定会话；跨会话隔离', () => {
    const f1 = createChatSession(dir);            // s1
    const s1 = f1.activeId!;
    const f2 = createChatSession(dir);            // s2（当前）
    const s2 = f2.activeId!;
    appendChatMessage(dir, s1, 'user', '给 s1 的消息');
    appendChatMessage(dir, s2, 'user', '给 s2 的消息');
    expect(readChatHistory(dir, s1).map((m) => m.text)).toEqual(['给 s1 的消息']);
    expect(readChatHistory(dir, s2).map((m) => m.text)).toEqual(['给 s2 的消息']);
    // 不带 sessionId → 当前 active（s2）
    expect(readChatHistory(dir).map((m) => m.text)).toEqual(['给 s2 的消息']);
  });

  it('appendChatMessage 无会话时自动创建（sessionId null）', () => {
    const f = appendChatMessage(dir, null, 'user', '第一条消息');
    expect(f.sessions).toHaveLength(1);
    expect(f.sessions[0]!.title).toBe('第一条消息');
  });

  it('listChatSessions 元数据 + rename/delete 走封装', () => {
    const f1 = createChatSession(dir);
    const id = f1.activeId!;
    renameChatSession(dir, id, '改名后');
    expect(listChatSessions(dir).sessions[0]!.title).toBe('改名后');
    const f2 = deleteChatSession(dir, id);
    expect(f2.sessions).toEqual([]);
    expect(f2.activeId).toBeNull();
  });
});
