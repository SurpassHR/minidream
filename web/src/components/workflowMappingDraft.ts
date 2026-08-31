import type { WorkflowGraphField, WorkflowManifest, WorkflowParam } from '../api';

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

/**
 * 节点屏蔽（bypass）是通用能力：节点视图勾选任意 widget 时，其表单行即提供 bypass 开关。
 * 为 nodeId 对应节点补充一个 bypass 参数（同节点去重），字段为空、不单独成行，
 * 由表单视图内嵌到该节点参数行的行脚。LLM 可通过 `generation.submit` 的
 * `params: { 'bypass-<nodeId>': true/false }` 控制开关。
 */
export function addBypassParam(manifest: WorkflowManifest, nodeId: string, label?: string): WorkflowManifest {
  if (manifest.params.some(param => param.bypass === true && param.nodeId === nodeId)) return manifest;
  return {
    ...manifest,
    params: [...manifest.params, {
      id: `bypass-${nodeId}`,
      label: label?.trim() ? label.trim() : `跳过节点 ${nodeId}`,
      nodeId,
      field: '',
      type: 'BOOLEAN',
      default: false,
      bypass: true,
      description: '设为 true 时跳过该节点（对应 ComfyUI 的 bypass），该节点及其失效分支不再参与生成',
    }],
  };
}

/**
 * 为所有已暴露（llm !== false）参数所属节点补充缺失的 bypass 参数（幂等）。
 * 保证表单视图每一行都带节点屏蔽开关——包括在 bypass 能力引入前就已勾选保存的参数
 * （如 image-5404 / text-5506），无需用户重新在节点视图勾选。
 */
export function ensureBypassParams(manifest: WorkflowManifest, titleFor?: (nodeId: string) => string | undefined): WorkflowManifest {
  const exposed = manifest.params.filter(param => param.llm !== false && param.bypass !== true);
  if (exposed.length === 0) return manifest;
  let params = manifest.params;
  for (const param of exposed) {
    if (params.some(item => item.bypass === true && item.nodeId === param.nodeId)) continue;
    const title = titleFor?.(param.nodeId)?.trim();
    params = [...params, {
      id: `bypass-${param.nodeId}`,
      label: title ? `跳过${title}` : `跳过节点 ${param.nodeId}`,
      nodeId: param.nodeId,
      field: '',
      type: 'BOOLEAN',
      default: false,
      bypass: true,
      description: '设为 true 时跳过该节点（对应 ComfyUI 的 bypass），该节点及其失效分支不再参与生成',
    }];
  }
  return params === manifest.params ? manifest : { ...manifest, params };
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

export function toggleParam(manifest: WorkflowManifest, field: WorkflowGraphField, confirmed = true): WorkflowManifest {
  if (isParamSelected(manifest, field)) return confirmed ? removeParam(manifest, field) : manifest;
  return addParamFromField(manifest, field);
}
