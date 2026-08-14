import { useEffect, useState } from 'react';
import { client } from '../api/client';
import { useGraphStore } from '../store/graph';
import type { SnapshotMeta } from '../types';

// 版本历史（方案 A：与剧情时间轴分离）：
// 快照 = 墙钟时间上的版本事件（谁、何时、为何修改了画布），按时间倒序列表展示，
// 与剧情时间无关；点击行选中后可回滚到该版本。
// 监听画布图变化自动刷新（回滚后 WS 回推 graph 触发刷新）。
export function VersionsList({ onRollback }: { onRollback?: (seq: number) => void } = {}) {
  const [snaps, setSnaps] = useState<SnapshotMeta[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const graph = useGraphStore((s) => s.graph);

  const refresh = () => void client.listSnapshots().then(setSnaps).catch(() => setSnaps([]));
  useEffect(refresh, [graph]);

  // 按墙钟时间倒序：最新版本在最上
  const sorted = [...snaps].sort((a, b) => b.ts - a.ts);
  const fmt = (ts: number) => new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });

  return (
    <div className="versions">
      <div className="panel-title">版本历史 <span className="mini">自动快照 · 可回滚</span></div>
      <div className="v-list">
        {sorted.map((s) => (
          <div
            key={s.seq}
            className={`v-row ${selected === s.seq ? 'sel' : ''}`}
            data-testid={`version-${s.seq}`}
            onClick={() => setSelected(selected === s.seq ? null : s.seq)}
          >
            <span className="v-sn">SN-{String(s.seq).padStart(3, '0')}</span>
            <span className={`v-actor ${s.actor}`}>{s.actor}</span>
            <span className="v-reason" title={`${s.reason} · ${new Date(s.ts).toLocaleString('zh-CN')}`}>{s.reason}</span>
            <span className="v-time">{fmt(s.ts)}</span>
            {selected === s.seq && onRollback && (
              <button
                className="v-rollback"
                onClick={(e) => { e.stopPropagation(); onRollback(s.seq); }}
              >↩ 回滚</button>
            )}
          </div>
        ))}
        {sorted.length === 0 && <div className="q-empty">暂无快照——每次修改画布自动留痕</div>}
      </div>
    </div>
  );
}
