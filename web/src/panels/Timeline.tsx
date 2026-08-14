import { useEffect, useState } from 'react';
import { client } from '../api/client';
import { useGraphStore } from '../store/graph';
import type { SnapshotMeta } from '../types';

// 版本时间线：快照列表 + 选中详情 + 回滚回调
// 监听画布图变化自动刷新快照列表（回滚后 WS 回推 graph 触发刷新）
export function Timeline({ onRollback }: { onRollback?: (seq: number) => void } = {}) {
  const [snaps, setSnaps] = useState<SnapshotMeta[]>([]);
  const [selected, setSelected] = useState<SnapshotMeta | null>(null);
  const graph = useGraphStore((s) => s.graph);

  const refresh = () => void client.listSnapshots().then(setSnaps).catch(() => setSnaps([]));
  useEffect(refresh, [graph]);

  return (
    <div className="timeline">
      <div className="tl-head">
        <span className="tl-title">版本时间线</span>
        <span className="tl-sub">自动快照 · 点击快照查看详情</span>
      </div>
      <div className="tl-ruler">
        <span className="tick" style={{ left: 0 }}>00:00.000</span>
        <span className="tick" style={{ left: '50%' }}>00:05.625</span>
        <span className="tick" style={{ left: '100%' }}>00:11.250</span>
      </div>
      <div className="tl-track">
        {snaps.map((s, i) => (
          <div
            key={s.seq}
            className={`snap ${selected?.seq === s.seq ? 'sel' : ''}`}
            style={{ left: `${8 + (i * 80) / Math.max(snaps.length, 1)}%` }}
            title={s.reason}
            onClick={() => setSelected(selected?.seq === s.seq ? null : s)}
          >
            <span className="tip">SN-{String(s.seq).padStart(3, '0')} · {s.actor}</span>
          </div>
        ))}
        <div className="playhead"><span className="ph-tip">▶</span></div>
      </div>
      {selected && (
        <div className="tl-detail">
          <span>SN-{String(selected.seq).padStart(3, '0')}</span>
          <span>{selected.actor}</span>
          <span>{new Date(selected.ts).toLocaleString('zh-CN')}</span>
          <span className="tl-reason">{selected.reason}</span>
          {onRollback && (
            <button className="btn-ghost" onClick={() => onRollback(selected.seq)}>回滚到此</button>
          )}
        </div>
      )}
    </div>
  );
}
