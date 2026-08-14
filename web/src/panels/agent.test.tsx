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
});
