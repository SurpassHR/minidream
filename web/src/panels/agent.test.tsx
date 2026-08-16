import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentPanel } from './AgentPanel';
import { ConfirmDialog } from './ConfirmDialog';

// mock 流式 fetch：返回两段 SSE
function sseResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  const body = chunks.map((c) => `data: ${JSON.stringify({ chunk: c })}\n\n`).join('') + 'data: [DONE]\n\n';
  const stream = new ReadableStream({
    start(c) { c.enqueue(encoder.encode(body)); c.close(); },
  });
  return new Response(stream, { status: 200 });
}

describe('AgentPanel 流式对话', () => {
  // URL 感知 mock（Task 3 多会话）：sessions/history 返回 JSON，agent/chat 返回 SSE
  let SESSIONS: Array<{ id: string; title: string; createdAt: number; updatedAt: number }> = [];
  let ACTIVE: string | null = null;
  let HISTORY: Array<{ who: string; text: string; at: number }> = [];

  beforeEach(() => {
    SESSIONS = [];
    ACTIVE = null;
    HISTORY = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/api/agent/sessions')) {
        if (method === 'POST') {
          const id = `s${SESSIONS.length + 1}`;
          SESSIONS = [...SESSIONS, { id, title: '新会话', createdAt: 1, updatedAt: 1 }];
          ACTIVE = id;
          HISTORY = [];
        } else if (method === 'PATCH') {
          const id = u.split('/').pop();
          const body = JSON.parse(String(init?.body)) as { title: string };
          SESSIONS = SESSIONS.map((s) => (s.id === id ? { ...s, title: body.title } : s));
        } else if (method === 'DELETE') {
          const id = u.split('/').pop();
          SESSIONS = SESSIONS.filter((s) => s.id !== id);
          ACTIVE = SESSIONS[0]?.id ?? null;
          HISTORY = [];
        }
        return new Response(JSON.stringify({ sessions: SESSIONS, activeId: ACTIVE }), { status: 200 });
      }
      if (u.includes('/api/agent/history')) {
        return new Response(JSON.stringify({ messages: HISTORY }), { status: 200 });
      }
      if (u.includes('/api/agent/chat')) {
        return sseResponse(['分析中', '——结论：节奏递进']);
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('发送后流式渲染 agent 回复', async () => {
    render(<AgentPanel
      chips={[]}
      onChipsChange={() => {}}
      onSend={(_text, chips) => [{ who: 'user', text: '分析节奏' }, { who: 'agent', text: `STREAM:${JSON.stringify(chips)}` }]}
    />);
    fireEvent.change(screen.getByPlaceholderText(/对画布提问/), { target: { value: '分析节奏' } });
    fireEvent.click(screen.getByText('发送'));
    await waitFor(() => expect(screen.getByText(/分析节奏/)).toBeInTheDocument());
  });

  it('onStream 分块逐步追加到最后一条 agent 消息', async () => {
    render(<AgentPanel
      chips={[]}
      onChipsChange={() => {}}
      onSend={() => [{ who: 'user', text: '分析' }, { who: 'agent', text: '' }]}
      onStream={(_text, _chips, push) => {
        push('分析中');
        push('——结论：节奏递进');
      }}
    />);
    fireEvent.change(screen.getByPlaceholderText(/对画布提问/), { target: { value: '分析' } });
    fireEvent.click(screen.getByText('发送'));
    await waitFor(() => expect(screen.getByText('分析中——结论：节奏递进')).toBeInTheDocument());
  });

  it('Enter 发送；Shift+Enter 换行不发送', () => {
    const onSend = vi.fn(() => []);
    render(<AgentPanel chips={[]} onChipsChange={() => {}} onSend={onSend} />);
    const box = screen.getByPlaceholderText(/对画布提问/) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '第一行' } });
    // Shift+Enter：不发送（保留 textarea 默认换行）
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    // Enter：发送并清空输入框
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    // 发送参数为 text + chips；第 3 参为会话 id（Task 3 新增，属异步加载态，不作断言）
    const args = onSend.mock.calls[0] as unknown as [string, string[], string | null];
    expect(args[0]).toBe('第一行');
    expect(args[1]).toEqual([]);
    expect(box.value).toBe('');
  });

  it('agent 回复按 Markdown 渲染；用户消息保持纯文本', async () => {
    // URL 感知重载：会话/历史返回 JSON，chat 返回 SSE（与 beforeEach 同构，避免会话加载吞掉流式帧）
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/api/agent/sessions')) {
        return new Response(JSON.stringify({ sessions: [{ id: 's1', title: '新会话', createdAt: 1, updatedAt: 1 }], activeId: 's1' }), { status: 200 });
      }
      if (u.includes('/api/agent/history')) {
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }
      return sseResponse(['**重点** `code` 与 [链接](http://x)']);
    }));
    render(<AgentPanel
      chips={[]}
      onChipsChange={() => {}}
      onSend={() => [{ who: 'user', text: '**用户**消息' }, { who: 'agent', text: '' }]}
      onStream={(_text, _chips, push) => push('**重点** `code` 与 [链接](http://x)')}
    />);
    fireEvent.change(screen.getByPlaceholderText(/对画布提问/), { target: { value: 'hi' } });
    fireEvent.click(screen.getByText('发送'));
    await waitFor(() => {
      expect(document.querySelector('.msg.agent strong')?.textContent).toBe('重点');
    });
    expect(document.querySelector('.msg.agent code')?.textContent).toBe('code');
    expect(document.querySelector('.msg.agent a')?.textContent).toBe('链接');
    // 用户消息保持纯文本：不解析 ** 语法
    expect(screen.getByText('**用户**消息')).toBeInTheDocument();
    expect(document.querySelector('.msg.user strong')).toBeNull();
  });

  it('historyKey 变化时加载项目持久化的聊天历史（挂载 + 切项目）', async () => {
    const hist = (msgs: Array<{ who: 'user' | 'agent'; text: string; at: number }>) =>
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/api/agent/sessions')) {
          return new Response(JSON.stringify({ sessions: [{ id: 's1', title: '会话', createdAt: 1, updatedAt: 1 }], activeId: 's1' }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        if (u.includes('/api/agent/history')) {
          return new Response(JSON.stringify({ messages: msgs }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
    vi.stubGlobal('fetch', hist([
      { who: 'user', text: '项目A的问题', at: 1 },
      { who: 'agent', text: '项目A的回答', at: 2 },
    ]));
    const { rerender } = render(<AgentPanel chips={[]} onChipsChange={() => {}} onSend={() => []} historyKey="proj-a" />);
    await waitFor(() => expect(screen.getByText('项目A的问题')).toBeInTheDocument());
    expect(screen.getByText('项目A的回答')).toBeInTheDocument();
    // 切项目：重新加载新项目历史，旧消息清空
    vi.stubGlobal('fetch', hist([{ who: 'user', text: '项目B的问题', at: 3 }]));
    rerender(<AgentPanel chips={[]} onChipsChange={() => {}} onSend={() => []} historyKey="proj-b" />);
    await waitFor(() => expect(screen.getByText('项目B的问题')).toBeInTheDocument());
    expect(screen.queryByText('项目A的问题')).not.toBeInTheDocument();
  });

  // —— Task 3 新增：多会话会话条 ——
  it('会话条：无会话时自动新建；显示当前会话标题', async () => {
    render(<AgentPanel chips={[]} onChipsChange={() => {}} onSend={() => []} />);
    await waitFor(() => expect(screen.getByTestId('agent-session-current')).toHaveTextContent('新会话'));
  });

  it('下拉选择历史会话：加载该会话消息', async () => {
    SESSIONS = [
      { id: 's1', title: '会话甲', createdAt: 1, updatedAt: 2 },
      { id: 's2', title: '会话乙', createdAt: 3, updatedAt: 4 },
    ];
    ACTIVE = 's2';
    HISTORY = [{ who: 'user', text: '乙的消息', at: 5 }];
    render(<AgentPanel chips={[]} onChipsChange={() => {}} onSend={() => []} />);
    await waitFor(() => expect(screen.getByText('乙的消息')).toBeInTheDocument());
    // 切到 s1：mock 里选择时把 HISTORY 换成 s1 内容（测试内联调整）
    SESSIONS = [{ id: 's1', title: '会话甲', createdAt: 1, updatedAt: 2 }];
    ACTIVE = 's1';
    HISTORY = [{ who: 'agent', text: '甲的历史', at: 6 }];
    fireEvent.click(screen.getByTestId('agent-session-current'));
    fireEvent.click(screen.getByText('会话甲'));
    await waitFor(() => expect(screen.getByText('甲的历史')).toBeInTheDocument());
  });

  it('发送携带当前 sessionId 到 chat 请求体', async () => {
    SESSIONS = [{ id: 's9', title: '当前', createdAt: 1, updatedAt: 1 }];
    ACTIVE = 's9';
    render(<AgentPanel chips={[]} onChipsChange={() => {}} onSend={() => []} />);
    await waitFor(() => expect(screen.getByTestId('agent-session-current')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText(/对画布提问/), { target: { value: '分析节奏' } });
    fireEvent.click(screen.getByText('发送'));
    await waitFor(() => expect(screen.getByText(/分析中/)).toBeInTheDocument());
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => String(c[0]).includes('/api/agent/chat'),
    );
    const body = JSON.parse(String(calls.at(-1)![1]?.body)) as { sessionId?: string };
    expect(body.sessionId).toBe('s9');
  });

  it('重命名/删除会话（确认后）', async () => {
    SESSIONS = [{ id: 's1', title: '旧名', createdAt: 1, updatedAt: 2 }];
    ACTIVE = 's1';
    vi.spyOn(window, 'prompt').mockReturnValue('新名字');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AgentPanel chips={[]} onChipsChange={() => {}} onSend={() => []} />);
    await waitFor(() => expect(screen.getByTestId('agent-session-current')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('agent-session-current'));
    fireEvent.click(screen.getByTestId('agent-session-rename-s1'));
    await waitFor(() => expect(screen.getByText('新名字')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('agent-session-current'));
    fireEvent.click(screen.getByTestId('agent-session-del-s1'));
    await waitFor(() => expect(screen.queryByText('新名字')).not.toBeInTheDocument());
    vi.restoreAllMocks();
  });
});

describe('ConfirmDialog', () => {
  it('确认与取消回调', () => {
    const onConfirm = vi.fn(); const onCancel = vi.fn();
    render(<ConfirmDialog open title="删除节点" body="确定删除 SHOT 01？" onConfirm={onConfirm} onCancel={onCancel} />);
    expect(screen.getByText('删除节点')).toBeInTheDocument();
    fireEvent.click(screen.getByText('确认删除'));
    expect(onConfirm).toHaveBeenCalled();
    fireEvent.click(screen.getByText('取消'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('open=false 不渲染', () => {
    const { container } = render(
      <ConfirmDialog open={false} title="x" body="y" onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(container.querySelector('.dialog-mask')).toBeNull();
  });
});

describe('AgentPanel 模型下拉', () => {
  it('渲染模型选择器并可切换回调', () => {
    const onModelChange = vi.fn();
    render(<AgentPanel
      chips={[]}
      onChipsChange={() => {}}
      onSend={() => []}
      models={[{ id: 'deepseek/deepseek-v4-flash', provider: 'deepseek', thinking: true }]}
      selectedModel=""
      onModelChange={onModelChange}
    />);
    const select = screen.getByLabelText('选择模型');
    expect(select).toBeInTheDocument();
    expect(screen.getByText(/deepseek-v4-flash/)).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'deepseek/deepseek-v4-flash' } });
    expect(onModelChange).toHaveBeenCalledWith('deepseek/deepseek-v4-flash');
  });

  it('渲染思考强度选择器（默认 + 7 级）并可切换回调', () => {
    const onChange = vi.fn();
    render(<AgentPanel
      chips={[]}
      onChipsChange={() => {}}
      onSend={() => []}
      models={[{ id: 'deepseek/deepseek-v4-flash', provider: 'deepseek', thinking: true }]}
      selectedModel=""
      onModelChange={() => {}}
      thinkingLevel=""
      onThinkingLevelChange={onChange}
    />);
    const sel = screen.getByLabelText('思考强度');
    expect(sel).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '思考：默认' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '思考：关闭' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '思考：高' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '思考：最大' })).toBeInTheDocument();
    fireEvent.change(sel, { target: { value: 'high' } });
    expect(onChange).toHaveBeenCalledWith('high');
  });

  it('渲染 agent 活动回传行（MCP 工具调用 → WS）', () => {
    render(<AgentPanel
      chips={[]}
      onChipsChange={() => {}}
      onSend={() => []}
      activity={{ text: 'agent → node.create SHOT 01', at: 1700000000000 }}
    />);
    expect(screen.getByText(/agent → node.create SHOT 01/)).toBeInTheDocument();
    // 无活动时不渲染活动行
    const { container } = render(<AgentPanel chips={[]} onChipsChange={() => {}} onSend={() => []} activity={null} />);
    expect(container.querySelector('.agent-activity')).toBeNull();
  });
});
