import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { NodeProps } from '@xyflow/react';
import { ReactFlowProvider } from '@xyflow/react';
import { ShotNode, GenerationNode } from './nodes';

// React Flow 节点组件要求包在 Provider 里；NodeProps 测试中用 cast 补齐运行时必填字段
function wrap(el: ReactNode) {
  return <ReactFlowProvider>{el}</ReactFlowProvider>;
}

const np = (data: Record<string, unknown>): NodeProps => ({
  id: 'x', data, type: 'shot', selected: false, dragging: false, zIndex: 0,
  isConnectable: true, positionAbsoluteX: 0, positionAbsoluteY: 0,
}) as unknown as NodeProps;

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
