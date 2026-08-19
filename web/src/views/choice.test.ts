import { describe, expect, it } from 'vitest';
import { parseChoiceBlock, STORY_KICKOFF_MESSAGE, STORY_SYSTEM_MARKERS } from './choice';

describe('parseChoiceBlock', () => {
  it('解析合法 choice 块并从正文移除机器围栏', () => {
    const result = parseChoiceBlock([
      '先选访谈语言。',
      '',
      '```choice',
      '{"question":"希望用哪种语言进行访谈？","options":[{"id":"zh","label":"中文"},{"id":"en","label":" English "}]}',
      '```',
    ].join('\n'));

    expect(result).toEqual({
      question: '希望用哪种语言进行访谈？',
      options: [
        { id: 'zh', label: '中文' },
        { id: 'en', label: 'English' },
      ],
      prompt: '先选访谈语言。',
    });
  });

  it('多个围栏取最后一个，正文中的其它内容保持原样', () => {
    const result = parseChoiceBlock([
      '第一次说明',
      '```choice',
      '{"question":"旧问题","options":[{"id":"a","label":"甲"},{"id":"b","label":"乙"}]}',
      '```',
      '',
      '第二次说明',
      '```choice',
      '{"question":"新问题","options":[{"label":"丙"},{"id":"d","label":"丁"}]}',
      '```',
    ].join('\n'));

    expect(result?.question).toBe('新问题');
    expect(result?.options).toEqual([
      { id: 'opt-0', label: '丙' },
      { id: 'd', label: '丁' },
    ]);
    expect(result?.prompt).toContain('第一次说明');
    expect(result?.prompt).toContain('第二次说明');
    expect(result?.prompt).toContain('```choice\n{"question":"旧问题"');
    expect(result?.prompt).not.toContain('新问题');
  });

  it('支持 CRLF、围栏前后空白以及位于正文中间的最后一个块', () => {
    const result = parseChoiceBlock(
      '前文\r\n\r\n```choice\r\n{"question":"  问题  ","options":[{"label":" 一 "},{"label":"二"}]}\r\n```\r\n后文',
    );

    expect(result?.question).toBe('问题');
    expect(result?.prompt).toBe('前文\r\n\r\n\r\n后文');
  });

  it.each([
    ['未闭合', '```choice\n{"question":"问","options":[{"label":"甲"},{"label":"乙"}]'],
    ['坏 JSON', '```choice\n{"question":"问","options":[{"label":"甲"},{oops}]}\n```'],
    ['1 项', '```choice\n{"question":"问","options":[{"label":"甲"}]}\n```'],
    ['5 项', '```choice\n{"question":"问","options":[{"label":"甲"},{"label":"乙"},{"label":"丙"},{"label":"丁"},{"label":"戊"}]}\n```'],
    ['缺 label', '```choice\n{"question":"问","options":[{"id":"a"},{"label":"乙"}]}\n```'],
    ['空 question', '```choice\n{"question":"  ","options":[{"label":"甲"},{"label":"乙"}]}\n```'],
    ['重复 label', '```choice\n{"question":"问","options":[{"label":"甲 "},{"label":" 甲"}]}\n```'],
  ])('%s 时返回 null', (_name, text) => {
    expect(parseChoiceBlock(text)).toBeNull();
  });
});

describe('story choice constants', () => {
  it('提供系统标记和 kickoff 文案', () => {
    expect(STORY_SYSTEM_MARKERS).toEqual(['（开始访谈）', '（请总结成稿）']);
    expect(STORY_KICKOFF_MESSAGE).toContain('choice');
  });
});
