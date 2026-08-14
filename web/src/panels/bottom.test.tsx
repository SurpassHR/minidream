import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentPanel } from './AgentPanel';
import { GenQueue } from './GenQueue';
import { Timeline } from './Timeline';

describe('AgentPanel', () => {
  it('渲染 chips 且可删除', () => {
    const onChipsChange = vi.fn();
    render(<AgentPanel
      chips={['@ shot_02', '@ keyframe KF1']}
      onChipsChange={onChipsChange}
      onSend={() => []}
    />);
    expect(screen.getByText('@ shot_02')).toBeInTheDocument();
    fireEvent.click(screen.getAllByText('✕')[0]!);
    expect(onChipsChange).toHaveBeenCalled();
  });

  it('发送消息走 onSend 且回显消息流', () => {
    const onSend = vi.fn((text: string, _chips: string[]) => {
      return [{ who: 'user' as const, text }, { who: 'agent' as const, text: '（演示）收到' }];
    });
    render(<AgentPanel chips={[]} onChipsChange={() => {}} onSend={onSend} />);
    fireEvent.change(screen.getByPlaceholderText(/对画布提问/), { target: { value: '分析分镜节奏' } });
    fireEvent.click(screen.getByText('发送'));
    expect(onSend).toHaveBeenCalledWith('分析分镜节奏', []);
    expect(screen.getByText('分析分镜节奏')).toBeInTheDocument();
  });
});

describe('GenQueue', () => {
  it('渲染三种状态任务行', () => {
    render(<GenQueue tasks={[
      { id: 'g1', status: 'success', progress: 100, result: { videoPath: 'out/g1.mp4', lastFramePath: '' } },
      { id: 'g2', status: 'running', progress: 47 },
      { id: 'g3', status: 'queued', progress: 0 },
    ]} />);
    expect(screen.getByText('✓')).toBeInTheDocument();
    expect(screen.getByText('●')).toBeInTheDocument();
    expect(screen.getByText(/47%/)).toBeInTheDocument();
    expect(screen.getByText(/out\/g1\.mp4/)).toBeInTheDocument();
  });
});

describe('Timeline 交互', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ snapshots: [
      { seq: 1, ts: 1, actor: 'user', reason: '创建 SHOT 01' },
      { seq: 2, ts: 2, actor: 'agent', reason: '更新分镜' },
    ] }), { status: 200 })));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('点击快照点显示详情与回滚按钮', async () => {
    const onRollback = vi.fn();
    render(<Timeline onRollback={onRollback} />);
    await waitFor(() => expect(screen.getByText(/SN-001/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/SN-001/));
    expect(screen.getByText(/创建 SHOT 01/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('回滚到此'));
    expect(onRollback).toHaveBeenCalledWith(1);
  });
});
