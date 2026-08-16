import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StoryChat, parseStoryAnswers } from './StoryChat';

const HISTORY = { messages: [
  { who: 'user', text: '我想做精灵与哥布林的故事', at: 1 },
  { who: 'agent', text: '好设定！', at: 2 },
] };

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/story/chat/history')) {
      return new Response(JSON.stringify(HISTORY), { status: 200 });
    }
    if (u.includes('/api/story/chat')) {
      // SSE：两帧流式 + DONE
      return new Response(
        'data: {"chunk":"精灵骑士"}\n\ndata: {"chunk":"银发绿眸"}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('parseStoryAnswers', () => {
  it('解析六步约定格式，忽略非法行', () => {
    const text = [
      'theme: 战争与和解',
      'protagonist: 精灵骑士',
      '随便说说',
      'scenes: 迷雾森林',
      'ending:',
    ].join('\n');
    expect(parseStoryAnswers(text)).toEqual({
      theme: '战争与和解', protagonist: '精灵骑士', scenes: '迷雾森林',
    });
  });

  it('空文本返回空对象', () => {
    expect(parseStoryAnswers('')).toEqual({});
    expect(parseStoryAnswers('没有格式的文本')).toEqual({});
  });
});

describe('StoryChat', () => {
  it('加载历史并渲染消息', async () => {
    render(<StoryChat projectName="demo" onBackfill={() => {}} onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('我想做精灵与哥布林的故事')).toBeInTheDocument());
    expect(screen.getByText('好设定！')).toBeInTheDocument();
  });

  it('发送消息后流式渲染 agent 回复', async () => {
    render(<StoryChat projectName="demo" onBackfill={() => {}} onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('我想做精灵与哥布林的故事')).toBeInTheDocument());
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: '主角是谁？' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText(/精灵骑士银发绿眸/)).toBeInTheDocument());
  });

  it('回填向导：点击后解析 AI 输出并回调 onBackfill', async () => {
    let backfilled: Record<string, string> | null = null;
    // 覆盖 mock：/api/story/chat 返回六步格式
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/api/story/chat/history')) {
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }
      if (u.includes('/api/story/chat')) {
        return new Response(
          'data: {"chunk":"theme: 战争与和解\\nprotagonist: 精灵骑士"}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }));
    render(<StoryChat projectName="demo" onBackfill={(a) => { backfilled = a; }} onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('↩ 回填向导')).toBeInTheDocument());
    fireEvent.click(screen.getByText('↩ 回填向导'));
    await waitFor(() => expect(backfilled).toEqual({ theme: '战争与和解', protagonist: '精灵骑士' }));
  });

  it('总结成稿：解析后回调 onSummarized 携带答案', async () => {
    let summarized: Record<string, string> | null = null;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/api/story/chat/history')) {
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }
      if (u.includes('/api/story/chat')) {
        return new Response(
          'data: {"chunk":"theme: 战争与和解\\nprotagonist: 精灵骑士"}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }));
    render(<StoryChat projectName="demo" onBackfill={() => {}} onSummarized={(a) => { summarized = a; }} />);
    await waitFor(() => expect(screen.getByText('✨ 总结成稿')).toBeInTheDocument());
    fireEvent.click(screen.getByText('✨ 总结成稿'));
    await waitFor(() => expect(summarized).toEqual({ theme: '战争与和解', protagonist: '精灵骑士' }));
  });

  it('总结成稿连接失败：不显示格式错误（只提示连接失败）', async () => {
    // mock POST /api/story/chat 返回 500：流式请求失败
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/api/story/chat/history')) {
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }
      if (u.includes('/api/story/chat')) {
        return new Response('err', { status: 500 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }));
    render(<StoryChat projectName="demo" onBackfill={() => {}} onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('✨ 总结成稿')).toBeInTheDocument());
    fireEvent.click(screen.getByText('✨ 总结成稿'));
    // 出现连接失败提示
    await waitFor(() => expect(screen.getByText(/（agent 连接失败）/)).toBeInTheDocument());
    // 不出现格式错误提示（旧实现会同时显示两条矛盾提示）
    expect(screen.queryByText('未识别到答案格式，请重试')).not.toBeInTheDocument();
  });

  it('回填向导请求携带 persistAs 标记（不落盘长指令原文）', async () => {
    let requestBody: string | null = null;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/api/story/chat/history')) {
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }
      if (u.includes('/api/story/chat')) {
        requestBody = String(init?.body ?? '');
        return new Response(
          'data: {"chunk":"theme: 战争与和解"}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }));
    render(<StoryChat projectName="demo" onBackfill={() => {}} onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('↩ 回填向导')).toBeInTheDocument());
    fireEvent.click(screen.getByText('↩ 回填向导'));
    await waitFor(() => expect(requestBody).not.toBeNull());
    const parsed = JSON.parse(requestBody!) as { persistAs?: string };
    expect(parsed.persistAs).toBe('（请回填向导）');
  });

  it('completedAt 非空时显示完成提示条', async () => {
    render(<StoryChat projectName="demo" completedAt="2026-08-16T00:00:00.000Z" onBackfill={() => {}} onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText(/✅ 已完成 · 已生成故事文档进素材库/)).toBeInTheDocument());
  });

  it('总结成稿使用配置的 storyChat + storySummarize 提示词', async () => {
    const onSummarized = vi.fn();
    render(
      <StoryChat
        projectName="demo"
        onBackfill={() => {}}
        onSummarized={onSummarized}
        prompts={{ storyChat: '定制编剧', storySummarize: '定制总结' }}
      />,
    );
    await waitFor(() => expect(screen.getByText('我想做精灵与哥布林的故事')).toBeInTheDocument());
    fireEvent.click(screen.getByText('✨ 总结成稿'));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/story/chat'),
      expect.objectContaining({ method: 'POST' }),
    ));
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => String(c[0]).includes('/api/story/chat') && (c[1] as RequestInit)?.method === 'POST',
    );
    const body = JSON.parse(String(calls.at(-1)![1]?.body)) as { message: string };
    expect(body.message).toContain('定制编剧');
    expect(body.message).toContain('定制总结');
    expect(body.message).not.toContain('你是导演工作台的故事编剧');
  });
});
