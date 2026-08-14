import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentPanel } from './AgentPanel';
import { GenQueue } from './GenQueue';
import { Timeline } from './Timeline';
import { VersionsList } from './VersionsList';
import { useGraphStore } from '../store/graph';

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

describe('Timeline 剧情时间轴', () => {
  beforeEach(() => {
    // 清空画布图 store，避免用例间串扰
    useGraphStore.setState({ graph: null });
  });

  it('有分镜节点时渲染剧情时间轴（SEG + 真实时间码标尺 + 播放头）', async () => {
    useGraphStore.setState({
      graph: {
        projectName: 't',
        nodes: [
          { id: 'n1', type: 'shot', title: 'SHOT 01', fields: { duration: '3.75s', start: 0 }, position: { x: 0, y: 0 }, version: 1 },
          { id: 'n2', type: 'shot', title: 'SHOT 02', fields: { duration: 3.75, start: 3.75 }, position: { x: 0, y: 0 }, version: 1 },
          { id: 'n3', type: 'shot', title: 'SHOT 03', fields: { frames: 90, fps: 24 }, position: { x: 0, y: 0 }, version: 1 },
        ],
        edges: [],
      },
    });
    render(<Timeline />);
    await waitFor(() => expect(screen.getByText(/SEG 01/)).toBeInTheDocument());
    expect(screen.getByText(/SEG 02/)).toBeInTheDocument();
    expect(screen.getByText(/SEG 03/)).toBeInTheDocument();
    // 标尺显示真实总时长时间码（3 × 3.75 = 11.25s；播放头提示同值，取标尺刻度）
    expect(document.querySelectorAll('.tl-ruler .tick')[3]).toHaveTextContent('00:11.250');
    // 播放头定位在故事末尾并标注总时长
    expect(document.querySelector('.playhead .ph-tip')).toHaveTextContent('00:11.250');
    // 时间轴不再渲染快照标记（快照已移至版本历史面板）
    expect(screen.queryByText(/SN-001/)).not.toBeInTheDocument();
  });

  it('无分镜节点时显示空态提示', () => {
    render(<Timeline />);
    expect(screen.getByText(/暂无分镜/)).toBeInTheDocument();
  });
});

describe('VersionsList 版本历史', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ snapshots: [
      { seq: 1, ts: 1000, actor: 'user', reason: '创建 SHOT 01' },
      { seq: 2, ts: 2000, actor: 'agent', reason: '更新分镜' },
      { seq: 3, ts: 1500, actor: 'user', reason: '移动节点' },
    ] }), { status: 200 })));
    useGraphStore.setState({ graph: null });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('按墙钟时间倒序渲染版本行（最新在上）', async () => {
    render(<VersionsList />);
    await waitFor(() => expect(screen.getByText('SN-003')).toBeInTheDocument());
    const rows = document.querySelectorAll('.v-row');
    expect(rows).toHaveLength(3);
    // 倒序：SN-002（ts 最大）在最上
    expect(rows[0]!.textContent).toContain('SN-002');
    expect(rows[1]!.textContent).toContain('SN-003');
    expect(rows[2]!.textContent).toContain('SN-001');
  });

  it('点击行选中出现回滚按钮，触发 onRollback(seq)', async () => {
    const onRollback = vi.fn();
    render(<VersionsList onRollback={onRollback} />);
    await waitFor(() => expect(screen.getByText(/创建 SHOT 01/)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('version-1'));
    const btn = screen.getByText('↩ 回滚');
    fireEvent.click(btn);
    expect(onRollback).toHaveBeenCalledWith(1);
  });

  it('无快照时显示空态', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ snapshots: [] }), { status: 200 })));
    render(<VersionsList />);
    await waitFor(() => expect(screen.getByText(/暂无快照/)).toBeInTheDocument());
  });
});
