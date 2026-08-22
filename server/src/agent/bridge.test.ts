import { describe, it, expect, vi } from 'vitest';
import { buildAgentInput, handlePiJsonEvent, type AgentStreamEvent } from './bridge.js';

describe('Agent Bridge', () => {
  it('buildAgentInput 组装提示词与多模态参考图', () => {
    const input = buildAgentInput({
      message: '生成一只发光的赛博朋克鹿',
      images: ['/uploads/ref1.png', 'https://example.com/ref2.jpg'],
      context: '当前处于科幻故事第一幕',
    });

    expect(input).toContain('【上下文信息】\n当前处于科幻故事第一幕');
    expect(input).toContain('[Image 1]: /uploads/ref1.png');
    expect(input).toContain('[Image 2]: https://example.com/ref2.jpg');
    expect(input).toContain('【用户指令】\n生成一只发光的赛博朋克鹿');
  });

  it('解析完整 message 事件中的 thinking 与 text 内容', () => {
    const events: AgentStreamEvent[] = [];
    handlePiJsonEvent({
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '先分析用户需求。' },
          { type: 'text', text: '这是最终回复。' },
        ],
      },
    }, event => events.push(event));

    expect(events).toEqual([
      { type: 'thinking', delta: '先分析用户需求。' },
      { type: 'text', delta: '这是最终回复。' },
    ]);
  });

  it('buildAgentInput 在无上下文和图片时直接输出指令', () => {
    const input = buildAgentInput({
      message: '测试指令',
    });
    expect(input).toBe('【用户指令】\n测试指令');
  });
});
