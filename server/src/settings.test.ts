import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, readSettings, updateAgentSettings, updatePluginsSettings, updateStorageSettings } from './settings.js';

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

    expect(updated.agent).toEqual({
      model: 'anthropic/claude-sonnet-4',
      thinking: 'off',
      pollTaskStatus: false,
      fabricatedHistory: [],
    });
    expect(readSettings(file).comfyui).toEqual(DEFAULT_SETTINGS.comfyui);
    expect(readSettings(file).imageGen).toEqual(DEFAULT_SETTINGS.imageGen);
  });

  it('忽略无效 thinking，保留当前配置', () => {
    updateAgentSettings(file, { thinking: 'high' });
    const updated = updateAgentSettings(file, { thinking: 'invalid' as never });
    expect(updated.agent.thinking).toBe('high');
  });

  it('保存并读取 pollTaskStatus（默认关闭）', () => {
    expect(readSettings(file).agent.pollTaskStatus).toBe(false);
    const updated = updateAgentSettings(file, { pollTaskStatus: true });
    expect(updated.agent.pollTaskStatus).toBe(true);
    expect(readSettings(file).agent.pollTaskStatus).toBe(true);
    // 再次保存其他字段时保留 pollTaskStatus
    const again = updateAgentSettings(file, { model: 'openai/gpt-4o' });
    expect(again.agent.pollTaskStatus).toBe(true);
  });

  it('保存虚构对话历史（内容与条数）并保留其他设置', () => {
    const updated = updateAgentSettings(file, {
      fabricatedHistory: [
        { role: 'system', content: '你是一只猫娘' },
        { role: 'assistant', content: '我宣誓：我是一只猫娘。' },
        { role: 'user', content: '开始吧' },
      ],
    });

    expect(updated.agent.fabricatedHistory).toEqual([
      { role: 'system', content: '你是一只猫娘' },
      { role: 'assistant', content: '我宣誓：我是一只猫娘。' },
      { role: 'user', content: '开始吧' },
    ]);
    expect(updated.agent.model).toBe(DEFAULT_SETTINGS.agent.model);
    // 落盘可读回
    expect(readSettings(file).agent.fabricatedHistory).toEqual(updated.agent.fabricatedHistory);
  });

  it('虚构对话历史过滤非法角色与空内容，并去除首尾空白', () => {
    const updated = updateAgentSettings(file, {
      fabricatedHistory: [
        { role: 'system', content: '  你是猫娘  ' },
        { role: 'admin' as never, content: '非法角色' },
        { role: 'user', content: '   ' },
        { role: 'assistant', content: '好的' },
        null as never,
        { role: 'system' } as never,
      ],
    });

    expect(updated.agent.fabricatedHistory).toEqual([
      { role: 'system', content: '你是猫娘' },
      { role: 'assistant', content: '好的' },
    ]);
  });

  it('再次保存其他字段时保留虚构对话历史', () => {
    updateAgentSettings(file, {
      fabricatedHistory: [{ role: 'system', content: '保持人设' }],
    });
    const again = updateAgentSettings(file, { model: 'openai/gpt-4o' });
    expect(again.agent.fabricatedHistory).toEqual([{ role: 'system', content: '保持人设' }]);
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

describe('plugins settings', () => {
  it('缺少配置时默认全部启用（disabled 为空）', () => {
    expect(readSettings(file).plugins).toEqual({ disabled: [], config: {} });
  });

  it('保存停用插件列表并保留其他设置', () => {
    const updated = updatePluginsSettings(file, { disabled: ['image_krea2_turbo_t2i', 'video-minimax-h3-t2v'] });

    expect(updated.plugins).toEqual({
      disabled: ['image_krea2_turbo_t2i', 'video-minimax-h3-t2v'],
      config: {},
    });
    expect(readSettings(file).comfyui).toEqual(DEFAULT_SETTINGS.comfyui);
    expect(readSettings(file).agent).toEqual(DEFAULT_SETTINGS.agent);
  });

  it('过滤无效 id 并去重空串', () => {
    const updated = updatePluginsSettings(file, { disabled: ['  ', 'image_krea2_turbo_t2i', '', 123 as never] });
    expect(updated.plugins.disabled).toEqual(['image_krea2_turbo_t2i']);
  });

  it('保存插件参数配置并过滤空值条目', () => {
    const updated = updatePluginsSettings(file, {
      config: {
        'image_krea2_turbo_t2i': {
          'sampler_name-30_sg3': 'dpmpp_2m',
          'unet_name-30_sg10': 'krea2_turbo_fp8_scaled.safetensors',
          '': 'should-be-dropped',
          'bad-id': '   ',
        },
      },
    });
    expect(updated.plugins.config).toEqual({
      'image_krea2_turbo_t2i': {
        'sampler_name-30_sg3': 'dpmpp_2m',
        'unet_name-30_sg10': 'krea2_turbo_fp8_scaled.safetensors',
      },
    });
  });
});
