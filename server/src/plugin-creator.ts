import type { WorkflowInput, WorkflowOutput, WorkflowParam, WorkflowSpec } from './workflow.js';
import type { WorkflowGraph, WorkflowGraphField } from './workflow-graph.js';

export interface PluginAnalysisCandidate<T> {
  candidate: T;
  confidence: number;
  reason: string;
  recommended: boolean;
}

export interface PluginAnalysisWidgetSource {
  nodeId: string;
  classType: string;
  title: string;
  /** 该上游节点上可暴露的未连接 widget 字段名 */
  fields: string[];
}

export interface PluginAnalysisWidget {
  field: WorkflowGraphField;
  exposure: 'llm' | 'fixed' | 'hidden' | 'review';
  reason: string;
  confidence: number;
  /** 仅连线字段：沿连线追溯到的上游源头节点及其可暴露 widget */
  sources?: PluginAnalysisWidgetSource[];
}

export interface PluginAnalysis {
  workflow: {
    format: 'api' | 'ui';
    nodeCount: number;
    sourceFingerprint: string;
  };
  purpose: {
    name: string;
    description: string;
    capabilities: string[];
  };
  inputs: Array<PluginAnalysisCandidate<WorkflowInput>>;
  outputs: Array<PluginAnalysisCandidate<WorkflowOutput>>;
  widgets: PluginAnalysisWidget[];
  response: {
    recommendedPromptVisibility: boolean;
    blocks: Array<{
      source: string;
      timing: 'submit' | 'complete' | 'always';
      format: 'plain' | 'markdown' | 'code';
    }>;
  };
}

export interface PluginCreatorInput {
  spec: WorkflowSpec;
  graph: WorkflowGraph;
  format?: 'api' | 'ui';
  sourceFingerprint?: string;
}

function stableFingerprint(input: PluginCreatorInput): string {
  if (input.sourceFingerprint?.trim()) return input.sourceFingerprint;
  const payload = JSON.stringify({
    id: input.spec.id,
    nodes: input.graph.nodes.map(node => ({
      nodeId: node.nodeId,
      classType: node.classType,
      fields: node.fields.map(field => ({ nodeId: field.nodeId, field: field.field, type: field.type, value: field.value, connected: field.connected })),
    })),
    edges: input.graph.edges,
  });
  // Deterministic, dependency-free fingerprint suitable for preview identity.
  let hash = 2166136261;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function inputConfidence(input: WorkflowInput): { confidence: number; reason: string } {
  if (input.primary) return { confidence: 1, reason: '工作流显式标记为主要提示词输入' };
  if (input.kind === 'image' || input.kind === 'video') return { confidence: 0.95, reason: '识别为素材输入节点' };
  return { confidence: 0.9, reason: '识别为文字提示词输入节点' };
}

function outputConfidence(output: WorkflowOutput): { confidence: number; reason: string } {
  if (output.kind === 'image' || output.kind === 'video') return { confidence: 0.95, reason: '识别为生成产物输出节点' };
  return { confidence: 0.85, reason: '识别为文本输出节点' };
}

/**
 * 连线字段不能直接注入（会破坏图结构），但可以沿连线追溯上游源头，
 * 找到真正控制该取值的可暴露 widget，供用户/LLM 决定暴露哪一个。
 */
function traceWidgetSources(graph: WorkflowGraph, field: WorkflowGraphField): PluginAnalysisWidgetSource[] {
  const nodeById = new Map(graph.nodes.map(node => [node.nodeId, node]));
  const visited = new Set<string>([`${field.nodeId}:${field.field}`]);
  let frontier = [{ nodeId: field.nodeId, field: field.field }];
  const sources: PluginAnalysisWidgetSource[] = [];
  for (let depth = 0; depth < 4 && frontier.length > 0 && sources.length < 3; depth++) {
    const next: Array<{ nodeId: string; field: string }> = [];
    for (const current of frontier) {
      const incoming = graph.edges.filter(edge => edge.targetNode === current.nodeId && edge.targetField === current.field);
      for (const edge of incoming) {
        const key = `${edge.sourceNode}:${edge.sourceField}`;
        if (visited.has(key)) continue;
        visited.add(key);
        const sourceNode = nodeById.get(edge.sourceNode);
        if (!sourceNode) continue;
        const widgets = sourceNode.fields.filter(candidate => candidate.selectable && !candidate.connected);
        if (widgets.length > 0 && !sources.some(source => source.nodeId === sourceNode.nodeId)) {
          sources.push({
            nodeId: sourceNode.nodeId,
            classType: sourceNode.classType,
            title: sourceNode.title,
            fields: widgets.slice(0, 8).map(candidate => candidate.field),
          });
        }
        // 即使当前节点已有可暴露 widget，也继续向上追溯一层：
        // 例如时长链「数学表达式 ← PrimitiveFloat(value=秒数）」中真正的用户旋钮在更上游。
        next.push({ nodeId: edge.sourceNode, field: edge.sourceField });
      }
    }
    frontier = next;
  }
  return sources.slice(0, 3);
}

const CONNECTABLE_WIDGET_TYPES = new Set(['INT', 'FLOAT', 'BOOLEAN', 'STRING', 'SEED', 'COMBO']);

function widgetExposure(field: WorkflowGraphField, params: WorkflowParam[], graph?: WorkflowGraph): PluginAnalysisWidget | null {
  // 连线字段不可直接注入，但标量类连线字段值得作为引导候选保留：
  // 提示用户去暴露驱动它的上游源头参数（如尺寸/时长计算链）。
  if (!field.selectable && field.connected && CONNECTABLE_WIDGET_TYPES.has(field.type) && graph) {
    const sources = traceWidgetSources(graph, field);
    return {
      field,
      exposure: 'review',
      confidence: 0.5,
      reason: sources.length > 0
        ? `该字段由上游连线驱动，无法直接注入；建议改为暴露其源头参数：${sources.map(source => `${source.title || source.classType}(${source.fields.join('/')})`).join('、')}`
        : '该字段由上游连线驱动，无法直接注入',
      ...(sources.length > 0 ? { sources } : {}),
    };
  }
  if (!field.selectable || field.connected) return null;
  const param = params.find(candidate => candidate.nodeId === field.nodeId && candidate.field === field.field)
    ?? params.find(candidate => candidate.field === field.field && (candidate.applyTo ?? []).includes(field.nodeId));
  if (!param) {
    return {
      field,
      exposure: 'review',
      confidence: 0.55,
      reason: '未存在于当前 manifest，需要用户确认是否暴露',
    };
  }
  if (param.hidden) return { field, exposure: 'hidden', confidence: 1, reason: '当前 manifest 将此参数标记为隐藏' };
  if (param.llm === false) return { field, exposure: 'fixed', confidence: 1, reason: '当前 manifest 将此参数固定为节点视图值' };
  return { field, exposure: 'llm', confidence: 1, reason: '当前 manifest 已将此参数暴露给 Agent' };
}

/** LLM 语义建议：只能引用已存在的候选，不能虚构结构 */
export interface PluginCreatorSuggestions {
  purpose?: {
    name?: string;
    description?: string;
    capabilities?: string[];
  };
  /** 键为 PluginAnalysis.inputs[].candidate.id */
  inputs?: Record<string, { description?: string; recommended?: boolean }>;
  /** 键为 PluginAnalysis.outputs[].candidate.id */
  outputs?: Record<string, { description?: string; recommended?: boolean }>;
  widgets?: Array<{
    nodeId: string;
    field: string;
    exposure: 'llm' | 'fixed' | 'hidden' | 'review';
    reason?: string;
  }>;
  response?: {
    recommendedPromptVisibility?: boolean;
    blocks?: Array<{
      source: string;
      timing: 'submit' | 'complete' | 'always';
      format: 'plain' | 'markdown' | 'code';
    }>;
  };
}

/** 把分析事实序列化为 LLM 输入（不含原始 JSON 与无关实现细节） */
export function serializeAnalysisForLlm(analysis: PluginAnalysis): string {
  return JSON.stringify({
    workflow: analysis.workflow,
    purpose: analysis.purpose,
    inputs: analysis.inputs.map(item => ({
      id: item.candidate.id,
      kind: item.candidate.kind,
      label: item.candidate.label,
      node: `${item.candidate.nodeId}.${item.candidate.field}`,
      classType: item.candidate.classType,
      confidence: item.confidence,
      recommended: item.recommended,
    })),
    outputs: analysis.outputs.map(item => ({
      id: item.candidate.id,
      kind: item.candidate.kind,
      label: item.candidate.label,
      node: `${item.candidate.nodeId}`,
      classType: item.candidate.classType,
      confidence: item.confidence,
      recommended: item.recommended,
    })),
    widgets: analysis.widgets.map(item => ({
      nodeId: item.field.nodeId,
      field: item.field.field,
      type: item.field.type,
      ...(item.field.connected ? { connected: true } : { value: item.field.value }),
      options: item.field.options,
      ...(item.sources ? {
        sources: item.sources.map(source => ({
          node: `${source.nodeId} (${source.title || source.classType})`,
          widgets: source.fields,
        })),
      } : {}),
      exposure: item.exposure,
      confidence: item.confidence,
    })),
    response: analysis.response,
  }, null, 2);
}

const RESPONSE_BLOCK_SOURCES = new Set(['result.image', 'result.video', 'result.text']);
const RESPONSE_BLOCK_TIMINGS = new Set(['submit', 'complete', 'always']);
const RESPONSE_BLOCK_FORMATS = new Set(['plain', 'markdown', 'code']);
const WIDGET_EXPOSURES = new Set(['llm', 'fixed', 'hidden', 'review']);

/** 从 LLM 输出提取建议 JSON（兼容 ``` 围栏与前后杂讯） */
export function parsePluginSuggestions(text: string): PluginCreatorSuggestions {
  const trimmed = text.trim();
  const candidates = [
    trimmed,
    trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]?.trim() ?? '',
    trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1),
  ];
  for (const candidate of candidates) {
    if (!candidate.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(candidate) as PluginCreatorSuggestions;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // 尝试下一个候选
    }
  }
  throw new Error('plugin-creator 未返回有效的配置建议 JSON');
}

/**
 * 把 LLM 建议合并进基础分析。
 * 结构安全：非法的候选 id / 节点字段 / 曝光值 / 回复块来源一律丢弃并记入 warnings，绝不抛错中断。
 */
export function applyPluginSuggestions(
  analysis: PluginAnalysis,
  suggestions: PluginCreatorSuggestions,
): { analysis: PluginAnalysis; warnings: string[] } {
  const warnings: string[] = [];
  const next: PluginAnalysis = JSON.parse(JSON.stringify(analysis)) as PluginAnalysis;

  if (suggestions.purpose && typeof suggestions.purpose === 'object') {
    const { name, description, capabilities } = suggestions.purpose;
    if (typeof name === 'string' && name.trim()) next.purpose.name = name.trim().slice(0, 80);
    if (typeof description === 'string' && description.trim()) next.purpose.description = description.trim().slice(0, 500);
    if (Array.isArray(capabilities)) {
      const cleaned = capabilities.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim().slice(0, 60));
      if (cleaned.length) next.purpose.capabilities = cleaned.slice(0, 12);
    }
  }

  const mergeTargets = (
    list: Array<{ candidate: { id: string; description?: string }; recommended: boolean }>,
    patch: PluginCreatorSuggestions['inputs'],
    group: string,
  ) => {
    if (!patch || typeof patch !== 'object') return;
    for (const [id, value] of Object.entries(patch)) {
      const target = list.find(item => item.candidate.id === id);
      if (!target || !value || typeof value !== 'object') {
        warnings.push(`${group} 建议引用了未知候选：${id}`);
        continue;
      }
      if (typeof value.description === 'string' && value.description.trim()) {
        target.candidate.description = value.description.trim().slice(0, 300);
      }
      if (typeof value.recommended === 'boolean') target.recommended = value.recommended;
    }
  };
  mergeTargets(next.inputs, suggestions.inputs, 'inputs');
  mergeTargets(next.outputs, suggestions.outputs, 'outputs');

  if (Array.isArray(suggestions.widgets)) {
    for (const widget of suggestions.widgets) {
      if (!widget || typeof widget !== 'object' || typeof widget.nodeId !== 'string' || typeof widget.field !== 'string') {
        warnings.push('widget 建议缺少 nodeId/field');
        continue;
      }
      const target = next.widgets.find(item => item.field.nodeId === widget.nodeId && item.field.field === widget.field);
      if (!target) {
        warnings.push(`widget 建议引用了不存在或不可暴露的字段：${widget.nodeId}.${widget.field}`);
        continue;
      }
      if (!WIDGET_EXPOSURES.has(widget.exposure)) {
        warnings.push(`widget 建议 ${widget.nodeId}.${widget.field} 的曝光值无效：${String(widget.exposure)}`);
        continue;
      }
      if (target.field.connected && widget.exposure === 'llm') {
        warnings.push(`widget 建议 ${widget.nodeId}.${widget.field} 是连线字段，不能直接暴露；请改为暴露其上游源头参数`);
        continue;
      }
      target.exposure = widget.exposure;
      if (typeof widget.reason === 'string' && widget.reason.trim()) target.reason = widget.reason.trim().slice(0, 200);
      target.confidence = Math.max(target.confidence, 0.9);
    }
  }

  if (suggestions.response && typeof suggestions.response === 'object') {
    if (typeof suggestions.response.recommendedPromptVisibility === 'boolean') {
      next.response.recommendedPromptVisibility = suggestions.response.recommendedPromptVisibility;
    }
    if (Array.isArray(suggestions.response.blocks)) {
      const validBlocks = suggestions.response.blocks.filter(block => {
        if (!block || typeof block !== 'object') return false;
        if (!RESPONSE_BLOCK_SOURCES.has(block.source)) {
          warnings.push(`回复块来源不在白名单内：${String(block.source)}`);
          return false;
        }
        if (!RESPONSE_BLOCK_TIMINGS.has(block.timing)) {
          warnings.push(`回复块时机无效：${String(block.timing)}`);
          return false;
        }
        if (!RESPONSE_BLOCK_FORMATS.has(block.format)) {
          warnings.push(`回复块格式无效：${String(block.format)}`);
          return false;
        }
        return true;
      });
      if (validBlocks.length) next.response.blocks = validBlocks.map(block => ({ ...block }));
    }
  }

  return { analysis: next, warnings };
}

export function buildPluginAnalysis(input: PluginCreatorInput): PluginAnalysis {
  const { spec, graph } = input;
  const inputCandidates = (spec.inputs ?? []).map(candidate => {
    const { confidence, reason } = inputConfidence(candidate);
    return { candidate: { ...candidate }, confidence, reason, recommended: !candidate.hidden };
  });
  const outputCandidates = (spec.outputs ?? []).map(candidate => {
    const { confidence, reason } = outputConfidence(candidate);
    return { candidate: { ...candidate }, confidence, reason, recommended: !candidate.hidden };
  });
  const widgets = graph.nodes
    .flatMap(node => node.fields)
    .map(field => widgetExposure(field, spec.params ?? [], graph))
    .filter((item): item is PluginAnalysisWidget => item !== null);
  const visibleInputs = inputCandidates.filter(item => item.recommended && !item.candidate.hidden);
  const visibleOutputs = outputCandidates.filter(item => item.recommended && !item.candidate.hidden);
  return {
    workflow: {
      format: input.format ?? 'api',
      nodeCount: graph.nodes.length,
      sourceFingerprint: stableFingerprint(input),
    },
    purpose: {
      name: spec.name,
      description: spec.description ?? '',
      capabilities: [...new Set([
        ...visibleInputs.map(item => `${item.candidate.kind}-input`),
        ...visibleOutputs.map(item => `${item.candidate.kind}-output`),
      ])],
    },
    inputs: inputCandidates,
    outputs: outputCandidates,
    widgets,
    response: {
      recommendedPromptVisibility: visibleInputs.some(item => item.candidate.kind === 'text'),
      blocks: visibleOutputs.map(item => ({
        source: `result.${item.candidate.kind}`,
        timing: 'complete' as const,
        format: item.candidate.kind === 'text' ? 'markdown' as const : 'plain' as const,
      })),
    },
  };
}
