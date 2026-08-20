import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activeMessages, appendMessage, createSession, deleteSession,
  readSessions, renameSession, sessionList,
} from './store.js';
import { DirectorError } from '../types.js';

let dir: string;
let file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'director-sessions-')); file = join(dir, 's.json'); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('readSessions', () => {
  it('缺失文件返回空库', () => {
    expect(readSessions(file)).toEqual({ sessions: [], activeId: null });
  });

  it('损坏文件返回空库（不抛错）', () => {
    writeFileSync(file, '{broken', 'utf8');
    expect(readSessions(file)).toEqual({ sessions: [], activeId: null });
  });

  it('旧扁平数组迁移为「会话 1」', () => {
    writeFileSync(file, JSON.stringify([
      { who: 'user', text: '你好', at: 1 },
      { who: 'agent', text: '嗨', at: 2 },
    ]), 'utf8');
    const f = readSessions(file);
    expect(f.sessions).toHaveLength(1);
    expect(f.sessions[0]!.title).toBe('会话 1');
    expect(f.sessions[0]!.messages).toEqual([
      { who: 'user', text: '你好', at: 1 },
      { who: 'agent', text: '嗨', at: 2 },
    ]);
    expect(f.activeId).toBe(f.sessions[0]!.id);
  });
});

describe('createSession / renameSession', () => {
  it('createSession 新建并置为 active；重命名生效；空标题忽略', () => {
    const f1 = createSession(file);
    expect(f1.sessions).toHaveLength(1);
    expect(f1.sessions[0]!.title).toBe('新会话');
    expect(f1.activeId).toBe(f1.sessions[0]!.id);
    const f2 = createSession(file);
    expect(f2.sessions).toHaveLength(2);
    expect(f2.activeId).toBe(f2.sessions[1]!.id);
    const id = f2.sessions[1]!.id;
    const f3 = renameSession(file, id, '精灵与哥布林');
    expect(f3.sessions.find((s) => s.id === id)!.title).toBe('精灵与哥布林');
    const f4 = renameSession(file, id, '   ');
    expect(f4.sessions.find((s) => s.id === id)!.title).toBe('精灵与哥布林');
  });

  it('renameSession 不存在的 id 抛 SESSION_NOT_FOUND', () => {
    expect(() => renameSession(file, 'nope', 'x')).toThrowError(DirectorError);
    expect(() => renameSession(file, 'nope', 'x')).toThrowError(expect.objectContaining({ code: 'SESSION_NOT_FOUND' }));
  });
});

describe('deleteSession', () => {
  it('删除当前会话回退最近 updatedAt 的会话', () => {
    const f1 = createSession(file);           // s1（当前）
    const f2 = appendMessage(file, f1.activeId, 'user', '第一条', 300);
    const s1 = f2.activeId!;
    const f3 = createSession(file);           // s2（当前，无消息）
    const s2 = f3.activeId!;
    appendMessage(file, s2, 'user', '第二条', 300);
    // 手动把 s1 的 updatedAt 改新：append s1 再 append s2 → s2 更新；为测「最近」，先 append s2 后 append s1
    appendMessage(file, s1, 'user', '第三条', 300); // s1 变最新
    const f4 = deleteSession(file, s2);       // 删当前 s2 → 回退 s1
    expect(f4.sessions.map((s) => s.id)).not.toContain(s2);
    expect(f4.activeId).toBe(s1);
  });

  it('删除不存在的 id 抛 SESSION_NOT_FOUND', () => {
    expect(() => deleteSession(file, 'nope')).toThrowError(expect.objectContaining({ code: 'SESSION_NOT_FOUND' }));
  });

  it('删光所有会话 → activeId null', () => {
    const f1 = createSession(file);
    const f2 = deleteSession(file, f1.activeId!);
    expect(f2.sessions).toEqual([]);
    expect(f2.activeId).toBeNull();
  });
});

describe('appendMessage', () => {
  it('追加消息、刷新 updatedAt、按 maxMessages 裁剪最早', () => {
    const f1 = createSession(file);
    const id = f1.activeId!;
    for (let i = 0; i < 5; i++) appendMessage(file, id, 'user', `m${i}`, 3);
    const f2 = readSessions(file);
    expect(f2.sessions[0]!.messages.map((m) => m.text)).toEqual(['m2', 'm3', 'm4']);
    expect(f2.sessions[0]!.updatedAt).toBeGreaterThanOrEqual(f1.sessions[0]!.createdAt);
  });

  it('sessionId null 时自动创建会话（标题=首条用户消息 20 字）', () => {
    const f = appendMessage(file, null, 'user', '这是一条很长的用户消息用来测试标题截断行为', 300);
    expect(f.sessions).toHaveLength(1);
    expect(f.sessions[0]!.title).toBe('这是一条很长的用户消息用来测试标题截断行');
    expect(f.activeId).toBe(f.sessions[0]!.id);
    // agent 消息不生成标题：新会话首条为空消息场景 → 标题「新会话」
    const f2 = createSession(file);
    appendMessage(file, f2.activeId, 'user', '', 300); // 空文本忽略
    expect(f2.sessions.find((s) => s.id === f2.activeId)!.title).toBe('新会话');
  });

  it('系统标记不命名会话，随后首条真实用户消息才命名', () => {
    const f = createSession(file);
    const id = f.activeId!;
    appendMessage(file, id, 'user', '（开始访谈）', 300);
    appendMessage(file, id, 'agent', '第一问', 300);
    appendMessage(file, id, 'user', '中文', 300);
    expect(readSessions(file).sessions[0]!.title).toBe('中文');

    const second = createSession(file);
    appendMessage(file, second.activeId, 'user', '（生成分镜提示词）', 300);
    appendMessage(file, second.activeId, 'user', '另一个故事', 300);
    expect(readSessions(file).sessions.find((s) => s.id === second.activeId)!.title).toBe('另一个故事');
  });

  it('空文本忽略不追加', () => {
    createSession(file);
    const before = activeMessages(file);
    appendMessage(file, null, 'user', '   ', 300);
    expect(activeMessages(file)).toEqual(before);
  });
});

describe('sessionList / activeMessages', () => {
  it('sessionList 返回元数据（不含 messages）；activeMessages 按会话取消息', () => {
    const f1 = createSession(file);
    appendMessage(file, f1.activeId, 'user', 'hello', 300);
    const list = sessionList(file);
    expect(list.sessions[0]).toEqual({
      id: f1.activeId, title: 'hello', createdAt: expect.any(Number), updatedAt: expect.any(Number),
    });
    expect(activeMessages(file)).toEqual([{ who: 'user', text: 'hello', at: expect.any(Number) }]);
    expect(activeMessages(file, 'missing')).toEqual([]);
  });
});

describe('回归：迁移 id 稳定 + 未知 id 回退（修复前 FAIL）', () => {
  it('GET 返回的 id 在随后 append 中命中（迁移立即落盘）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sess-repro-'));
    const file = join(dir, 'story-chat.json');
    writeFileSync(file, JSON.stringify([{ who: 'user', text: '旧消息', at: 1 }]), 'utf8');

    const list1 = sessionList(file);
    const X = list1.activeId!;
    const after = appendMessage(file, X, 'user', '新消息', 100);
    const hit = after.sessions.find((s) => s.id === X);
    expect(hit).toBeDefined();
    expect(hit!.messages.map((m) => m.text)).toEqual(['旧消息', '新消息']);
    // 磁盘已落盘新结构
    expect(readFileSync(file, 'utf8')).toContain('sessions');
    // 二次读取 id 稳定
    expect(readSessions(file).activeId).toBe(X);
  });

  it('未知非空 sessionId：回退到 active 会话（不新建）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sess-repro-'));
    const file = join(dir, 'c.json');
    const f1 = createSession(file);
    const active = f1.activeId!;
    const after = appendMessage(file, 'stale-id', 'user', '新消息', 100);
    expect(after.sessions).toHaveLength(1);
    expect(after.activeId).toBe(active);
    expect(after.sessions[0]!.messages.map((m) => m.text)).toEqual(['新消息']);
  });

  it('未知非空 sessionId 且无会话：自动创建（保持语义）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sess-repro-'));
    const file = join(dir, 'c.json');
    const after = appendMessage(file, 'stale-id', 'user', '新消息', 100);
    expect(after.sessions).toHaveLength(1);
    expect(after.sessions[0]!.title).toBe('新消息');
    expect(after.activeId).toBe(after.sessions[0]!.id);
  });
});

