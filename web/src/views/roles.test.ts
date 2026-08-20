import { describe, expect, it } from 'vitest';
import { ROLE_PROMPT_KEYS, resolvePrompt, withArmorBreak } from './roles';

describe('resolvePrompt', () => {
  it('命中配置值', () => {
    expect(resolvePrompt({ storyTeller: '定制' }, 'storyTeller')).toBe('定制');
  });

  it('未配置（undefined / 空对象）回退内置默认', () => {
    expect(resolvePrompt(undefined, 'storyTeller')).toBe(ROLE_PROMPT_KEYS.storyTeller);
    expect(resolvePrompt({}, 'objectDesigner')).toBe(ROLE_PROMPT_KEYS.objectDesigner);
  });

  it('空串视为未配置', () => {
    expect(resolvePrompt({ storySummarize: '' }, 'storySummarize')).toBe(ROLE_PROMPT_KEYS.storySummarize);
  });

  it('3 个角色键均有非空内置默认', () => {
    expect(Object.keys(ROLE_PROMPT_KEYS).sort()).toEqual(
      ['objectDesigner', 'storySummarize', 'storyTeller'],
    );
    for (const v of Object.values(ROLE_PROMPT_KEYS)) {
      expect(v.trim().length).toBeGreaterThan(0);
    }
  });

  it('storySummarize 产出与 mmh3-storyboard-split 协议一致的 YAML 提示词设定', () => {
    expect(ROLE_PROMPT_KEYS.storySummarize).toContain('MiniMax H3');
    expect(ROLE_PROMPT_KEYS.storySummarize).toContain('mmh3-storyboard-split');
    expect(ROLE_PROMPT_KEYS.storySummarize).toContain('segments');
    expect(ROLE_PROMPT_KEYS.storySummarize).toContain('integrated_multimodal_description');
  });
});

describe('withArmorBreak', () => {
  it('关闭开关：原样返回', () => {
    expect(withArmorBreak('系统提示词', '破甲文本', false)).toBe('系统提示词');
    expect(withArmorBreak('系统提示词', '破甲文本', undefined)).toBe('系统提示词');
  });

  it('开启但文本为空/全空白：原样返回', () => {
    expect(withArmorBreak('系统提示词', '', true)).toBe('系统提示词');
    expect(withArmorBreak('系统提示词', '   ', true)).toBe('系统提示词');
    expect(withArmorBreak('系统提示词', undefined, true)).toBe('系统提示词');
  });

  it('开启且文本非空：前置插入（trim + 双换行分隔）', () => {
    expect(withArmorBreak('系统提示词', '  破甲预设  ', true)).toBe('破甲预设\n\n系统提示词');
  });
});
