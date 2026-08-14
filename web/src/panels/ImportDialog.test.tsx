import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ImportDialog } from './ImportDialog';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes('/api/workspace/list')) {
      return new Response(JSON.stringify({ paths: ['mmh3/shot_01.md', 'global_prompt.txt', 'mmh3/'] }), { status: 200 });
    }
    if (u.includes('/api/import')) {
      return new Response(JSON.stringify({ node: { id: 'n1' } }), { status: 201 });
    }
    return new Response('{}', { status: 404 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('ImportDialog', () => {
  it('打开后列出工作区文件（不含目录）', async () => {
    render(<ImportDialog open onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('mmh3/shot_01.md')).toBeInTheDocument());
    expect(screen.getByText('global_prompt.txt')).toBeInTheDocument();
    expect(screen.queryByText('mmh3/')).not.toBeInTheDocument();
  });

  it('选择文件导入并关闭', async () => {
    const onClose = vi.fn();
    render(<ImportDialog open onClose={onClose} />);
    await waitFor(() => expect(screen.getByText('global_prompt.txt')).toBeInTheDocument());
    fireEvent.click(screen.getByText('global_prompt.txt'));
    fireEvent.click(screen.getByText('导入'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // 校验 POST /api/import body
    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls;
    const importCall = calls.find((c) => String(c[0]).includes('/api/import'))!;
    expect(JSON.parse((importCall[1] as RequestInit).body as string).path).toBe('global_prompt.txt');
  });

  it('导入成功后再次打开可继续导入（busy 已重置）', async () => {
    const onClose = vi.fn();
    const { rerender } = render(<ImportDialog open onClose={onClose} />);
    await waitFor(() => expect(screen.getByText('global_prompt.txt')).toBeInTheDocument());
    // 第一次导入
    fireEvent.click(screen.getByText('global_prompt.txt'));
    fireEvent.click(screen.getByText('导入'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    // 父组件保持挂载：关闭再重开（模拟用户再次打开对话框）
    rerender(<ImportDialog open={false} onClose={onClose} />);
    rerender(<ImportDialog open onClose={onClose} />);
    await waitFor(() => expect(screen.getByText('global_prompt.txt')).toBeInTheDocument());
    // 第二次导入：按钮必须可用且能再次触发
    fireEvent.click(screen.getByText('global_prompt.txt'));
    const importBtn = screen.getByText('导入');
    expect(importBtn).not.toBeDisabled();
    fireEvent.click(importBtn);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.filter((c) => String(c[0]).includes('/api/import'))).toHaveLength(2);
  });
});
