import type { WorkflowGraphField, WorkflowManifest, WorkflowParam } from '../api';

export function isParamSelected(manifest: WorkflowManifest, field: WorkflowGraphField): boolean {
  return manifest.params.some(param => {
    if (param.field !== field.field) return false;
    return param.nodeId === field.nodeId || (param.applyTo ?? []).includes(field.nodeId);
  });
}

export function paramForField(manifest: WorkflowManifest, field: WorkflowGraphField): WorkflowParam | undefined {
  return manifest.params.find(param => param.field === field.field && (param.nodeId === field.nodeId || (param.applyTo ?? []).includes(field.nodeId)));
}

export function addParamFromField(manifest: WorkflowManifest, field: WorkflowGraphField): WorkflowManifest {
  if (!field.selectable || field.connected || isParamSelected(manifest, field)) return manifest;
  const param: WorkflowParam = {
    id: `${field.field}-${field.nodeId}`,
    label: field.field,
    nodeId: field.nodeId,
    field: field.field,
    type: field.type === 'COMBO' ? 'combo' : field.type === 'SEED' ? 'INT' : field.type as WorkflowParam['type'],
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
  return { ...manifest, params: [...manifest.params, param] };
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
