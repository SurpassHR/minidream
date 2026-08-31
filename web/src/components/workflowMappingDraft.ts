import type { WorkflowGraphField, WorkflowManifest, WorkflowParam } from '../api.js';

/**
 * 节点视图勾选 = 加入 LLM 上下文。仅固定值（llm:false）的参数不算勾选。
 * 未勾选但存在 llm:false 参数的 combo 字段仍可在节点视图直接配置并参与运行时注入。
 */
export function workflowInterfaceParams(manifest: WorkflowManifest): WorkflowParam[] {
  return manifest.params.filter(param => param.llm !== false && param.hidden !== true && param.bypass !== true);
}

export function isParamSelected(manifest: WorkflowManifest, field: WorkflowGraphField): boolean {
  const param = paramForField(manifest, field);
  return Boolean(param && param.llm !== false);
}

export function paramForField(manifest: WorkflowManifest, field: WorkflowGraphField): WorkflowParam | undefined {
  return manifest.params.find(param => param.field === field.field && (param.nodeId === field.nodeId || (param.applyTo ?? []).includes(field.nodeId)));
}

function buildParamFromField(field: WorkflowGraphField, options: { llm: boolean; value?: unknown }): WorkflowParam {
  const param: WorkflowParam = {
    id: `${field.field}-${field.nodeId}`,
    label: field.field,
    nodeId: field.nodeId,
    field: field.field,
    type: field.type === 'COMBO' ? 'combo' : field.type === 'SEED' ? 'INT' : field.type as WorkflowParam['type'],
    default: options.value !== undefined ? options.value : field.value,
    llm: options.llm,
    ...(field.applyTo?.length ? { applyTo: field.applyTo } : {}),
    ...(field.multiple !== undefined ? { multiple: field.multiple } : {}),
    ...(field.strengthable !== undefined ? { strengthable: field.strengthable } : {}),
    ...(field.min !== undefined ? { min: field.min } : {}),
    ...(field.max !== undefined ? { max: field.max } : {}),
    ...(field.step !== undefined ? { step: field.step } : {}),
    ...(field.options?.length ? { options: field.options } : {}),
    description: '',
  };
  return param;
}

/** 勾选字段：生成一个加入 LLM 上下文的参数。 */
export function addParamFromField(manifest: WorkflowManifest, field: WorkflowGraphField): WorkflowManifest {
  if (!field.selectable || field.connected || paramForField(manifest, field)) return manifest;
  return { ...manifest, params: [...manifest.params, buildParamFromField(field, { llm: true })] };
}

export function setNodeBypass(manifest: WorkflowManifest, nodeId: string, enabled: boolean, label?: string): WorkflowManifest {
  const index = manifest.params.findIndex(param => param.bypass === true && param.nodeId === nodeId);
  if (index >= 0) {
    return {
      ...manifest,
      params: manifest.params.map((param, itemIndex) => itemIndex === index ? { ...param, default: enabled } : param),
    };
  }
  if (!enabled) return manifest;
  return {
    ...manifest,
    params: [...manifest.params, {
      id: `bypass-${nodeId}`,
      label: label?.trim() ? `跳过${label.trim()}` : `跳过节点 ${nodeId}`,
      nodeId,
      field: '',
      type: 'BOOLEAN',
      default: true,
      bypass: true,
      llm: false,
      description: '设为 true 时跳过该节点（对应 ComfyUI 的 bypass），该节点及其失效分支不再参与生成',
    }],
  };
}

/** 固定 combo 值：已有参数则更新默认值，否则生成一个不加入 LLM 上下文的参数。 */
export function pinComboValue(manifest: WorkflowManifest, field: WorkflowGraphField, value: unknown): WorkflowManifest {
  if (!field.selectable || field.connected) return manifest;
  const current = paramForField(manifest, field);
  if (current) {
    return {
      ...manifest,
      params: manifest.params.map(param => param === current ? { ...param, default: value } : param),
    };
  }
  return { ...manifest, params: [...manifest.params, buildParamFromField(field, { llm: false, value })] };
}

/** 切换参数是否加入 LLM 上下文；字段无参数时按勾选新建（llm:true）。 */
export function setParamExposed(manifest: WorkflowManifest, field: WorkflowGraphField, llm: boolean): WorkflowManifest {
  const current = paramForField(manifest, field);
  if (!current) return addParamFromField(manifest, field);
  return {
    ...manifest,
    params: manifest.params.map(param => param === current ? { ...param, llm } : param),
  };
}

export function removeParam(manifest: WorkflowManifest, field: WorkflowGraphField): WorkflowManifest {
  const current = paramForField(manifest, field);
  if (!current) return manifest;
  return {
    ...manifest,
    params: manifest.params.filter(param => param !== current),
  };
}

export type WorkflowDraftValidationError = {
  code: 'nameRequired' | 'outputRequired' | 'idRequired' | 'idDuplicate' | 'nodeRequired' | 'fieldRequired';
  group?: 'inputs' | 'params' | 'outputs';
  id?: string;
};

/** 保存前校验工作流清单；节点 bypass 是内部状态，不需要对应 widget field。 */
export function validateWorkflowDraft(manifest: WorkflowManifest): WorkflowDraftValidationError | null {
  if (!manifest.name.trim()) return { code: 'nameRequired' };
  const groups = [
    ['inputs', manifest.inputs],
    ['params', manifest.params],
    ['outputs', manifest.outputs],
  ] as const;
  for (const [group, items] of groups) {
    const ids = new Set<string>();
    for (const item of items) {
      if (!item.id.trim()) return { code: 'idRequired', group, id: item.id };
      if (ids.has(item.id)) return { code: 'idDuplicate', group, id: item.id };
      ids.add(item.id);
      if (!item.nodeId) return { code: 'nodeRequired', group, id: item.id };
      if ('field' in item && !item.field && !(group === 'params' && 'bypass' in item && item.bypass === true)) {
        return { code: 'fieldRequired', group, id: item.id };
      }
    }
  }
  return null;
}

export function toggleParam(manifest: WorkflowManifest, field: WorkflowGraphField, confirmed = true): WorkflowManifest {
  if (isParamSelected(manifest, field)) return confirmed ? removeParam(manifest, field) : manifest;
  return addParamFromField(manifest, field);
}
