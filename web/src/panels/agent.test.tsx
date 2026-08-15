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
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => sseResponse(['分析中', '——结论：节奏递进']))); });
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
    expect(onSend).toHaveBeenCalledWith('第一行', []);
    expect(box.value).toBe('');
  });

  it('agent 回复按 Markdown 渲染；用户消息保持纯文本', async () => {    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(['**重点** `code` 与 [链接](http://x)'])));
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
        if (String(url).includes('/api/agent/history')) {
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
