import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendChatMessage, readChatHistory } from './chat-history.js';

describe('聊天历史（按项目持久化）', () => {
  let root: string;
  let projA: string;
  let projB: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'director-chat-'));
    projA = join(root, 'proj-a');
    projB = join(root, 'proj-b');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('append 后 read 往返；写入项目目录 .director/chat.json', () => {
    appendChatMessage(projA, 'user', '分析节奏');
    appendChatMessage(projA, 'agent', '**结论**：递进');
    const history = readChatHistory(projA);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ who: 'user', text: '分析节奏' });
    expect(history[1]).toMatchObject({ who: 'agent', text: '**结论**：递进' });
    expect(typeof history[0]?.at).toBe('number');
  });

  it('按项目隔离：不同项目目录的历史互不串扰', () => {
    appendChatMessage(projA, 'user', 'A 的消息');
    appendChatMessage(projB, 'user', 'B 的消息');
    expect(readChatHistory(projA).map((m) => m.text)).toEqual(['A 的消息']);
    expect(readChatHistory(projB).map((m) => m.text)).toEqual(['B 的消息']);
  });

  it('超过上限时裁剪最早的消息（保留最近 300 条）', () => {
    for (let i = 0; i < 305; i++) appendChatMessage(projA, 'user', `m${i}`);
    const history = readChatHistory(projA);
    expect(history).toHaveLength(300);
    expect(history[0]?.text).toBe('m5');
    expect(history[299]?.text).toBe('m304');
  });

  it('文件损坏或缺失时容错返回空列表', () => {
    expect(readChatHistory(projA)).toEqual([]);
    mkdirSync(join(projA, '.director'), { recursive: true });
    writeFileSync(join(projA, '.director', 'chat.json'), '{broken json', 'utf8');
    expect(readChatHistory(projA)).toEqual([]);
  });
});
