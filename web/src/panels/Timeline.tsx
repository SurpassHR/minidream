import { useMemo } from 'react';
import { useGraphStore } from '../store/graph';

// 剧情时间轴（方案 A：与版本快照彻底分离）：
// 底轨 = 分镜段 SEG 按故事时间（start/时长）铺开，标尺为真实时间码，
// 播放头 = 当前故事进度（已定义分镜的总时长）。
// 版本留痕（快照）不再叠加在此轴上，见右侧"版本历史"面板。
interface Segment { title: string; start: number; duration: number }

function toNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  if (typeof v === 'string') {
    const m = v.match(/(\d+(?:\.\d+)?)/);
    if (m?.[1]) {
      const n = parseFloat(m[1]);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return null;
}

function fmtTime(sec: number): string {
  const mm = Math.floor(sec / 60);
  const s = sec - mm * 60;
  return `${String(mm).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

// 分镜时长：fields.duration（"3.75s"/3.75）或 frames/fps；缺失按 3.75s
function shotDuration(fields: Record<string, unknown>): number {
  const d = toNum(fields.duration);
  if (d !== null) return d;
  const frames = toNum(fields.frames);
  if (frames !== null) return frames / (toNum(fields.fps) ?? 24);
  return 3.75;
}

export function Timeline() {
  const graph = useGraphStore((s) => s.graph);

  // 剧情时间轴：shot 节点按 chain 边（链式参考）拓扑序排列——与 YAML segments 顺序一致；
  // 无 chain 时按 fields.start（或标题序号）排序（原有逻辑）；孤立分镜排在链后。
  const sortedShots = useMemo(() => {
    const shots = (graph?.nodes ?? []).filter((n) => n.type === 'shot');
    const chains = (graph?.edges ?? []).filter((e) => e.kind === 'chain');
    const bySource = new Map(chains.map((e) => [e.source, e.target]));
    const byTarget = new Map(chains.map((e) => [e.target, e.source]));
    const fallback = (list: typeof shots) => [...list].sort((a, b) => {
      const sa = toNum(a.fields.start);
      const sb = toNum(b.fields.start);
      if (sa !== null && sb !== null) return sa - sb;
      const ta = Number(String(a.title).match(/(\d+)/)?.[1] ?? NaN);
      const tb = Number(String(b.title).match(/(\d+)/)?.[1] ?? NaN);
      if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
      return 0;
    });
    if (chains.length === 0) return fallback(shots);
    const heads = shots.filter((s) => !byTarget.has(s.id));
    const ordered: typeof shots = [];
    for (const h of fallback(heads)) {
      let cur = h.id;
      while (cur) {
        const n = shots.find((s) => s.id === cur);
        if (n && !ordered.includes(n)) ordered.push(n);
        cur = bySource.get(cur) ?? '';
      }
    }
    const inChain = new Set(ordered.map((n) => n.id));
    ordered.push(...fallback(shots.filter((s) => !inChain.has(s.id))));
    return ordered;
  }, [graph]);

  // 剧情时间轴：shot 节点按 start（或标题序号）排序，累计时长铺轨
  const { segments, total } = useMemo(() => {
    const segs: Segment[] = [];
    if (sortedShots.length) {
      let t = 0;
      for (const s of sortedShots) {
        const start = toNum(s.fields.start);
        if (start !== null && start >= t) t = start; // 显式 start 优先（容忍重叠时取最大）
        const dur = shotDuration(s.fields);
        segs.push({ title: s.title, start: t, duration: dur });
        t += dur;
      }
    }
    return { segments: segs, total: segs.reduce((acc, s) => acc + s.duration, 0) };
  }, [sortedShots]);

  const pct = (t: number) => (total > 0 ? (t / total) * 100 : 0);
  // 1/3、2/3 用精确分数避免浮点刻度漂移（如 00:07.499 ≠ 00:07.500）
  const ticks = [0, 1 / 3, 2 / 3, 1].map((f) => (total > 0 ? fmtTime(total * f) : '—'));

  return (
    <div className="timeline">
      <div className="tl-head">
        <span className="tl-title">剧情时间轴</span>
        <span className="tl-sub">分镜 SEG 按故事时间铺开 · 版本留痕见右侧面板</span>
      </div>
      <div className="tl-ruler">
        <span className="tick" style={{ left: 0 }}>{ticks[0]}</span>
        <span className="tick" style={{ left: '33.33%' }}>{ticks[1]}</span>
        <span className="tick" style={{ left: '66.66%' }}>{ticks[2]}</span>
        <span className="tick" style={{ left: '100%' }}>{ticks[3]}</span>
      </div>
      <div className="tl-track">
        {segments.map((seg, i) => (
          <div
            key={seg.start + seg.title}
            className={`seg s${(i % 3) + 1}`}
            style={{ left: `${pct(seg.start)}%`, width: `${Math.max(pct(seg.duration), 2)}%` }}
            title={`${seg.title} · ${fmtTime(seg.start)} – ${fmtTime(seg.start + seg.duration)}`}
          >
            <span className="seg-label">SEG {String(i + 1).padStart(2, '0')} · {seg.title}</span>
          </div>
        ))}
        {segments.length === 0 && (
          <div className="tl-empty">暂无分镜——在画布创建分镜（shot）节点后显示剧情时间轴</div>
        )}
        {total > 0 && (
          <div className="playhead end" style={{ left: '100%' }} title="当前故事进度 = 全部已定义分镜的总时长">
            <span className="ph-tip">{fmtTime(total)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
