import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendStoryChat, createStorySession, deleteStorySession,
  listStorySessions, readStoryChat, renameStorySession,
} from './chat-store.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'director-story-chat-'));
  mkdirSync(join(dir, '.director'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('readStoryChat', () => {
  it('文件不存在返回空列表', () => {
    expect(readStoryChat(dir)).toEqual([]);
  });

  it('文件损坏返回空列表（不抛错）', () => {
    writeFileSync(join(dir, '.director', 'story-chat.json'), '{broken', 'utf8');
    expect(readStoryChat(dir)).toEqual([]);
  });
});

describe('appendStoryChat', () => {
  it('追加消息并落盘读回', () => {
    appendStoryChat(dir, null, 'user', '我想做一个精灵与哥布林的故事');
    appendStoryChat(dir, null, 'agent', '好设定！建议冲突围绕两族共有的诅咒');
    const msgs = readStoryChat(dir);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.who).toBe('user');
    expect(msgs[1]!.text).toContain('诅咒');
  });

  it('超过 100 条裁剪最早', () => {
    for (let i = 0; i < 105; i++) appendStoryChat(dir, null, 'user', `msg-${i}`);
    const msgs = readStoryChat(dir);
    expect(msgs).toHaveLength(100);
    expect(msgs[0]!.text).toBe('msg-5');
  });

  it('空文本不追加', () => {
    appendStoryChat(dir, null, 'user', '   ');
    expect(readStoryChat(dir)).toEqual([]);
  });
});

describe('story-chat 会话封装（同构）', () => {
  it('旧扁平数组历史迁移为「会话 1」并可读回', () => {
    writeFileSync(join(dir, '.director', 'story-chat.json'), JSON.stringify([
      { who: 'user', text: '旧消息', at: 1 },
    ]), 'utf8');
    const hist = readStoryChat(dir);
    expect(hist).toEqual([{ who: 'user', text: '旧消息', at: 1 }]);
  });

  it('appendStoryChat 落入指定会话；跨会话隔离', () => {
    const f1 = createStorySession(dir);           // s1
    const s1 = f1.activeId!;
    const f2 = createStorySession(dir);           // s2（当前）
    const s2 = f2.activeId!;
    appendStoryChat(dir, s1, 'user', '给 s1 的消息');
    appendStoryChat(dir, s2, 'user', '给 s2 的消息');
    expect(readStoryChat(dir, s1).map((m) => m.text)).toEqual(['给 s1 的消息']);
    expect(readStoryChat(dir, s2).map((m) => m.text)).toEqual(['给 s2 的消息']);
    // 不带 sessionId → 当前 active（s2）
    expect(readStoryChat(dir).map((m) => m.text)).toEqual(['给 s2 的消息']);
  });

  it('appendStoryChat 无会话时自动创建（sessionId null）', () => {
    const f = appendStoryChat(dir, null, 'user', '第一条消息');
    expect(f.sessions).toHaveLength(1);
    expect(f.sessions[0]!.title).toBe('第一条消息');
  });

  it('listStorySessions 元数据 + rename/delete 走封装', () => {
    const f1 = createStorySession(dir);
    const id = f1.activeId!;
    renameStorySession(dir, id, '改名后');
    expect(listStorySessions(dir).sessions[0]!.title).toBe('改名后');
    const f2 = deleteStorySession(dir, id);
    expect(f2.sessions).toEqual([]);
    expect(f2.activeId).toBeNull();
  });
});
