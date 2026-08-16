import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { readSettings, saveSettings } from './settings-store.js';

let realHome: string;
let fakeHome: string;

beforeEach(() => {
  // 隔离 HOME：设置落到临时目录，不污染真实 ~/.director
  realHome = homedir();
  fakeHome = mkdtempSync(join(tmpdir(), 'director-settings-'));
  vi.stubEnv('HOME', fakeHome);
});
afterEach(() => {
  vi.stubEnv('HOME', realHome);
  vi.unstubAllEnvs();
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('readSettings', () => {
  it('文件不存在返回默认值（空串三字段）', () => {
    expect(readSettings()).toEqual({ comfyUrl: '', agentModel: '', agentThinking: '' });
  });

  it('文件损坏返回默认值（不抛错）', () => {
    mkdirSync(join(fakeHome, '.director'), { recursive: true });
    writeFileSync(join(fakeHome, '.director', 'settings.json'), '{broken', 'utf8');
    expect(readSettings()).toEqual({ comfyUrl: '', agentModel: '', agentThinking: '' });
  });

  it('部分字段缺失时补默认值', () => {
    mkdirSync(join(fakeHome, '.director'), { recursive: true });
    writeFileSync(join(fakeHome, '.director', 'settings.json'), JSON.stringify({ comfyUrl: 'http://127.0.0.1:8188' }), 'utf8');
    expect(readSettings()).toEqual({ comfyUrl: 'http://127.0.0.1:8188', agentModel: '', agentThinking: '' });
  });
});

describe('saveSettings', () => {
  it('合并保存并落盘读回', () => {
    saveSettings({ comfyUrl: 'http://127.0.0.1:8188' });
    saveSettings({ agentModel: 'anthropic/claude-sonnet-4', agentThinking: 'medium' });
    const s = readSettings();
    expect(s.comfyUrl).toBe('http://127.0.0.1:8188');
    expect(s.agentModel).toBe('anthropic/claude-sonnet-4');
    expect(s.agentThinking).toBe('medium');
    expect(existsSync(join(fakeHome, '.director', 'settings.json'))).toBe(true);
  });

  it('非字符串字段被忽略（保持现值）', () => {
    saveSettings({ comfyUrl: 'http://a' });
    // 非法类型：数字 agentModel 不生效
    const s = saveSettings({ agentModel: 123 as never, agentThinking: 'high' });
    expect(s.agentModel).toBe('');
    expect(s.agentThinking).toBe('high');
  });
});

describe('prompts 提示词库', () => {
  it('缺失 prompts 字段时返回 undefined（从未自定义）', () => {
    expect(readSettings().prompts).toBeUndefined();
  });

  it('保存 prompts 整体替换（增/改/删）且总是写入', () => {
    saveSettings({ prompts: { storyTeller: 'A', custom: 'B' } });
    expect(readSettings().prompts).toEqual({ storyTeller: 'A', custom: 'B' });
    // 整体替换：删 storyTeller、改 custom、加 storyChat
    saveSettings({ prompts: { custom: 'B2', storyChat: 'C' } });
    expect(readSettings().prompts).toEqual({ custom: 'B2', storyChat: 'C' });
  });

  it('空对象保留（已保存空库不复活）', () => {
    saveSettings({ prompts: {} });
    expect(readSettings().prompts).toEqual({});
  });

  it('非 string 值过滤；未传 prompts 保持现值', () => {
    saveSettings({ prompts: { a: 'ok', b: 123 as never, c: null as never } });
    expect(readSettings().prompts).toEqual({ a: 'ok' });
    const s = saveSettings({ comfyUrl: 'http://x' });
    expect(s.prompts).toEqual({ a: 'ok' });
  });

  it('损坏文件返回默认（prompts undefined，不抛错）', () => {
    mkdirSync(join(fakeHome, '.director'), { recursive: true });
    writeFileSync(join(fakeHome, '.director', 'settings.json'), '{broken', 'utf8');
    expect(readSettings().prompts).toBeUndefined();
  });
});
