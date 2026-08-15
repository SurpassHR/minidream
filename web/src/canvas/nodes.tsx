import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { GenStatus } from '../types';

// 连接点（Handle）：所有自定义节点渲染左右两个连接点，
// 从右侧拖出 → 到目标节点左侧松开，即可创建连线（类型按端点自动推断）
function Connectors() {
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
    </>
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
export function ShotNode(props: NodeProps) {
  const d = props.data as unknown as ShotData;
  return (
    <div className="node shot">
      <Connectors />
      <div className="node-head">
        <span>{d.title}</span>
        <span className="dur">{fmt(d.fields.duration)}</span>
      </div>
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
