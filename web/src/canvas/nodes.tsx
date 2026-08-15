import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { GenStatus } from '../types';
import { useGraphStore } from '../store/graph';

// 连接点（Handle）：普通节点渲染左右两个连接点，
// 从右侧拖出 → 到目标节点左侧松开，即可创建连线（类型按端点自动推断）
function Connectors() {
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
    </>
  );
}

// —— 分镜节点左侧多接口圆点 ——
// 分镜是串联剧情与素材的节点：左侧按 剧情/文字/视频/图像 分组提供输入接口圆点。
// - 剧情（chain）：shot→shot 链式参考专用，固定 1 个（chain 线性约束至多一个入链）
// - 文字/视频/图像（素材）：每组初始 1 个，被占用时自动追加，始终保证至少 1 个空闲
// 圆点 id 形如 chain-0 / text-0 / video-1 / image-0，持久化在边的 targetHandle 上。
// 圆点带类型校验：文字/视频/图像接口只接受对应素材类型的源节点（见 inletGroupOf）
const INLET_GROUPS = [
  { key: 'chain', label: '剧情', fixed: true },
  { key: 'text', label: '文字', fixed: false },
  { key: 'video', label: '视频', fixed: false },
  { key: 'image', label: '图像', fixed: false },
] as const;

export type InletGroup = (typeof INLET_GROUPS)[number]['key'];

// 源节点 → 素材接口组（文字/视频/图像）：prompt/script/subject 等文本类 → 文字；
// keyframe/图片素材 → 图像；视频素材/generation 产物 → 视频；未知类型宽松归文字
export function inletGroupOf(node: { type: string; fields?: Record<string, unknown> } | undefined): 'text' | 'video' | 'image' {
  if (!node) return 'text';
  switch (node.type) {
    case 'keyframe': return 'image';
    case 'generation': return 'video';
    case 'asset': {
      const kind = node.fields?.assetKind;
      if (kind === 'img') return 'image';
      if (kind === 'vid') return 'video';
      return 'text'; // txt / 未知 → 文字
    }
    default: return 'text'; // prompt/script/subject/params/project
  }
}

export const INLET_LABELS: Record<string, string> = { chain: '剧情', text: '文字', video: '视频', image: '图像' };

// 解析目标 handle id：'text-2' → { group: 'text', idx: 2 }
// 缺失/旧边（无 targetHandle）由 toFlowEdge 按源类型补齐（前端渲染层）
function parseInletHandle(h: string | undefined): { group: string; idx: number } {
  if (!h) return { group: 'text', idx: 0 };
  const m = /^([a-z]+)-(\d+)$/.exec(h);
  return m ? { group: m[1], idx: Number(m[2]) } : { group: h, idx: 0 };
}

// 每组渲染圆点数：fixed 组固定 1 个（剧情）；素材组至少 1 个（初始），
// 且始终比最大占用序号多 1 个空闲可拖
// 例：无占用 → 1；占 text-0 → 2；占 text-0/text-1 → 3；仅占 text-1 → 3（text-0 空闲）
function inletCount(occupied: number[], fixed: boolean): number {
  if (fixed) return 1;
  const maxOcc = occupied.length ? Math.max(...occupied) : -1;
  return Math.max(maxOcc + 2, 1);
}

// 分镜节点左侧接口区：按当前入边占用情况渲染四组带标签的圆点
function ShotInlets({ nodeId }: { nodeId: string }) {
  const edges = useGraphStore((s) => s.graph?.edges ?? []);
  const inEdges = edges.filter((e) => e.target === nodeId);
  const rows: Array<{ key: string; label: string; idx: number }> = [];
  for (const g of INLET_GROUPS) {
    const occupied = inEdges
      .filter((e) => parseInletHandle(e.targetHandle).group === g.key)
      .map((e) => parseInletHandle(e.targetHandle).idx);
    for (let i = 0; i < inletCount(occupied, g.fixed); i++) {
      rows.push({ key: g.key, label: g.label, idx: i });
    }
  }
  return (
    <div className="shot-inlets">
      {rows.map((r) => (
        <div key={`${r.key}-${r.idx}`} className="inlet" data-group={r.key}>
          <span className="inlet-label">{r.label}</span>
          <Handle id={`${r.key}-${r.idx}`} type="target" position={Position.Left} />
        </div>
      ))}
    </div>
  );
}

export interface ShotData { title: string; fields: Record<string, unknown>; addChip?: () => void }
export interface GenData {
  title: string; status?: GenStatus; progress?: number;
  timecode?: string; result?: { videoPath: string; lastFramePath: string };
  onSubmit?: () => void;
  addChip?: () => void;
}

function fmt(v: unknown): string { return String(v ?? ''); }

// 分镜节点：场记板黑白斜纹头 + 时长徽章（签名元素 ②）
// 标题置顶；其下方为左侧多接口圆点（文字/视频/图像，见 ShotInlets），右侧单输出点（chain 出）
export function ShotNode(props: NodeProps) {
  const d = props.data as unknown as ShotData;
  return (
    <div className="node shot">
      <Handle type="source" position={Position.Right} />
      <div className="node-head">
        <span>{d.title}</span>
        <span className="dur">{fmt(d.fields.duration)}</span>
      </div>
      <ShotInlets nodeId={props.id} />
      <div className="node-body">{fmt(d.fields.summary)}</div>
      <div className="node-foot">
        <span className="k">{fmt(d.fields.keyframes)}</span>
        <span>{fmt(d.fields.timeline)}</span>
        <button className="push" onClick={(e) => { e.stopPropagation(); d.addChip?.(); }}>⇢ 加入对话</button>
      </div>
    </div>
  );
}

// 生成节点：监视器样式（签名元素 ③）
export function GenerationNode(props: NodeProps) {
  const d = props.data as unknown as GenData;
  const running = d.status === 'running';
  const success = d.status === 'success';
  return (
    <div className={`node gen ${d.status ?? ''}`}>
      <Connectors />
      <div className="node-head">
        <span>🎥 {d.title}</span>
        <span className={`gen-tag ${success ? 'ok' : running ? 'run' : ''}`}>
          {success ? '✓ 完成' : running ? `${d.progress ?? 0}%` : '排队'}
        </span>
      </div>
      <div className="screen">
        <div className={`rec ${running ? 'live' : ''}`}>
          <span className="dot" />{running ? 'REC' : success ? 'DONE' : 'WAIT'}
        </div>
        {running && <div className="bar"><i style={{ width: `${d.progress ?? 0}%` }} /></div>}
        {running && <div className="tc">{d.timecode}</div>}
        {success && d.result && <div className="tc">{d.result.videoPath}</div>}
      </div>
      {/* 生成提交入口：非 running 状态显示提交按钮（App 经确认门后提交） */}
      {d.status !== 'running' && (
        <div className="node-foot">
          <button
            className="gen-submit"
            onClick={(e) => { e.stopPropagation(); d.onSubmit?.(); }}
          >▶ 提交生成</button>
          <button className="push" onClick={(e) => { e.stopPropagation(); d.addChip?.(); }}>⇢ 加入对话</button>
        </div>
      )}
      {d.status === 'running' && (
        <div className="node-foot">
          <button className="push" onClick={(e) => { e.stopPropagation(); d.addChip?.(); }}>⇢ 加入对话</button>
        </div>
      )}
    </div>
  );
}

// 关键帧节点：缩略图
export function KeyframeNode(props: NodeProps) {
  const d = props.data as unknown as ShotData;
  const thumbs = (d.fields.thumbs as string[] | undefined) ?? [];
  return (
    <div className="node kf">
      <Connectors />
      <div className="node-head">🖼 {d.title}</div>
      {thumbs.map((t, i) => (
        <div key={i} className={`thumb ${t}`}>
          <span className="kf-label">{fmt((d.fields.labels as unknown[] | undefined)?.[i] ?? t)}</span>
        </div>
      ))}
      <div className="node-foot">{fmt(d.fields.note)}
        <button className="push" onClick={(e) => { e.stopPropagation(); d.addChip?.(); }}>⇢ 加入对话</button>
      </div>
    </div>
  );
}

// 参数节点：等宽参数表
export function ParamsNode(props: NodeProps) {
  const d = props.data as unknown as ShotData;
  const entries = Object.entries((d.fields.params as Record<string, unknown>) ?? {});
  return (
    <div className="node params">
      <Connectors />
      <div className="node-head">⚙ {d.title}</div>
      <div className="node-body">
        {entries.map(([k, v]) => (
          <div key={k}><span className="pk">{k}</span> <span className="pv">{fmt(v)}</span></div>
        ))}
      </div>
      <div className="node-foot">
        <button className="push" onClick={(e) => { e.stopPropagation(); d.addChip?.(); }}>⇢ 加入对话</button>
      </div>
    </div>
  );
}

// 通用节点：project/script/subject/prompt/asset
function GenericNode(props: NodeProps) {
  const d = props.data as unknown as ShotData;
  return (
    <div className="node">
      <Connectors />
      <div className="node-head">{d.title}</div>
      <div className="node-body">{fmt(d.fields.summary ?? d.fields.content)}</div>
      <div className="node-foot">
        <button className="push" onClick={(e) => { e.stopPropagation(); d.addChip?.(); }}>⇢ 加入对话</button>
      </div>
    </div>
  );
}

export const nodeTypes = {
  shot: ShotNode,
  generation: GenerationNode,
  keyframe: KeyframeNode,
  params: ParamsNode,
  project: GenericNode,
  script: GenericNode,
  subject: GenericNode,
  prompt: GenericNode,
  asset: GenericNode,
};
