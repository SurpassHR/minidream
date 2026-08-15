import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { NodeProps } from '@xyflow/react';
import { ReactFlowProvider } from '@xyflow/react';
import { ShotNode, GenerationNode } from './nodes';
import { useGraphStore } from '../store/graph';

// React Flow 节点组件要求包在 Provider 里；NodeProps 测试中用 cast 补齐运行时必填字段
function wrap(el: ReactNode) {
  return <ReactFlowProvider>{el}</ReactFlowProvider>;
}

const np = (data: Record<string, unknown>): NodeProps => ({
  id: 's1', data, type: 'shot', selected: false, dragging: false, zIndex: 0,
  isConnectable: true, positionAbsoluteX: 0, positionAbsoluteY: 0,
}) as unknown as NodeProps;

// ShotNode 通过 useGraphStore 读取入边（决定左侧接口圆点数量）：注入含边的图
function setGraphWithEdges(edges: Array<{ targetHandle?: string }>) {
  useGraphStore.setState({
    graph: {
      projectName: 't',
      nodes: [{ id: 's1', type: 'shot', title: 'SHOT 01', fields: {}, position: { x: 0, y: 0 }, version: 1 }],
      edges: edges.map((e, i) => ({ id: `e${i}`, kind: 'ref' as const, source: `src${i}`, target: 's1', ...e })),
    },
  });
}

function targetHandles(): number {
  return document.querySelectorAll('.react-flow__handle.target').length;
}

beforeEach(() => {
  useGraphStore.setState({ graph: null, tasks: new Map(), chips: [] });
});

afterEach(() => {
  cleanup();
  useGraphStore.setState({ graph: null, tasks: new Map(), chips: [] });
});

describe('ShotNode 场记板签名', () => {
  it('渲染标题、时长徽章与关键帧', () => {
    render(wrap(
      <ShotNode {...np({ title: 'SHOT 01', fields: { duration: '3.75s · 90f', keyframes: 'KF0→KF1', timeline: '00:00.000' } })} />,
    ));
    expect(screen.getByText('SHOT 01')).toBeInTheDocument();
    expect(screen.getByText('3.75s · 90f')).toBeInTheDocument();
    expect(screen.getByText(/KF0→KF1/)).toBeInTheDocument();
  });
});

describe('ShotNode 左侧多接口圆点（剧情/文字/视频/图像）', () => {
  it('无入边时每组各有 1 个圆点，带类型标签', () => {
    setGraphWithEdges([]);
    render(wrap(<ShotNode {...np({ title: 'SHOT 01', fields: {} })} />));
    expect(targetHandles()).toBe(4);
    expect(screen.getAllByText('剧情')).toHaveLength(1);
    expect(screen.getAllByText('文字')).toHaveLength(1);
    expect(screen.getAllByText('视频')).toHaveLength(1);
    expect(screen.getAllByText('图像')).toHaveLength(1);
  });

  it('文字圆点被占用时自动追加新文字圆点（其余组不变）', () => {
    setGraphWithEdges([{ targetHandle: 'text-0' }]);
    render(wrap(<ShotNode {...np({ title: 'SHOT 01', fields: {} })} />));
    expect(targetHandles()).toBe(5); // chain-0 + text-0/text-1 + video-0 + image-0
    expect(screen.getAllByText('剧情')).toHaveLength(1);
    expect(screen.getAllByText('文字')).toHaveLength(2);
    expect(screen.getAllByText('视频')).toHaveLength(1);
    expect(screen.getAllByText('图像')).toHaveLength(1);
  });

  it('多组同时占用时各自追加（文字×2 + 视频×1）', () => {
    setGraphWithEdges([{ targetHandle: 'text-0' }, { targetHandle: 'text-1' }, { targetHandle: 'video-0' }]);
    render(wrap(<ShotNode {...np({ title: 'SHOT 01', fields: {} })} />));
    expect(targetHandles()).toBe(7); // chain-0 + text-0/1/2 + video-0/1 + image-0
    expect(screen.getAllByText('文字')).toHaveLength(3);
    expect(screen.getAllByText('视频')).toHaveLength(2);
    expect(screen.getAllByText('图像')).toHaveLength(1);
  });

  it('剧情接口固定 1 个（chain 入链占用后不追加）', () => {
    setGraphWithEdges([{ targetHandle: 'chain-0' }]);
    render(wrap(<ShotNode {...np({ title: 'SHOT 01', fields: {} })} />));
    expect(targetHandles()).toBe(4);
    expect(screen.getAllByText('剧情')).toHaveLength(1);
  });

  it('旧边（无 targetHandle）按源类型归入对应接口', () => {
    // 无 targetHandle 的边在渲染层由 toFlowEdge 补齐（此处入边视为 text 组）
    setGraphWithEdges([{}]);
    render(wrap(<ShotNode {...np({ title: 'SHOT 01', fields: {} })} />));
    expect(targetHandles()).toBe(5);
  });

  it('非连续占用（仅 text-1）时仍保证至少一个空闲圆点', () => {
    setGraphWithEdges([{ targetHandle: 'text-1' }]);
    render(wrap(<ShotNode {...np({ title: 'SHOT 01', fields: {} })} />));
    // 渲染 text-0/1/2：text-0 空闲、text-1 占用、text-2 空闲
    expect(targetHandles()).toBe(6);
    expect(screen.getAllByText('文字')).toHaveLength(3);
  });
});

describe('GenerationNode 监视器签名', () => {
  it('运行中显示 REC 与进度条', () => {
    render(wrap(
      <GenerationNode {...np({ title: '生成 SEG-01', status: 'running', progress: 47, timecode: '00:01.780 / 00:03.750' })} />,
    ));
    expect(screen.getByText('REC')).toBeInTheDocument();
    expect(screen.getByText('47%')).toBeInTheDocument();
  });

  it('完成态显示 DONE 与结果路径', () => {
    render(wrap(
      <GenerationNode {...np({ title: '生成 SEG-01', status: 'success', result: { videoPath: 'out/g1.mp4', lastFramePath: '' } })} />,
    ));
    expect(screen.getByText('DONE')).toBeInTheDocument();
    expect(screen.getByText(/out\/g1\.mp4/)).toBeInTheDocument();
  });

  it('generation 节点渲染提交生成按钮并触发回调', () => {
    const onSubmit = vi.fn();
    render(wrap(
      <GenerationNode {...np({ title: '生成 SEG-01', status: 'queued', onSubmit })} />,
    ));
    const btn = screen.getByText('▶ 提交生成');
    fireEvent.click(btn);
    expect(onSubmit).toHaveBeenCalled();
  });

  it('running 状态不渲染提交按钮', () => {
    render(wrap(
      <GenerationNode {...np({ title: '生成 SEG-01', status: 'running', progress: 30 })} />,
    ));
    expect(screen.queryByText('▶ 提交生成')).not.toBeInTheDocument();
  });
});
