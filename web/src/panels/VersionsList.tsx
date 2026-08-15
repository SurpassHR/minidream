import { useEffect, useState } from 'react';
import { client } from '../api/client';
import { useGraphStore } from '../store/graph';
import type { SnapshotMeta } from '../types';

// 版本历史（方案 A：与剧情时间轴分离）：
// 快照 = 墙钟时间上的版本事件（谁、何时、为何修改了画布），按时间倒序列表展示。
// 点击快照行 = 直接回滚到该版本（免确认，不追加新快照）；
// 当前 HEAD 之后的快照为“未来分支”（灰色），新操作会覆盖它们（需确认）。
// 监听画布图变化自动刷新（回滚/撤销/重做后 WS 回推 graph 触发刷新）。
export function VersionsList({ onRollback }: { onRollback?: (seq: number) => void } = {}) {
  const [snaps, setSnaps] = useState<SnapshotMeta[]>([]);
  const [head, setHead] = useState<number>(0);
  const graph = useGraphStore((s) => s.graph);

  const refresh = () => void client.listSnapshots().then((r) => {
    setSnaps(r.snapshots);
    setHead(r.headSeq);
  }).catch(() => setSnaps([]));
  useEffect(refresh, [graph]);

  // 按墙钟时间倒序：最新版本在最上
  const sorted = [...snaps].sort((a, b) => b.ts - a.ts);
  const fmt = (ts: number) => new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });

  return (
    <div className="versions">
      <div className="panel-title">版本历史 <span className="mini">自动快照 · 点击回滚</span></div>
      <div className="v-list">
        {sorted.map((s) => {
          const isFuture = s.seq > head; // 未来分支（灰色）：当前 HEAD 之后的快照
          return (
            <div
              key={s.seq}
              className={`v-row ${s.seq === head ? 'sel' : ''} ${isFuture ? 'future' : ''}`}
              data-testid={`version-${s.seq}`}
              title={isFuture ? '未来分支（灰色）：新操作将覆盖它' : `点击回滚到 ${s.reason}`}
              onClick={() => onRollback?.(s.seq)}
            >
              <span className="v-sn">SN-{String(s.seq).padStart(3, '0')}</span>
              <span className={`v-actor ${s.actor}`}>{s.actor}</span>
              <span className="v-reason" title={`${s.reason} · ${new Date(s.ts).toLocaleString('zh-CN')}`}>{s.reason}</span>
              <span className="v-time">{fmt(s.ts)}</span>
              {isFuture && <span className="v-future">未来</span>}
            </div>
          );
        })}
        {sorted.length === 0 && <div className="q-empty">暂无快照——每次修改画布自动留痕</div>}
      </div>
    </div>
  );
}
