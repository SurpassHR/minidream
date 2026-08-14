import { describe, expect, it } from 'vitest';
import {
  MAX_SEG_PROMPTS,
  PROMPT_YAML_VERSION,
  promptYamlFromSegments,
  validatePromptProtocol,
} from './protocol.js';

describe('validatePromptProtocol', () => {
  it('空值 ok', () => {
    expect(validatePromptProtocol(null).ok).toBe(true);
    expect(validatePromptProtocol(undefined).ok).toBe(true);
    expect(validatePromptProtocol(null).segments).toBe(0);
  });

  it('共享 prompt', () => {
    const r = validatePromptProtocol({ version: 1, prompt: 'hello' });
    expect(r.ok).toBe(true);
    expect(r.sharedPrompt).toBe('hello');
    expect(r.segments).toBe(0);
  });

  it('分段带时长', () => {
    const r = validatePromptProtocol({
      version: 1,
      segments: [
        { shot: 1, prompt: 'a', duration: 3.04 },
        { shot: 2, prompt: 'b', duration: 3.75 },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.segments).toBe(2);
    expect(r.hasDurations).toBe(true);
  });

  it('分段无时长（仅提示词模式）', () => {
    const r = validatePromptProtocol({
      segments: [{ prompt: 'a' }, { prompt: 'b' }],
    });
    expect(r.ok).toBe(true);
    expect(r.segments).toBe(2);
    expect(r.hasDurations).toBe(false);
  });

  it('duration 别名 seconds', () => {
    const r = validatePromptProtocol({
      segments: [{ prompt: 'a', seconds: 2.5 }, { prompt: 'b', seconds: 3 }],
    });
    expect(r.ok).toBe(true);
    expect(r.hasDurations).toBe(true);
  });

  it('时长全有或全无', () => {
    const r = validatePromptProtocol({
      segments: [{ prompt: 'a', duration: 3 }, { prompt: 'b' }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('全有或全无');
  });

  it('版本不匹配', () => {
    const r = validatePromptProtocol({ version: 2 });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('版本');
  });

  it('顶层必须是对象', () => {
    expect(validatePromptProtocol([]).ok).toBe(false);
    expect(validatePromptProtocol('x').ok).toBe(false);
  });

  it('segments 必须是数组', () => {
    expect(validatePromptProtocol({ segments: 3 }).ok).toBe(false);
  });

  it('分段缺少 prompt', () => {
    const r = validatePromptProtocol({ segments: [{ duration: 3 }] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('prompt');
  });

  it('空 prompt 拒绝', () => {
    const r = validatePromptProtocol({ segments: [{ prompt: '   ' }] });
    expect(r.ok).toBe(false);
  });

  it('duration 非正数拒绝', () => {
    expect(validatePromptProtocol({ segments: [{ prompt: 'a', duration: 0 }] }).ok).toBe(false);
    expect(validatePromptProtocol({ segments: [{ prompt: 'a', duration: -1 }] }).ok).toBe(false);
  });

  it('分段数上限', () => {
    const segs = new Array(MAX_SEG_PROMPTS + 1).fill({ prompt: 'a' });
    const r = validatePromptProtocol({ segments: segs });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('上限');
  });

  it('版本常量', () => {
    expect(PROMPT_YAML_VERSION).toBe(1);
  });
});

describe('promptYamlFromSegments', () => {
  it('分段 YAML 精确输出', () => {
    const yaml = promptYamlFromSegments({
      project: 'cat-vs-bunny',
      mode: 'storyboard',
      segments: [
        { shot: 1, keyframes: ['KF0', 'KF1'], duration: 3.04, prompt: 'line a\nline b' },
        { shot: 2, duration: 3.75, prompt: 'line c\nline d' },
      ],
    });
    const expected = [
      'version: 1',
      'project: cat-vs-bunny',
      'mode: storyboard',
      'segments:',
      '  - shot: 1',
      '    keyframes: [KF0, KF1]',
      '    duration: 3.04',
      '    prompt: |',
      '      line a',
      '      line b',
      '  - shot: 2',
      '    duration: 3.75',
      '    prompt: |',
      '      line c',
      '      line d',
      '',
    ].join('\n');
    expect(yaml).toBe(expected);
  });

  it('共享 prompt 输出', () => {
    const yaml = promptYamlFromSegments({ mode: 'ref2va', prompt: 'subject_definitions: ...\nsummary: ...' });
    expect(yaml).toContain('version: 1');
    expect(yaml).toContain('mode: ref2va');
    expect(yaml).toContain('prompt: |');
    expect(yaml).toContain('  subject_definitions: ...');
  });

  it('无分段无共享 → 仅版本行', () => {
    expect(promptYamlFromSegments({}).trim()).toBe('version: 1');
  });
});
