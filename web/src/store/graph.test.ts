import { describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGraphStore } from './graph';

describe('graph store', () => {
  it('applyGraph 替换图', () => {
    const { result } = renderHook(() => useGraphStore());
    act(() => result.current.applyGraph({ projectName: 'p', nodes: [], edges: [] }));
    expect(result.current.graph?.projectName).toBe('p');
  });

  it('upsertTask 更新任务且 graph 为空时不影响', () => {
    const { result } = renderHook(() => useGraphStore());
    act(() => result.current.upsertTask({ id: 'g1', status: 'running', progress: 42 }));
    expect(result.current.tasks.get('g1')?.progress).toBe(42);
  });

  it('setConnected 切换连接状态', () => {
    const { result } = renderHook(() => useGraphStore());
    act(() => result.current.setConnected(true));
    expect(result.current.connected).toBe(true);
  });

  it('addChip 去重追加、removeChip 删除', () => {
    const { result } = renderHook(() => useGraphStore());
    act(() => { result.current.addChip('@ shot_01'); result.current.addChip('@ shot_01'); result.current.addChip('@ KF1'); });
    expect(result.current.chips).toEqual(['@ shot_01', '@ KF1']);
    act(() => result.current.removeChip('@ shot_01'));
    expect(result.current.chips).toEqual(['@ KF1']);
  });
});
