import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

import {
  buildAgentInput,
  generateConversationTitle,
  handlePiJsonEvent,
  parsePiModelList,
  toolCallFingerprint,
  runAgentStream,
  sanitizeTitle,
  type AgentStreamEvent,
} from './bridge.js';

interface FakeChild {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  kill: ReturnType<typeof vi.fn>;
  on: (event: string, listener: (...args: any[]) => void) => FakeChild;
  once: (event: string, listener: (...args: any[]) => void) => FakeChild;
}

function createFakeChild(): FakeChild {
  const events = new EventEmitter();
  const child = {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    kill: vi.fn((signal: string) => {
      child.exitCode = signal === 'SIGKILL' ? 137 : 143;
      queueMicrotask(() => events.emit('close', child.exitCode));
      return true;
    }),
    on(event: string, listener: (...args: any[]) => void) {
      events.on(event, listener);
      return child;
    },
    once(event: string, listener: (...args: any[]) => void) {
      events.once(event, listener);
      return child;
    },
  } as FakeChild;
  return child;
}

describe('Agent Bridge', () => {
  beforeEach(() => spawnMock.mockReset());
  afterEach(() => vi.restoreAllMocks());

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

  it('generateConversationTitle 用轻量无工具参数调用 Pi，并返回清洗后的标题', async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);
    const promise = generateConversationTitle('用 Krea2 生成一只可爱的小猫在花园里玩耍', {
      model: 'deepseek/deepseek-v4-flash',
    });
    const spawnArgs = spawnMock.mock.calls[0]?.[1] as string[];
    expect(spawnArgs).toEqual(expect.arrayContaining(['--print', '--no-tools', '--no-session', '--thinking', 'off']));
    expect(spawnArgs).toEqual(expect.arrayContaining(['--model', 'deepseek/deepseek-v4-flash']));
    expect(spawnArgs).toEqual(expect.arrayContaining(['--append-system-prompt', expect.any(String)]));
    expect(spawnArgs).toContain('--no-skills');

    // 模拟 pi 输出：一行状态日志 + 一行标题
    child.stdout.write('[auto-name] API 503 (...)\n');
    child.stdout.write('可爱小猫图片\n');
    child.kill('SIGKILL');
    await expect(promise).resolves.toBe('可爱小猫图片');
  });

  it('generateConversationTitle 无有效输出时重试后返回 null', async () => {
    spawnMock.mockImplementation(() => createFakeChild());
    const promise = generateConversationTitle('hi', { timeoutMs: 30 });
    await expect(promise).resolves.toBeNull();
    // 自动重试了一次
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('sanitizeTitle 清理引号、结束符 token 与标点', () => {
    expect(sanitizeTitle('\n"可爱的小猫图片。"\n')).toBe('可爱的小猫图片');
    expect(sanitizeTitle('</s>可爱小猫图片')).toBe('可爱小猫图片');
    expect(sanitizeTitle('<|endoftext|>Krea2 小猫图')).toBe('Krea2 小猫图');
  });

  it('sanitizeTitle 对散文/对话输出判定无效返回空串', () => {
    expect(sanitizeTitle('这个平台主要提供以下功能，让我详细介绍一下这里面的核心能力')).toBe('');
    expect(sanitizeTitle('需要我详细介绍某个具体功能吗？')).toBe('');
    expect(sanitizeTitle('[auto-name] API 503 (...)\n重试中')).toBe('');
  });

  it('解析 pi 模型列表并标记 thinking 和 image 能力', () => {
    expect(parsePiModelList([
      'provider model context max-out thinking images',
      'anthropic claude-sonnet-4 200k 8k yes yes',
      'openai gpt-4o 128k 4k no yes',
    ].join('\n'))).toEqual([
      { id: 'anthropic/claude-sonnet-4', provider: 'anthropic', thinking: true, images: true },
      { id: 'openai/gpt-4o', provider: 'openai', thinking: false, images: true },
    ]);
  });

  it('buildAgentInput 参考图使用前端 @图像N 命名作为标签', () => {
    const input = buildAgentInput({
      message: '用 @图像2 做图生图',
      images: [
        { name: '图像1', dataUrl: 'data:image/png;base64,AAA' },
        { name: '图像2', dataUrl: 'data:image/png;base64,BBB' },
      ],
    });

    expect(input).toContain('[图像1]: 图像1');
    expect(input).toContain('[图像2]: 图像2');
    expect(input).toContain('【用户指令】\n用 @图像2 做图生图');
  });

  it('buildAgentInput 展示已上传文件名并保留 @图像N 标签', () => {
    const input = buildAgentInput({
      message: '放大 @图像1',
      images: [{ name: '图像1', filename: 'chat-1750000000000-0.png' }],
    });

    expect(input).toContain('[图像1]: chat-1750000000000-0.png');
    expect(input).toContain('【用户指令】\n放大 @图像1');
  });

  it('buildAgentInput 在无上下文和图片时直接输出指令', () => {
    const input = buildAgentInput({
      message: '测试指令',
    });
    expect(input).toBe('【用户指令】\n测试指令');
  });

  it('buildAgentInput 不再拼接虚构对话历史（改由 Pi 扩展注入）', () => {
    const input = buildAgentInput({
      message: '画一只猫',
    });

    expect(input).toBe('【用户指令】\n画一只猫');
    expect(input).not.toContain('【对话历史】');
  });

  it('message_start 不生成用户可见占位状态，并转发 message_end 错误', () => {
    const events: AgentStreamEvent[] = [];

    handlePiJsonEvent({
      type: 'message_start',
      message: { role: 'assistant' },
    }, event => events.push(event));
    handlePiJsonEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: '模型认证失败',
      },
    }, event => events.push(event));

    expect(events).toEqual([
      { type: 'error', error: '模型认证失败' },
    ]);
  });

  it('generation.submit 工具调用保留完整 prompt 参数', () => {
    const events: AgentStreamEvent[] = [];
    handlePiJsonEvent({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'generation.submit',
      args: {
        workflowId: 'image_seedvr2_upscale',
        prompt: 'Enhance the input image while preserving the original details.',
      },
    }, event => events.push(event));

    expect(events).toEqual([
      {
        type: 'tool_call',
        tool: {
          id: 'call-1',
          name: 'generation.submit',
          args: {
            workflowId: 'image_seedvr2_upscale',
            prompt: 'Enhance the input image while preserving the original details.',
          },
        },
      },
    ]);
  });

  it('Pi 的 mcp 包装事件会展开为 generation.submit 并保留 prompt', () => {
    const events: AgentStreamEvent[] = [];
    handlePiJsonEvent({
      type: 'tool_execution_start',
      toolCallId: 'call-mcp-1',
      toolName: 'mcp',
      args: {
        tool: 'director_generation_submit',
        args: {
          workflowId: 'image_krea2_turbo_t2i',
          prompt: 'A cinematic image generation prompt.',
        },
      },
    }, event => events.push(event));

    expect(events[0]).toEqual(expect.objectContaining({
      type: 'tool_call',
      tool: expect.objectContaining({
        name: 'generation.submit',
        args: {
          workflowId: 'image_krea2_turbo_t2i',
          prompt: 'A cinematic image generation prompt.',
        },
      }),
    }));
  });

  it('generation.submit 工具调用兼容 JSON 字符串参数和命名空间名称', () => {
    const events: AgentStreamEvent[] = [];
    handlePiJsonEvent({
      type: 'tool_execution_start',
      toolCallId: 'call-2',
      toolName: 'director.generation.submit',
      arguments: JSON.stringify({
        workflowId: 'image_seedvr2_upscale',
        prompt: 'Upscale the referenced image.',
      }),
    }, event => events.push(event));

    expect(events[0]).toEqual(expect.objectContaining({
      type: 'tool_call',
      tool: expect.objectContaining({
        name: 'director.generation.submit',
        args: {
          workflowId: 'image_seedvr2_upscale',
          prompt: 'Upscale the referenced image.',
        },
      }),
    }));
  });

  it('相同调用 ID 或相同规范化业务参数生成相同指纹，便于过滤 Pi 重复事件', () => {
    expect(toolCallFingerprint({
      id: 'call-1',
      name: 'generation.submit',
      args: { workflowId: 'image_krea2_turbo_t2i', prompt: '同一提示词' },
    })).toBe('id:call-1');
    expect(toolCallFingerprint({
      name: 'generation.submit',
      args: { workflowId: 'image_krea2_turbo_t2i', prompt: '同一提示词' },
    })).toBe(toolCallFingerprint({
      name: 'generation.submit',
      args: { prompt: '同一提示词', workflowId: 'image_krea2_turbo_t2i' },
    }));
  });

  it('使用 v1 的 JSON 增量模式并在 agent_end 后立即终止 Pi', async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);
    const events: AgentStreamEvent[] = [];

    const resultPromise = runAgentStream('用户消息', {
      onEvent: event => events.push(event),
      idleTimeoutMs: 1000,
    });
    child.stdout.write(JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: '首字' },
    }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\n');

    const result = await resultPromise;
    expect(spawnMock).toHaveBeenCalledWith('pi', expect.arrayContaining(['--mode', 'json']), expect.any(Object));
    const spawnArgs = spawnMock.mock.calls[0]?.[1] as string[];
    expect(spawnArgs).not.toContain('--print');
    expect(spawnArgs).toEqual(expect.arrayContaining(['--thinking', 'minimal']));
    expect(spawnArgs).toContain('--no-skills');
    expect(spawnArgs).toContain('--no-context-files');
    const skillIndex = spawnArgs.indexOf('--skill');
    const skillPath = spawnArgs[skillIndex + 1];
    expect(skillPath).toMatch(/\.pi\/skills\/director-copilot\/SKILL\.md$/);
    expect(skillPath && existsSync(skillPath)).toBe(true);
    expect(spawnArgs).not.toContain('--model');
    expect(events).toContainEqual({ type: 'text', delta: '首字' });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(events.filter(event => event.type === 'end')).toHaveLength(1);
    expect(result.exitCode).toBe(143);
  });

  it('显式模型配置会透传给 Pi', async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);

    const resultPromise = runAgentStream('用户消息', {
      model: 'openai/gpt-4o',
      thinking: 'off',
      idleTimeoutMs: 1000,
    });
    const spawnArgs = spawnMock.mock.calls[0]?.[1] as string[];
    expect(spawnArgs).toEqual(expect.arrayContaining(['--model', 'openai/gpt-4o', '--thinking', 'off']));

    child.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\\n');
    await resultPromise;
  });

  it('Agent 结束后清理本轮临时 MCP 配置', async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);

    const resultPromise = runAgentStream('用户消息', {
      mcpServerUrl: 'http://127.0.0.1:4777/api/mcp',
      idleTimeoutMs: 1000,
    });
    const spawnArgs = spawnMock.mock.calls[0]?.[1] as string[];
    const mcpConfigPath = spawnArgs[spawnArgs.indexOf('--mcp-config') + 1]!;
    expect(mcpConfigPath).toMatch(/server\/data\/\.mcp-tmp\/mcp-.*\.json$/);
    expect(mcpConfigPath).toBeTruthy();

    child.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\n');
    await resultPromise;

    const { existsSync } = await import('node:fs');
    expect(existsSync(mcpConfigPath)).toBe(false);
  });
});
