import { convertUiToApi, isUiFormat } from './workflow.js';
import type { WorkflowParam, WorkflowSpec } from './workflow.js';

const FILE_COMBO_FIELDS = new Set([
  'ckpt_name',
  'vae_name',
  'lora_name',
  'unet_name',
  'clip_name',
  'control_net_name',
  'audio_name',
]);

const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'BOOLEAN', 'STRING', 'SEED', 'COMBO']);
const SHARED_PARAM_FIELDS = new Set(['seed', 'noise_seed', 'steps', 'cfg', 'denoise', 'lora']);

export interface WorkflowGraphField {
  nodeId: string;
  field: string;
  type: string;
  value?: unknown;
  connected: boolean;
  selectable: boolean;
  selected: boolean;
  paramId?: string;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  applyTo?: string[];
  multiple?: boolean;
  strengthable?: boolean;
  connection?: { sourceNode: string; sourceField: string };
}

export interface WorkflowGraphNode {
  nodeId: string;
  classType: string;
  title: string;
  x: number;
  y: number;
  fields: WorkflowGraphField[];
}

export interface WorkflowGraphEdge {
  sourceNode: string;
  sourceField: string;
  targetNode: string;
  targetField: string;
  type?: string;
}

export interface WorkflowGraph {
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
  manifestError?: string;
}

interface ApiNode {
  class_type?: string;
  inputs?: Record<string, unknown>;
  _meta?: { title?: string };
}

interface FieldDefinition {
  type: string;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  default?: unknown;
}

interface ApiGraphData {
  api: Record<string, ApiNode>;
  positions: Map<string, { x: number; y: number }>;
  uiLinks: Array<{ sourceNode: string; sourceSlot: number; targetNode: string; targetSlot: number; type?: string }>;
}

function numericNodeSort(a: string, b: string): number {
  const an = Number(a);
  const bn = Number(b);
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  return a.localeCompare(b, 'en', { numeric: true });
}

function fieldType(definition: any, value: unknown): FieldDefinition {
  if (Array.isArray(definition)) {
    const [typeOrOptions, options] = definition as [unknown, Record<string, any>?];
    if (Array.isArray(typeOrOptions)) {
      return { type: 'COMBO', options: typeOrOptions.map(String), default: options?.default ?? typeOrOptions[0] };
    }
    if (typeof typeOrOptions === 'string') {
      const type = typeOrOptions === 'COMFY_DYNAMICCOMBO_V3' ? 'COMBO' : typeOrOptions;
      return {
        type,
        options: Array.isArray(options?.options) ? options.options.map(String) : undefined,
        min: typeof options?.min === 'number' ? options.min : undefined,
        max: typeof options?.max === 'number' ? options.max : undefined,
        step: typeof options?.step === 'number' ? options.step : undefined,
        default: options?.default,
      };
    }
  }
  if (definition && typeof definition === 'object') {
    return {
      type: typeof definition.type === 'string' ? definition.type : 'UNKNOWN',
      options: Array.isArray(definition.options) ? definition.options.map(String) : undefined,
      min: typeof definition.min === 'number' ? definition.min : undefined,
      max: typeof definition.max === 'number' ? definition.max : undefined,
      step: typeof definition.step === 'number' ? definition.step : undefined,
      default: definition.default,
    };
  }
  if (Array.isArray(value)) return { type: 'LINK' };
  if (typeof value === 'boolean') return { type: 'BOOLEAN' };
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'INT' : 'FLOAT' };
  if (typeof value === 'string') return { type: 'STRING' };
  return { type: 'UNKNOWN' };
}

function mergeDefinitions(objectInfoData: Record<string, any>, classType: string): Record<string, any> {
  const input = objectInfoData[classType]?.input ?? {};
  return { ...(input.required ?? {}), ...(input.optional ?? {}) };
}

function installedLoraOptions(objectInfoData: Record<string, any>): string[] {
  for (const classType of ['LoraLoader', 'LoraLoaderModelOnly']) {
    const definition = objectInfoData[classType]?.input?.required?.lora_name;
    if (Array.isArray(definition) && Array.isArray(definition[0])) {
      return definition[0].map(String).filter((value: string) => value !== 'None');
    }
  }
  return [];
}

function powerLoraDefaults(nodeInputs: Record<string, unknown>): Array<{ name: string; strength: number }> {
  return Object.entries(nodeInputs)
    .filter(([field, value]) => /^lora_\d+$/.test(field) && value && typeof value === 'object')
    .map(([, value]) => value as Record<string, unknown>)
    .filter(value => value.on === true && typeof value.lora === 'string')
    .map(value => ({ name: value.lora as string, strength: typeof value.strength === 'number' ? value.strength : 1 }));
}

function powerLoraOptions(nodeInputs: Record<string, unknown>): string[] {
  return Object.entries(nodeInputs)
    .filter(([field, value]) => /^lora_\d+$/.test(field) && value && typeof value === 'object')
    .map(([, value]) => (value as Record<string, unknown>).lora)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function sourceFieldForSlot(api: Record<string, ApiNode>, sourceNode: string, sourceSlot: number): string {
  const node = api[sourceNode];
  const fields = Object.entries(node?.inputs ?? {}).filter(([, value]) => !Array.isArray(value));
  return fields[sourceSlot]?.[0] ?? `slot-${sourceSlot}`;
}

function createUiLinkData(json: Record<string, any>): ApiGraphData['uiLinks'] {
  return (Array.isArray(json.links) ? json.links : [])
    .filter((link: any) => Array.isArray(link) && link.length >= 5)
    .map((link: any) => ({
      sourceNode: String(link[1]),
      sourceSlot: Number(link[2]),
      targetNode: String(link[3]),
      targetSlot: Number(link[4]),
      type: typeof link[5] === 'string' ? link[5] : undefined,
    }));
}

function toApiGraphData(json: Record<string, any>, objectInfoData: Record<string, any>): ApiGraphData {
  if (!isUiFormat(json)) {
    return {
      api: Object.fromEntries(Object.entries(json).filter(([id]) => id !== '_meta')) as Record<string, ApiNode>,
      positions: new Map(),
      uiLinks: [],
    };
  }
  const positions = new Map<string, { x: number; y: number }>();
  for (const node of Array.isArray(json.nodes) ? json.nodes : []) {
    if (Array.isArray(node.pos) && node.pos.length >= 2) {
      positions.set(String(node.id), { x: Number(node.pos[0]) || 0, y: Number(node.pos[1]) || 0 });
    }
  }
  return { api: convertUiToApi(json, objectInfoData) as Record<string, ApiNode>, positions, uiLinks: createUiLinkData(json) };
}

const MIN_NODE_COLUMN_GAP = 440;

function buildFallbackLayout(api: Record<string, ApiNode>, edges: WorkflowGraphEdge[]): Map<string, { x: number; y: number }> {
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const id of Object.keys(api)) {
    incoming.set(id, []);
    outgoing.set(id, []);
  }
  for (const edge of edges) {
    if (!incoming.has(edge.targetNode) || !outgoing.has(edge.sourceNode)) continue;
    incoming.get(edge.targetNode)!.push(edge.sourceNode);
    outgoing.get(edge.sourceNode)!.push(edge.targetNode);
  }

  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const compute = (id: string): number => {
    if (layer.has(id)) return layer.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parents = incoming.get(id) ?? [];
    const value = parents.length ? Math.max(...parents.map(compute)) + 1 : 0;
    visiting.delete(id);
    layer.set(id, value);
    return value;
  };
  Object.keys(api).forEach(compute);

  const byLayer = new Map<number, string[]>();
  for (const id of Object.keys(api)) {
    const current = byLayer.get(layer.get(id) ?? 0) ?? [];
    current.push(id);
    byLayer.set(layer.get(id) ?? 0, current);
  }
  const positions = new Map<string, { x: number; y: number }>();
  for (const [level, ids] of byLayer) {
    ids.sort(numericNodeSort);
    ids.forEach((id, index) => positions.set(id, { x: 40 + level * MIN_NODE_COLUMN_GAP, y: 40 + index * 260 }));
  }
  return positions;
}

function spreadConnectedNodes(
  positions: Map<string, { x: number; y: number }>,
  edges: WorkflowGraphEdge[],
): Map<string, { x: number; y: number }> {
  const result = new Map([...positions].map(([id, point]) => [id, { ...point }]));
  // UI exports often use compact coordinates. Push downstream columns to the right
  // while preserving the relative layout and keeping the graph one-way readable.
  for (let pass = 0; pass < result.size + 1; pass++) {
    let changed = false;
    for (const edge of edges) {
      const source = result.get(edge.sourceNode);
      const target = result.get(edge.targetNode);
      if (!source || !target) continue;
      const requiredX = source.x + MIN_NODE_COLUMN_GAP;
      if (target.x < requiredX) {
        target.x = requiredX;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return result;
}

function selectedParamFor(fieldNodeId: string, fieldName: string, params: WorkflowParam[]): WorkflowParam | undefined {
  return params.find(param => {
    if (param.nodeId === fieldNodeId && param.field === fieldName) return true;
    return (param.applyTo ?? []).includes(fieldNodeId) && param.field === fieldName;
  });
}

function normalizedParamType(type: string): WorkflowParam['type'] {
  if (type === 'SEED') return 'INT';
  if (type === 'COMBO') return 'combo';
  if (['INT', 'FLOAT', 'BOOLEAN', 'STRING'].includes(type)) return type as WorkflowParam['type'];
  return 'STRING';
}

export function createParamFromGraphField(field: WorkflowGraphField): WorkflowParam {
  return {
    id: `${field.field}-${field.nodeId}`,
    label: field.field,
    nodeId: field.nodeId,
    field: field.field,
    type: normalizedParamType(field.type),
    default: field.value,
    ...(field.applyTo?.length ? { applyTo: field.applyTo } : {}),
    ...(field.multiple !== undefined ? { multiple: field.multiple } : {}),
    ...(field.strengthable !== undefined ? { strengthable: field.strengthable } : {}),
    ...(field.min !== undefined ? { min: field.min } : {}),
    ...(field.max !== undefined ? { max: field.max } : {}),
    ...(field.step !== undefined ? { step: field.step } : {}),
    ...(field.options?.length ? { options: field.options } : {}),
    description: '',
  };
}

export function buildWorkflowGraph(
  json: Record<string, any>,
  objectInfoData: Record<string, any> = {},
  manifest?: Pick<WorkflowSpec, 'params'>,
): WorkflowGraph {
  const { api, positions: originalPositions, uiLinks } = toApiGraphData(json, objectInfoData);
  const rawEdges: WorkflowGraphEdge[] = [];
  for (const [targetNode, node] of Object.entries(api)) {
    for (const [targetField, value] of Object.entries(node.inputs ?? {})) {
      if (!Array.isArray(value) || value.length < 2) continue;
      const sourceNode = String(value[0]);
      const sourceSlot = Number(value[1]);
      rawEdges.push({
        sourceNode,
        sourceField: sourceFieldForSlot(api, sourceNode, sourceSlot),
        targetNode,
        targetField,
        type: undefined,
      });
    }
  }
  for (const uiLink of uiLinks) {
    const existing = rawEdges.find(edge => edge.sourceNode === uiLink.sourceNode && edge.targetNode === uiLink.targetNode && edge.targetField === Object.keys(api[uiLink.targetNode]?.inputs ?? {})[uiLink.targetSlot]);
    if (existing) existing.type = uiLink.type;
  }
  const edges = rawEdges;
  const layout = buildFallbackLayout(api, edges);
  const initialPositions = new Map<string, { x: number; y: number }>();
  for (const id of Object.keys(api)) initialPositions.set(id, originalPositions.get(id) ?? layout.get(id) ?? { x: 40, y: 40 });
  const positions = spreadConnectedNodes(initialPositions, edges);
  const params = manifest?.params ?? [];
  const incomingByField = new Map<string, WorkflowGraphEdge>();
  for (const edge of edges) incomingByField.set(`${edge.targetNode}:${edge.targetField}`, edge);

  const nodes: WorkflowGraphNode[] = Object.entries(api)
    .map(([nodeId, node]) => {
      const classType = String(node.class_type ?? '');
      const definitions = mergeDefinitions(objectInfoData, classType);
      const fieldNames = new Set([...Object.keys(definitions), ...Object.keys(node.inputs ?? {})]);
      const isPowerLora = classType === 'Power Lora Loader (rgthree)';
      if (isPowerLora) fieldNames.add('lora');
      const fields = [...fieldNames].map(field => {
        const logicalLora = isPowerLora && field === 'lora';
        const value = logicalLora ? powerLoraDefaults(node.inputs ?? {}) : node.inputs?.[field];
        const logicalDefinition = logicalLora
          ? [[...new Set([...installedLoraOptions(objectInfoData), ...powerLoraOptions(node.inputs ?? {})])], {}]
          : definitions[field];
        const connection = incomingByField.get(`${nodeId}:${field}`);
        const definition = fieldType(logicalDefinition, value);
        const connected = Boolean(connection) || (!logicalLora && Array.isArray(value));
        const fileCombo = FILE_COMBO_FIELDS.has(field);
        const selectable = !connected && (WIDGET_TYPES.has(definition.type) || (definition.type === 'STRING' && value !== undefined));
        const param = selectedParamFor(nodeId, field, params);
        // selected = 已加入 LLM 上下文；仅固定值（llm:false）的参数不算勾选
        const selected = Boolean(param && param.llm !== false);
        return {
          nodeId,
          field,
          type: definition.type,
          ...(value !== undefined && !connected ? { value } : {}),
          connected,
          selectable,
          selected,
          ...(logicalLora ? {
            multiple: true,
            strengthable: true,
            min: -10,
            max: 10,
            step: 0.05,
          } : {}),
          ...(param ? {
            paramId: param.id,
            value: param.default,
            ...(param.multiple !== undefined ? { multiple: param.multiple } : {}),
            ...(param.strengthable !== undefined ? { strengthable: param.strengthable } : {}),
          } : {}),
          ...((param?.options ?? definition.options)?.length ? { options: param?.options ?? definition.options } : {}),
          ...(definition.min !== undefined ? { min: definition.min } : {}),
          ...(definition.max !== undefined ? { max: definition.max } : {}),
          ...(definition.step !== undefined ? { step: definition.step } : {}),
          ...(SHARED_PARAM_FIELDS.has(field) ? {
            applyTo: Object.entries(api)
              .filter(([otherNodeId, otherNode]) => otherNodeId !== nodeId && Object.prototype.hasOwnProperty.call(otherNode.inputs ?? {}, field))
              .map(([otherNodeId]) => otherNodeId)
              .sort(numericNodeSort),
          } : {}),
          ...(connection ? { connection: { sourceNode: connection.sourceNode, sourceField: connection.sourceField } } : {}),
        } satisfies WorkflowGraphField;
      });
      return {
        nodeId,
        classType,
        title: String(node._meta?.title ?? classType),
        x: positions.get(nodeId)!.x,
        y: positions.get(nodeId)!.y,
        fields,
      } satisfies WorkflowGraphNode;
    })
    .sort((a, b) => numericNodeSort(a.nodeId, b.nodeId));

  return { nodes, edges };
}
