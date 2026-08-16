import { describe, expect, it } from 'vitest';
import { ROLE_PROMPT_KEYS, resolvePrompt } from './roles';

describe('resolvePrompt', () => {
  it('命中配置值', () => {
    expect(resolvePrompt({ storyTeller: '定制' }, 'storyTeller')).toBe('定制');
  });

  it('未配置（undefined / 空对象）回退内置默认', () => {
    expect(resolvePrompt(undefined, 'storyTeller')).toBe(ROLE_PROMPT_KEYS.storyTeller);
    expect(resolvePrompt({}, 'objectDesigner')).toBe(ROLE_PROMPT_KEYS.objectDesigner);
  });

  it('空串视为未配置', () => {
    expect(resolvePrompt({ storyChat: '' }, 'storyChat')).toBe(ROLE_PROMPT_KEYS.storyChat);
  });

  it('5 个角色键均有非空内置默认', () => {
    expect(Object.keys(ROLE_PROMPT_KEYS)).toHaveLength(5);
    expect(Object.keys(ROLE_PROMPT_KEYS).sort()).toEqual(
      ['objectDesigner', 'storyBackfill', 'storyChat', 'storySummarize', 'storyTeller'],
    );
    for (const v of Object.values(ROLE_PROMPT_KEYS)) {
      expect(v.trim().length).toBeGreaterThan(0);
    }
  });
});
