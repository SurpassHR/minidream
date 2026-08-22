import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, readSettings, updateAgentSettings, updateStorageSettings } from './settings.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'director-settings-'));
  file = join(dir, 'settings.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('agent settings', () => {
  it('缺少配置时使用 minimal thinking 默认值', () => {
    expect(readSettings(file).agent).toEqual(DEFAULT_SETTINGS.agent);
  });

  it('保存模型与 thinking 强度并保留其他设置', () => {
    const updated = updateAgentSettings(file, {
      model: ' anthropic/claude-sonnet-4 ',
      thinking: 'off',
    });

    expect(updated.agent).toEqual({ model: 'anthropic/claude-sonnet-4', thinking: 'off' });
    expect(readSettings(file).comfyui).toEqual(DEFAULT_SETTINGS.comfyui);
    expect(readSettings(file).imageGen).toEqual(DEFAULT_SETTINGS.imageGen);
  });

  it('忽略无效 thinking，保留当前配置', () => {
    updateAgentSettings(file, { thinking: 'high' });
    const updated = updateAgentSettings(file, { thinking: 'invalid' as never });
    expect(updated.agent.thinking).toBe('high');
  });
});

describe('storage settings', () => {
  it('缺少配置时使用项目内默认草稿目录', () => {
    expect(readSettings(file).storage.outputDir).toBe(DEFAULT_SETTINGS.storage.outputDir);
  });

  it('保存绝对输出目录并保留其他设置', () => {
    const outputDir = join(dir, 'drafts');
    const updated = updateStorageSettings(file, { outputDir });

    expect(updated.storage.outputDir).toBe(outputDir);
    expect(readSettings(file).comfyui).toEqual(DEFAULT_SETTINGS.comfyui);
    expect(JSON.parse(readFileSync(file, 'utf8')).storage.outputDir).toBe(outputDir);
  });

  it('拒绝相对输出目录', () => {
    expect(() => updateStorageSettings(file, { outputDir: 'drafts' })).toThrow(/绝对路径/);
  });
});
