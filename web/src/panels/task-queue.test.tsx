import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TaskQueue } from './TaskQueue';
import type { TaskRecord } from '../types';

const base = (id: string, status: TaskRecord['status'], label: string): TaskRecord => ({
  id, kind: 'ollama-vision', label, status, progress: status === 'success' ? 100 : 0,
  createdAt: Number(id.length), updatedAt: Number(id.length), payload: {},
});

describe('TaskQueue', () => {
  it('渲染任务状态并触发取消/重试', () => {
    const onCancel = vi.fn();
    const onRetry = vi.fn();
    render(<TaskQueue tasks={[
      base('queued-id', 'queued', '排队任务'),
      { ...base('running-id', 'running', '运行任务'), progress: 63 },
      { ...base('interrupted-id', 'interrupted', '中断任务'), error: '服务重启' },
      base('success-id', 'success', '完成任务'),
    ]} onCancel={onCancel} onRetry={onRetry} />);

    expect(screen.getByText('排队中')).toBeInTheDocument();
    expect(screen.getByText('运行中')).toBeInTheDocument();
    expect(screen.getByText('已中断')).toBeInTheDocument();
    expect(screen.getByText('已中断').parentElement).toHaveClass('task-row');
    expect(screen.getByText('已完成')).toBeInTheDocument();
    expect(screen.getByText(/63%/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消排队任务' }));
    fireEvent.click(screen.getByRole('button', { name: '重试任务' }));
    expect(onCancel).toHaveBeenCalledWith('queued-id');
    expect(onRetry).toHaveBeenCalledWith('interrupted-id');
  });

  it('空队列显示空态', () => {
    render(<TaskQueue tasks={[]} onCancel={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByText('暂无任务')).toBeInTheDocument();
  });
});
