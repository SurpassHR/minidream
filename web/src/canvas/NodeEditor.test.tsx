import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NodeEditor } from './NodeEditor';

const sampleNode = {
  id: 'n1', title: 'SHOT 01', fields: { duration: '3.75s', keyframes: 'KF0→KF1' },
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ node: { id: 'n1', version: 2 } }), { status: 200 })));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('NodeEditor', () => {
  it('渲染标题与 fields JSON', () => {
    render(<NodeEditor node={sampleNode as never} onClose={() => {}} />);
    expect(screen.getByDisplayValue('SHOT 01')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /fields/i })).toHaveValue(JSON.stringify(sampleNode.fields, null, 2));
  });

  it('非法 JSON 显示错误且不提交', async () => {
    const onClose = vi.fn();
    render(<NodeEditor node={sampleNode as never} onClose={onClose} />);
    fireEvent.change(screen.getByRole('textbox', { name: /fields/i }), { target: { value: '{bad json' } });
    fireEvent.click(screen.getByText('保存'));
    expect(screen.getByText(/JSON 解析失败/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('合法编辑提交 PATCH 并关闭', async () => {
    const onClose = vi.fn();
    render(<NodeEditor node={sampleNode as never} onClose={onClose} />);
    fireEvent.change(screen.getByRole('textbox', { name: /fields/i }), { target: { value: '{"duration":"4s"}' } });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(JSON.parse((calls[0]![1] as RequestInit).body as string).patch.fields.duration).toBe('4s');
  });

  it('切换节点（key 变化）时面板重挂载并显示新节点内容', () => {
    // 对应 CanvasView 中 <NodeEditor key={selected.id} ...>：选中节点切换时强制重挂载，
    // 避免 React 复用实例导致显示旧节点内容但保存到新节点（P1 数据错乱）
    const nodeA = { id: 'n1', title: 'SHOT 01', fields: { duration: '3.75s' } };
    const nodeB = { id: 'n2', title: 'SHOT 02', fields: { duration: '4s' } };
    const { rerender } = render(<NodeEditor key={nodeA.id} node={nodeA as never} onClose={() => {}} />);
    expect(screen.getByDisplayValue('SHOT 01')).toBeInTheDocument();

    rerender(<NodeEditor key={nodeB.id} node={nodeB as never} onClose={() => {}} />);
    // 重挂载后 state 重置为新节点内容：标题与 fields 均为 nodeB 的值
    expect(screen.getByDisplayValue('SHOT 02')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /fields/i })).toHaveValue(JSON.stringify(nodeB.fields, null, 2));
    expect(screen.queryByDisplayValue('SHOT 01')).not.toBeInTheDocument();
  });
});
