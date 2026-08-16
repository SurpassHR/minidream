import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StoryChat, parseStoryAnswers } from './StoryChat';

// —— URL 感知 mock（Task 4 多会话）：sessions/history 返回 JSON，story/chat POST 返回 SSE ——
let SESSIONS: Array<{ id: string; title: string; createdAt: number; updatedAt: number }> = [];
let ACTIVE: string | null = null;
let HISTORY: Array<{ who: string; text: string; at: number }> = [];
let CHAT_BODIES: Array<{ message: string; sessionId?: string }> = [];

// 既有用例预置：会话列表 + 激活会话 + 历史。
// 注：仅预置 HISTORY 不够——「无会话自动新建」分支（POST sessions）会把 HISTORY 清空，
// 故同时预置 SESSIONS/ACTIVE 使加载走「已有会话 → 直接读历史」路径。
const LEGACY_HISTORY: Array<{ who: string; text: string; at: number }> = [
  { who: 'user', text: '我想做精灵与哥布林的故事', at: 1 },
  { who: 'agent', text: '好设定！', at: 2 },
];
function presetLegacySession() {
  SESSIONS = [{ id: 's1', title: '新会话', createdAt: 1, updatedAt: 1 }];
  ACTIVE = 's1';
  HISTORY = LEGACY_HISTORY;
}

beforeEach(() => {
  SESSIONS = []; ACTIVE = null; HISTORY = []; CHAT_BODIES = [];
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    // URL 匹配顺序：/api/story/chat/sessions 必须先于 /api/story/chat/history 与 /api/story/chat
    if (u.includes('/api/story/chat/sessions')) {
      if (method === 'POST') {
        const id = `s${SESSIONS.length + 1}`;
        SESSIONS = [...SESSIONS, { id, title: '新会话', createdAt: 1, updatedAt: 1 }];
        ACTIVE = id; HISTORY = [];
      } else if (method === 'PATCH') {
        const id = u.split('/').pop();
        const body = JSON.parse(String(init?.body)) as { title: string };
        SESSIONS = SESSIONS.map((s) => (s.id === id ? { ...s, title: body.title } : s));
      } else if (method === 'DELETE') {
        const id = u.split('/').pop();
        SESSIONS = SESSIONS.filter((s) => s.id !== id);
        ACTIVE = SESSIONS[0]?.id ?? null; HISTORY = [];
      }
      return new Response(JSON.stringify({ sessions: SESSIONS, activeId: ACTIVE }), { status: 200 });
    }
    if (u.includes('/api/story/chat/history')) {
      return new Response(JSON.stringify({ messages: HISTORY }), { status: 200 });
    }
    if (u.includes('/api/story/chat')) {
      if (method === 'POST') {
        CHAT_BODIES = [...CHAT_BODIES, JSON.parse(String(init?.body)) as { message: string; sessionId?: string }];
        return new Response(
          'data: {"chunk":"精灵骑士"}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
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
    presetLegacySession();
    render(<StoryChat projectName="demo" onBackfill={() => {}} onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('我想做精灵与哥布林的故事')).toBeInTheDocument());
    expect(screen.getByText('好设定！')).toBeInTheDocument();
  });

  it('发送消息后流式渲染 agent 回复', async () => {
    presetLegacySession();
    render(<StoryChat projectName="demo" onBackfill={() => {}} onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('我想做精灵与哥布林的故事')).toBeInTheDocument());
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: '主角是谁？' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // 新 mock 单帧 chunk（精灵骑士）+ DONE：断言随 mock 调整
    await waitFor(() => expect(screen.getByText(/精灵骑士/)).toBeInTheDocument());
  });

  it('回填向导：点击后解析 AI 输出并回调 onBackfill', async () => {
    let backfilled: Record<string, string> | null = null;
    // 覆盖 mock：/api/story/chat 返回六步格式
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/api/story/chat/sessions')) {
        return new Response(JSON.stringify({ sessions: [{ id: 's1', title: '新会话', createdAt: 1, updatedAt: 1 }], activeId: 's1' }), { status: 200 });
      }
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
      if (u.includes('/api/story/chat/sessions')) {
        return new Response(JSON.stringify({ sessions: [{ id: 's1', title: '新会话', createdAt: 1, updatedAt: 1 }], activeId: 's1' }), { status: 200 });
      }
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
      if (u.includes('/api/story/chat/sessions')) {
        return new Response(JSON.stringify({ sessions: [{ id: 's1', title: '新会话', createdAt: 1, updatedAt: 1 }], activeId: 's1' }), { status: 200 });
      }
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
      if (u.includes('/api/story/chat/sessions')) {
        return new Response(JSON.stringify({ sessions: [{ id: 's1', title: '新会话', createdAt: 1, updatedAt: 1 }], activeId: 's1' }), { status: 200 });
      }
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
    presetLegacySession();
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

  it('回填向导使用配置的 storyChat + storyBackfill 提示词', async () => {
    presetLegacySession();
    render(
      <StoryChat
        projectName="demo"
        onBackfill={() => {}}
        onSummarized={() => {}}
        prompts={{ storyChat: '定制编剧', storyBackfill: '定制回填' }}
      />,
    );
    await waitFor(() => expect(screen.getByText('我想做精灵与哥布林的故事')).toBeInTheDocument());
    fireEvent.click(screen.getByText('↩ 回填向导'));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/story/chat'),
      expect.objectContaining({ method: 'POST' }),
    ));
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => String(c[0]).includes('/api/story/chat') && (c[1] as RequestInit)?.method === 'POST',
    );
    const body = JSON.parse(String(calls.at(-1)![1]?.body)) as { message: string };
    expect(body.message).toContain('定制编剧');
    expect(body.message).toContain('定制回填');
    expect(body.message).not.toContain('你是导演工作台的故事编剧');
  });

  // —— Task 4 新增：左侧会话列表面板 ——
  it('会话面板：无会话自动新建；列表显示会话标题', async () => {
    render(<StoryChat projectName="demo" onBackfill={() => {}} onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('session-item-s1')).toBeInTheDocument());
    expect(screen.getByTestId('session-item-s1')).toHaveTextContent('新会话');
  });

  it('点选历史会话：加载该会话消息', async () => {
    SESSIONS = [
      { id: 'sa', title: '会话甲', createdAt: 1, updatedAt: 2 },
      { id: 'sb', title: '会话乙', createdAt: 3, updatedAt: 4 },
    ];
    ACTIVE = 'sa';
    HISTORY = [{ who: 'agent', text: '甲的历史', at: 2 }];
    render(<StoryChat projectName="demo" onBackfill={() => {}} onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('甲的历史')).toBeInTheDocument());
    // 切到 sb
    SESSIONS = [
      { id: 'sa', title: '会话甲', createdAt: 1, updatedAt: 2 },
      { id: 'sb', title: '会话乙', createdAt: 3, updatedAt: 4 },
    ];
    ACTIVE = 'sb';
    HISTORY = [{ who: 'user', text: '乙的消息', at: 4 }];
    fireEvent.click(screen.getByText('会话乙'));
    await waitFor(() => expect(screen.getByText('乙的消息')).toBeInTheDocument());
    expect(screen.queryByText('甲的历史')).not.toBeInTheDocument();
  });

  it('发送/总结成稿携带当前 sessionId', async () => {
    SESSIONS = [{ id: 's9', title: '当前', createdAt: 1, updatedAt: 1 }];
    ACTIVE = 's9';
    render(<StoryChat projectName="demo" onBackfill={() => {}} onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('session-item-s9')).toBeInTheDocument());
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: '主角是谁？' } });
    fireEvent.click(screen.getByText('发送'));
    await waitFor(() => expect(CHAT_BODIES.length).toBeGreaterThan(0));
    expect(CHAT_BODIES[0]!.sessionId).toBe('s9');
    fireEvent.click(screen.getByText('✨ 总结成稿'));
    await waitFor(() => expect(CHAT_BODIES.length).toBeGreaterThan(1));
    expect(CHAT_BODIES.at(-1)!.sessionId).toBe('s9');
  });

  it('重命名/删除会话（确认后）', async () => {
    SESSIONS = [{ id: 's1', title: '旧名', createdAt: 1, updatedAt: 2 }];
    ACTIVE = 's1';
    vi.spyOn(window, 'prompt').mockReturnValue('新名字');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<StoryChat projectName="demo" onBackfill={() => {}} onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('旧名')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('session-rename-s1'));
    await waitFor(() => expect(screen.getByText('新名字')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('session-del-s1'));
    await waitFor(() => expect(screen.queryByText('新名字')).not.toBeInTheDocument());
    vi.restoreAllMocks();
  });
});
