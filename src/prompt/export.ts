// 画布图 → MMH3 Prompt YAML 协议（v1）映射。
// 单一事实来源：chain 边（shot→shot 链式参考）的拓扑序 = 剧情顺序 = segments 顺序；
// 无 chain 时按 fields.start / 标题序号排序（与时间线一致）。
// 校验失败（prompt 归属缺失、段数超限等）抛 DirectorError，不产出坏 YAML。
import { DirectorError } from '../types.js';
import type { DirectorEdge, DirectorNode, Graph } from '../types.js';
import { MAX_SEG_PROMPTS, promptYamlFromSegments, type PromptSegment } from './protocol.js';

// seed 策略：生成时自动填写 42（用户在 ComfyUI 中调整），
// 除非 shot 节点显式写了 fields.seed（尊重用户值）
const DEFAULT_SEED = 42;

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (typeof v === 'string') {
    const m = v.match(/(\d+(?:\.\d+)?)/);
    if (m?.[1]) {
      const n = parseFloat(m[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

// 分镜时长：fields.duration（"3.75s"/3.75）或 frames/fps；缺失按 3.75s（与 Timeline 一致）
export function shotDuration(fields: Record<string, unknown>): number {
  const d = num(fields.duration);
  if (d !== null) return d;
  const frames = num(fields.frames);
  if (frames !== null) return frames / (num(fields.fps) ?? 24);
  return 3.75;
}

// chain 线性排序：从无入链的 shot 出发沿出链走。
// 返回 { ordered, errors }：非线性（环/分支/多起点）时 errors 说明，不产出顺序。
export function chainOrder(
  graph: Graph,
): { ordered: DirectorNode[]; errors: string[] } {
  const shots = graph.nodes.filter((n) => n.type === 'shot');
  const chains = graph.edges.filter((e) => e.kind === 'chain');
  const bySource = new Map<string, string>();
  const byTarget = new Map<string, string>();
  for (const e of chains) {
    if (bySource.has(e.source)) return { ordered: [], errors: ['分镜链出现分支：一个分镜有多个后继'] };
    if (byTarget.has(e.target)) return { ordered: [], errors: ['分镜链出现分支：一个分镜有多个前驱'] };
    bySource.set(e.source, e.target);
    byTarget.set(e.target, e.source);
  }
  // 环检测：沿出链走，重复访问即成环
  const visited = new Set<string>();
  for (const s of shots) {
    if (visited.has(s.id)) continue;
    const seen = new Set<string>();
    let cur = s.id;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      cur = bySource.get(cur) ?? '';
    }
    if (cur && seen.has(cur)) return { ordered: [], errors: ['分镜链成环：剧情顺序必须线性'] };
    for (const id of seen) visited.add(id);
  }
  // 起点：无入链的 shot（多起点时按标题/start 稳定排序后连接）
  const heads = shots.filter((s) => !byTarget.has(s.id));
  if (heads.length > 1) {
    // 多起点：无 chain 的孤立分镜按现有排序规则（start/标题序号）排在其后
    const ordered: DirectorNode[] = [];
    for (const h of sortShots(heads)) {
      let cur = h.id;
      while (cur) {
        const node = shots.find((n) => n.id === cur);
        if (node) ordered.push(node);
        cur = bySource.get(cur) ?? '';
      }
    }
    return { ordered, errors: [] };
  }
  if (heads.length === 0 && shots.length > 0) {
    return { ordered: [], errors: ['分镜链成环：剧情顺序必须线性'] };
  }
  const ordered: DirectorNode[] = [];
  let cur = heads[0]?.id ?? '';
  while (cur) {
    const node = shots.find((n) => n.id === cur);
    if (node) ordered.push(node);
    cur = bySource.get(cur) ?? '';
  }
  // 无 chain 的分镜：按 start/标题序号排序，排在链后
  const inChain = new Set(ordered.map((n) => n.id));
  const rest = sortShots(shots.filter((s) => !inChain.has(s.id)));
  ordered.push(...rest);
  return { ordered, errors: [] };
}

// 无 chain 时的排序：fields.start 优先，其次标题序号（与 Timeline 现有逻辑一致）
function sortShots(shots: DirectorNode[]): DirectorNode[] {
  return [...shots].sort((a, b) => {
    const sa = num(a.fields.start);
    const sb = num(b.fields.start);
    if (sa !== null && sb !== null) return sa - sb;
    const ta = Number(String(a.title).match(/(\d+)/)?.[1] ?? NaN);
    const tb = Number(String(b.title).match(/(\d+)/)?.[1] ?? NaN);
    if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
    return 0;
  });
}

export interface YamlExportResult {
  yaml: string;
  segments: number;
}

// 画布 → 协议对象 → YAML 文本。任何结构性错误抛 DirectorError('YAML_EXPORT_FAILED')。
export function graphToPromptYaml(graph: Graph): YamlExportResult {
  const errors: string[] = [];
  const project = graph.nodes.find((n) => n.type === 'project');
  const params = graph.nodes.find((n) => n.type === 'params');
  const mode = typeof params?.fields.mode === 'string' ? params.fields.mode : undefined;
  const refs = graph.edges.filter((e) => e.kind === 'ref');

  // 共享 prompt：未被任何 shot 引用的 prompt 节点（fields.shared 显式标记优先）
  const shotsById = new Map(graph.nodes.filter((n) => n.type === 'shot').map((n) => [n.id, n]));
  const usedPromptIds = new Set(
    refs
      .filter((e) => shotsById.has(e.target))
      .map((e) => e.source),
  );
  const sharedPrompt = graph.nodes.find(
    (n) => n.type === 'prompt' && !usedPromptIds.has(n.id),
  );

  const { ordered, errors: orderErrors } = chainOrder(graph);
  errors.push(...orderErrors);

  const segments: PromptSegment[] = [];
  let anyDuration = false;
  for (const shot of ordered) {
    const seg: PromptSegment = {
      shot: Number(String(shot.title).match(/(\d+)/)?.[1] ?? undefined),
      title: shot.title,
      duration: shotDuration(shot.fields),
      seed: num(shot.fields.seed) ?? DEFAULT_SEED,
      prompt: '',
    };
    anyDuration = true;
    // 归属提示词：prompt → shot 的 ref 边（有多条时按引用先后拼接）
    const prompts = refs
      .filter((e) => e.target === shot.id && e.kind === 'ref')
      .map((e) => graph.nodes.find((n) => n.id === e.source))
      .filter((n): n is DirectorNode => n?.type === 'prompt');
    const texts = prompts.map((p) => {
      const c = p.fields.content;
      return typeof c === 'string' ? c.trim() : '';
    }).filter(Boolean);
    if (texts.length === 0) {
      errors.push(`分镜「${shot.title}」没有归属提示词：请用 ref 边把 prompt 节点连接到该分镜`);
    }
    seg.prompt = texts.join('\n');
    // 关键帧：keyframe → shot 的 ref 边（label 优先，其次标题）
    const kfs = refs
      .filter((e) => e.target === shot.id)
      .map((e) => ({ edge: e, node: graph.nodes.find((n) => n.id === e.source) }))
      .filter((x) => x.node?.type === 'keyframe');
    if (kfs.length > 0) {
      seg.keyframes = kfs.map(({ edge, node }) =>
        typeof edge.label === 'string' && edge.label ? edge.label : (node?.title ?? ''),
      );
    }
    segments.push(seg);
  }

  if (errors.length > 0) {
    throw new DirectorError('YAML_EXPORT_FAILED', errors.join('\n'));
  }
  if (segments.length > MAX_SEG_PROMPTS) {
    throw new DirectorError('YAML_EXPORT_FAILED', `分镜数 ${segments.length} 超过协议上限 ${MAX_SEG_PROMPTS}`);
  }
  // duration 全有或全无：shotDuration 恒有默认值 → 恒全有（协议规则满足）
  if (anyDuration && segments.some((s) => !(s.duration !== undefined && s.duration > 0))) {
    throw new DirectorError('YAML_EXPORT_FAILED', 'duration 必须全有或全无');
  }

  const shared = typeof sharedPrompt?.fields.content === 'string'
    ? sharedPrompt.fields.content.trim()
    : undefined;

  const yaml = promptYamlFromSegments({
    project: project?.title,
    mode,
    prompt: shared || undefined,
    segments,
  });
  return { yaml, segments: segments.length };
}

// 供测试直接引用
export { DEFAULT_SEED };
