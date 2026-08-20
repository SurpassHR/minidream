import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSettings, saveSettings } from './settings-store.js';

const DEFAULT_SETTINGS = {
  comfyUrl: '',
  agentModel: '',
  agentThinking: '',
  armorBreak: '',
  armorBreakEnabled: false,
  ollamaUrl: '',
  ollamaModel: '',
  ollamaEmbedModel: '',
};

describe('settings-store', () => {
  let fakeHome: string;
  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'settings-test-'));
    vi.stubEnv('HOME', fakeHome);
    return () => {
      try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
    };
  });

  describe('readSettings', () => {
    it('文件不存在时返回默认空配置', () => {
      expect(readSettings()).toEqual(DEFAULT_SETTINGS);
    });
  });

  describe('saveSettings', () => {
    it('更新单字段并保留其他默认值', () => {
      const saved = saveSettings({ comfyUrl: 'http://127.0.0.1:8188' });
      expect(saved.comfyUrl).toBe('http://127.0.0.1:8188');
      expect(readSettings()).toEqual({ ...DEFAULT_SETTINGS, comfyUrl: 'http://127.0.0.1:8188' });
    });

    it('多字段连续保存互不覆盖', () => {
      saveSettings({ comfyUrl: 'http://localhost:8188' });
      saveSettings({ agentModel: 'anthropic/claude-3-7-sonnet' });
      saveSettings({ agentThinking: 'high' });
      const s = readSettings();
      expect(s.comfyUrl).toBe('http://localhost:8188');
      expect(s.agentModel).toBe('anthropic/claude-3-7-sonnet');
      expect(s.agentThinking).toBe('high');
    });

    it('主题 theme 设置', () => {
      saveSettings({ theme: 'light' });
      expect(readSettings().theme).toBe('light');
    });
  });
});
