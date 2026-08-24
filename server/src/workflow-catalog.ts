import fs from 'node:fs';
import path from 'node:path';
import { listManifests, readManifest, readWorkflowJson, type WorkflowManifestRecord } from './workflow-plugin-store.js';
import type { WorkflowInput, WorkflowOutput, WorkflowParam, WorkflowSpec } from './workflow.js';

export interface WorkflowCatalogSource {
  id: string;
  source: { type: 'bundled' | 'imported'; workflowFile: string };
  json: Record<string, any>;
}

export interface WorkflowCatalogOptions {
  bundledDir: string;
  importedDir: string;
  manifestDir: string;
  introspect: (json: Record<string, any>) => Promise<WorkflowSpec>;
}

function readJsonFile(file: string): Record<string, any> | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function listJsonFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => entry.name)
    .sort();
}

export function listCatalogSources(options: WorkflowCatalogOptions): WorkflowCatalogSource[] {
  const bundled: WorkflowCatalogSource[] = listJsonFiles(options.bundledDir)
    .map(name => {
      const id = name.slice(0, -'.json'.length);
      const json = readJsonFile(path.join(options.bundledDir, name));
      if (!json) return null;
      return { id, source: { type: 'bundled', workflowFile: `workflows/${name}` }, json } as WorkflowCatalogSource;
    })
    .filter((item): item is WorkflowCatalogSource => item !== null);
  const bundledIds = new Set(bundled.map(item => item.id));
  const imported: WorkflowCatalogSource[] = listJsonFiles(options.importedDir)
    .map(name => {
      const id = name.slice(0, -'.json'.length);
      if (bundledIds.has(id)) return null;
      const json = readJsonFile(path.join(options.importedDir, name));
      if (!json) return null;
      return { id, source: { type: 'imported', workflowFile: `workflows/${name}` }, json } as WorkflowCatalogSource;
    })
    .filter((item): item is WorkflowCatalogSource => item !== null);
  return [...bundled, ...imported].sort((a, b) => a.id.localeCompare(b.id));
}

export function getCatalogWorkflowJson(options: WorkflowCatalogOptions, id: string): Record<string, any> | null {
  const source = listCatalogSources(options).find(item => item.id === id);
  return source?.json ?? null;
}

function withCatalogMetadata(spec: WorkflowSpec, source: WorkflowCatalogSource, hasManifest: boolean, manifestError?: string): WorkflowSpec {
  return {
    ...spec,
    id: source.id,
    name: spec.name || source.id,
    source: source.source,
    hasManifest,
    editable: true,
    ...(manifestError ? { manifestError } : {}),
  };
}

export async function buildCatalogSpecs(options: WorkflowCatalogOptions): Promise<WorkflowSpec[]> {
  const specs: WorkflowSpec[] = [];
  for (const source of listCatalogSources(options)) {
    const manifest = readManifest(options.manifestDir, source.id);
    if (manifest.status === 'valid') {
      // manifest 是用户契约（含节点视图勾选的参数与 bypass 开关），直接作为事实来源
      specs.push(withCatalogMetadata(manifest.manifest, source, true));
      continue;
    }
    if (source.source.type === 'imported') continue; // 无有效 manifest 的导入工作流不可用
    const detected = await options.introspect(source.json);
    specs.push(withCatalogMetadata(detected, source, false, manifest.status === 'invalid' ? manifest.error : undefined));
  }
  return specs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

function preserve<T extends { nodeId: string; field?: string; label: string; id: string }>(detected: T, previous: T | undefined): T {
  if (!previous) return detected;
  return {
    ...detected,
    id: previous.id,
    label: previous.label,
    ...(Object.prototype.hasOwnProperty.call(previous, 'description') ? { description: (previous as T & { description?: string }).description } : {}),
    ...(Object.prototype.hasOwnProperty.call(previous, 'hidden') ? { hidden: (previous as T & { hidden?: boolean }).hidden } : {}),
    ...(Object.prototype.hasOwnProperty.call(previous, 'llm') ? { llm: (previous as T & { llm?: boolean }).llm } : {}),
    ...(Object.prototype.hasOwnProperty.call(previous, 'required') ? { required: (previous as T & { required?: boolean }).required } : {}),
  };
}

export function mergeRedetectedSpec(previous: WorkflowSpec, detected: WorkflowSpec): WorkflowSpec {
  const inputByKey = new Map(detected.inputs.map(item => [`${item.nodeId}:${item.field}`, item]));
  const paramByKey = new Map(detected.params.map(item => [`${item.nodeId}:${item.field}`, item]));
  const outputByKey = new Map(detected.outputs.map(item => [item.nodeId, item]));

  // The manifest is the user's schema contract: re-detection may refresh values,
  // but it never adds/removes rows or changes a saved node target.
  const inputs = previous.inputs.map(previousItem => {
    const fresh = inputByKey.get(`${previousItem.nodeId}:${previousItem.field}`);
    return fresh ? preserve({ ...fresh, id: previousItem.id, nodeId: previousItem.nodeId, field: previousItem.field, classType: previousItem.classType, kind: previousItem.kind }, previousItem) : previousItem;
  });
  const params = previous.params.map(previousItem => {
    const fresh = paramByKey.get(`${previousItem.nodeId}:${previousItem.field}`);
    if (!fresh) return previousItem;
    const refreshed = preserve({ ...fresh, id: previousItem.id, nodeId: previousItem.nodeId, field: previousItem.field, type: previousItem.type, applyTo: previousItem.applyTo }, previousItem);
    return {
      ...refreshed,
      default: previousItem.default,
      ...(previousItem.min !== undefined ? { min: previousItem.min } : {}),
      ...(previousItem.max !== undefined ? { max: previousItem.max } : {}),
      ...(previousItem.step !== undefined ? { step: previousItem.step } : {}),
      ...(previousItem.options !== undefined ? { options: previousItem.options } : {}),
    };
  });
  const outputs = previous.outputs.map(previousItem => {
    const fresh = outputByKey.get(previousItem.nodeId);
    return fresh ? preserve({ ...fresh, id: previousItem.id, nodeId: previousItem.nodeId, classType: previousItem.classType, kind: previousItem.kind }, previousItem) : previousItem;
  });
  return {
    ...detected,
    id: previous.id || detected.id,
    name: previous.name || detected.name,
    description: previous.description ?? detected.description,
    source: previous.source ?? detected.source,
    hasManifest: previous.hasManifest,
    editable: true,
    inputs,
    params,
    outputs,
  };
}

export async function redetectWorkflowManifest(
  options: WorkflowCatalogOptions,
  id: string,
  previous: WorkflowSpec,
): Promise<WorkflowSpec> {
  const json = getCatalogWorkflowJson(options, id);
  if (!json) throw new Error(`找不到工作流: ${id}`);
  const detected = await options.introspect(json);
  return mergeRedetectedSpec(previous, detected);
}

export function readImportedWorkflowJson(root: string, id: string): Record<string, any> | null {
  return readWorkflowJson(root, id);
}

export function manifestIds(options: WorkflowCatalogOptions): string[] {
  return listManifests(options.manifestDir);
}

export type { WorkflowInput, WorkflowOutput, WorkflowParam, WorkflowManifestRecord };
