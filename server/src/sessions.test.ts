import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendMessage, createSession, deleteSession, readSessions, renameSession,
  selectSession, sessionList, sessionMessages, updateLastMessage,
} from './sessions.js';

let dir: string;
let file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'director-sessions-')); file = join(dir, 's.json'); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const userMsg = (content: string) => ({ role: 'user' as const, content });
const asstMsg = (content: string, extra?: object) => ({ role: 'assistant' as const, content, ...extra });

describe('readSessions', () => {
  it('缺失文件返回空库', () => {
    expect(readSessions(file)).toEqual({ sessions: [], activeId: null });
  });

  it('损坏文件返回空库（不抛错）', () => {
    writeFileSync(file, '{broken', 'utf8');
    expect(readSessions(file)).toEqual({ sessions: [], activeId: null });
  });

  it('完整消息（含 stages/jobId）可往返', () => {
    const msg = asstMsg('生成完成', {
      stages: [{ type: 'done', logs: ['ok'] }],
      jobId: 'j-1',
      thinking: '已分析需求',
      toolCalls: [{ callId: 'call-1', name: 'generation.submit' }],
      tasks: [{ id: 'task-1', status: 'completed' }],
      actionCards: [{ title: '再次生成' }],
    });
    const f = appendMessage(file, null, userMsg('画一只猫'));
    appendMessage(file, f.sessionId, msg);
    const loaded = sessionMessages(file, f.sessionId);
    expect(loaded).toEqual([
      { role: 'user', content: '画一只猫' },
      {
        role: 'assistant',
        content: '生成完成',
        stages: [{ type: 'done', logs: ['ok'] }],
        jobId: 'j-1',
        thinking: '已分析需求',
        toolCalls: [{ callId: 'call-1', name: 'generation.submit' }],
        tasks: [{ id: 'task-1', status: 'completed' }],
        actionCards: [{ title: '再次生成' }],
      },
    ]);
  });
});

describe('createSession / renameSession / selectSession', () => {
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
    expect(f3.sessions.find(s => s.id === id)!.title).toBe('精灵与哥布林');
    const f4 = renameSession(file, id, '   ');
    expect(f4.sessions.find(s => s.id === id)!.title).toBe('精灵与哥布林');
  });

  it('selectSession 切换 activeId 并持久化', () => {
    const f1 = createSession(file);
    const s1 = f1.activeId!;
    const f2 = createSession(file);
    const s2 = f2.activeId!;
    selectSession(file, s1);
    expect(readSessions(file).activeId).toBe(s1);
    expect(readSessions(file).activeId).not.toBe(s2);
  });

  it('renameSession/selectSession 不存在的 id 抛 SESSION_NOT_FOUND', () => {
    expect(() => renameSession(file, 'nope', 'x')).toThrowError(expect.objectContaining({ code: 'SESSION_NOT_FOUND' }));
    expect(() => selectSession(file, 'nope')).toThrowError(expect.objectContaining({ code: 'SESSION_NOT_FOUND' }));
  });
});

describe('appendMessage', () => {
  it('无会话时自动创建，标题取首条用户消息前 20 字', () => {
    const r = appendMessage(file, null, userMsg('这是一条很长很长的用户消息用来测试标题截断逻辑'));
    expect(r.created).toBe(true);
    const f = readSessions(file);
    expect(f.sessions).toHaveLength(1);
    expect(f.sessions[0]!.title).toBe(Array.from('这是一条很长很长的用户消息用来测试标题截断逻辑').slice(0, 20).join(''));
    expect(f.sessions[0]!.messages).toEqual([{ role: 'user', content: '这是一条很长很长的用户消息用来测试标题截断逻辑' }]);
  });

  it('指定已存在会话时追加且不新建', () => {
    const f1 = createSession(file);
    const id = f1.activeId!;
    const r = appendMessage(file, id, userMsg('你好'));
    expect(r.created).toBe(false);
    expect(r.sessionId).toBe(id);
    expect(readSessions(file).sessions).toHaveLength(1);
  });
});

describe('deleteSession', () => {
  it('删除当前会话回退最近 updatedAt 的会话', () => {
    const f1 = createSession(file); // s1
    const s1 = f1.activeId!;
    appendMessage(file, s1, userMsg('第一条'));
    const f3 = createSession(file); // s2（当前）
    const s2 = f3.activeId!;
    appendMessage(file, s1, userMsg('第二条')); // s1 变最新
    const f4 = deleteSession(file, s2);
    expect(f4.sessions.map(s => s.id)).not.toContain(s2);
    expect(f4.activeId).toBe(s1);
  });

  it('删除不存在的 id 抛 SESSION_NOT_FOUND', () => {
    expect(() => deleteSession(file, 'nope')).toThrowError(expect.objectContaining({ code: 'SESSION_NOT_FOUND' }));
  });
});

describe('updateLastMessage', () => {
  it('按 jobId 匹配替换最后一条（SSE 终态落库）', () => {
    const r = appendMessage(file, null, userMsg('画一只猫'));
    const sid = r.sessionId;
    appendMessage(file, sid, asstMsg('已提交', { stages: [{ type: 'task' }], jobId: 'j-1' }));
    const final = asstMsg('生成完成', { stages: [{ type: 'done', logs: ['完成'] }], jobId: 'j-1' });
    updateLastMessage(file, sid, final);
    const msgs = sessionMessages(file, sid);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toEqual(final);
  });

  it('无 jobId 匹配时替换同 role 末条；否则追加', () => {
    const r = appendMessage(file, null, userMsg('你好'));
    const sid = r.sessionId;
    appendMessage(file, sid, asstMsg('回复一', { jobId: 'a' }));
    // jobId 不同 → 替换末条（同 role）
    updateLastMessage(file, sid, asstMsg('回复二', { jobId: 'b' }));
    let msgs = sessionMessages(file, sid);
    expect(msgs.map(m => m.content)).toEqual(['你好', '回复二']);
    // 末条是 assistant，传入 user → 追加
    updateLastMessage(file, sid, userMsg('再来'));
    msgs = sessionMessages(file, sid);
    expect(msgs.map(m => m.content)).toEqual(['你好', '回复二', '再来']);
  });

  it('会话不存在抛 SESSION_NOT_FOUND', () => {
    expect(() => updateLastMessage(file, 'nope', asstMsg('x'))).toThrowError(expect.objectContaining({ code: 'SESSION_NOT_FOUND' }));
  });
});

describe('sessionList', () => {
  it('只返回 meta（不含消息）', () => {
    const r = appendMessage(file, null, userMsg('你好'));
    appendMessage(file, r.sessionId, asstMsg('嗨'));
    const l = sessionList(file);
    expect(l.sessions).toHaveLength(1);
    expect(l.sessions[0]).toEqual({
      id: expect.any(String),
      title: '你好',
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });
    expect(l.activeId).toBe(r.sessionId);
  });
});
