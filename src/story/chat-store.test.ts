import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendStoryChat, readStoryChat } from './chat-store.js';

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
    appendStoryChat(dir, 'user', '我想做一个精灵与哥布林的故事');
    appendStoryChat(dir, 'agent', '好设定！建议冲突围绕两族共有的诅咒');
    const msgs = readStoryChat(dir);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.who).toBe('user');
    expect(msgs[1]!.text).toContain('诅咒');
  });

  it('超过 100 条裁剪最早', () => {
    for (let i = 0; i < 105; i++) appendStoryChat(dir, 'user', `msg-${i}`);
    const msgs = readStoryChat(dir);
    expect(msgs).toHaveLength(100);
    expect(msgs[0]!.text).toBe('msg-5');
  });

  it('空文本不追加', () => {
    appendStoryChat(dir, 'user', '   ');
    expect(readStoryChat(dir)).toEqual([]);
  });
});
