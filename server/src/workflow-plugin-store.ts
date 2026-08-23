import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkflowSpec } from './workflow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const WORKFLOW_PLUGIN_DATA_DIR = path.resolve(__dirname, '../data/workflow-plugins');
export const IMPORTED_WORKFLOWS_DIR = path.join(WORKFLOW_PLUGIN_DATA_DIR, 'workflows');
export const MANIFESTS_DIR = WORKFLOW_PLUGIN_DATA_DIR;

export type WorkflowManifestSource = NonNullable<WorkflowSpec['source']>;
export type WorkflowManifestRecord = WorkflowSpec & {
  source: WorkflowManifestSource;
};

export type ManifestReadResult =
  | { status: 'missing' }
  | { status: 'valid'; manifest: WorkflowManifestRecord }
  | { status: 'invalid'; error: string };

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function assertPluginId(id: string): void {
  if (!ID_RE.test(id)) throw new Error(`非法工作流插件 ID: ${id}`);
}

function manifestPath(root: string, id: string): string {
  assertPluginId(id);
  return path.join(root, `${id}.json`);
}

function importedWorkflowPath(root: string, id: string): string {
  assertPluginId(id);
  return path.join(root, 'workflows', `${id}.json`);
}

function ensureParent(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function atomicWriteJson(file: string, value: unknown): void {
  ensureParent(file);
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

export function readManifest(root: string = MANIFESTS_DIR, id: string): ManifestReadResult {
  const file = manifestPath(root, id);
  if (!fs.existsSync(file)) return { status: 'missing' };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as WorkflowManifestRecord;
    if (!parsed || typeof parsed !== 'object' || parsed.id !== id || !parsed.source) {
      return { status: 'invalid', error: 'manifest 缺少有效的 id 或 source' };
    }
    return { status: 'valid', manifest: parsed };
  } catch (error) {
    return { status: 'invalid', error: `manifest JSON 无效: ${(error as Error).message}` };
  }
}

export function writeManifest(root: string = MANIFESTS_DIR, manifest: WorkflowManifestRecord): void {
  assertPluginId(manifest.id);
  atomicWriteJson(manifestPath(root, manifest.id), manifest);
}

export function listManifests(root: string = MANIFESTS_DIR): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => entry.name.slice(0, -'.json'.length))
    .filter(id => ID_RE.test(id))
    .sort();
}

export function deleteManifest(root: string = MANIFESTS_DIR, id: string): void {
  const file = manifestPath(root, id);
  fs.rmSync(file, { force: true });
}

export function readWorkflowJson(root: string = WORKFLOW_PLUGIN_DATA_DIR, id: string): Record<string, any> | null {
  const file = importedWorkflowPath(root, id);
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
  return parsed && typeof parsed === 'object' ? parsed : null;
}

export function writeWorkflowJson(root: string = WORKFLOW_PLUGIN_DATA_DIR, id: string, workflow: Record<string, any>): void {
  atomicWriteJson(importedWorkflowPath(root, id), workflow);
}

export function deleteImportedWorkflow(root: string = WORKFLOW_PLUGIN_DATA_DIR, id: string): void {
  fs.rmSync(importedWorkflowPath(root, id), { force: true });
}
