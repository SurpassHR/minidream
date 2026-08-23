import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateLegacyPluginConfig } from './workflow-plugin-migration.js';
import { readSettings, writeSettings, DEFAULT_SETTINGS } from './settings.js';
import { readManifest } from './workflow-plugin-store.js';
import type { WorkflowCatalogOptions } from './workflow-catalog.js';
import type { WorkflowSpec } from './workflow.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('legacy workflow plugin combo migration', () => {
  it('moves legacy combo values into a bundled manifest and clears the old config', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-plugin-migration-'));
    roots.push(root);
    const bundledDir = path.join(root, 'bundled');
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(bundledDir, { recursive: true });
    fs.writeFileSync(path.join(bundledDir, 'demo.json'), JSON.stringify({ class: 'demo' }), 'utf8');
    const settingsFile = path.join(root, 'settings.json');
    writeSettings(settingsFile, {
      ...DEFAULT_SETTINGS,
      plugins: {
        disabled: [],
        config: { demo: { 'sampler_name-1': 'karras' } },
      },
    });
    const catalog: WorkflowCatalogOptions = {
      bundledDir,
      importedDir: path.join(dataDir, 'workflows'),
      manifestDir: dataDir,
      introspect: async (): Promise<WorkflowSpec> => ({
        id: 'demo',
        name: 'Demo',
        inputs: [],
        params: [
          { id: 'sampler_name-1', label: 'Sampler', nodeId: '1', field: 'sampler_name', type: 'combo', default: 'euler', options: ['euler', 'karras'] },
          { id: 'steps-1', label: 'Steps', nodeId: '1', field: 'steps', type: 'INT', default: 20 },
        ],
        outputs: [{ id: 'image-2', kind: 'image', label: 'Image', nodeId: '2', classType: 'SaveImage' }],
      }),
    };

    await migrateLegacyPluginConfig(settingsFile, catalog);

    const manifest = readManifest(dataDir, 'demo');
    expect(manifest.status).toBe('valid');
    if (manifest.status === 'valid') {
      expect(manifest.manifest.params).toHaveLength(1);
      expect(manifest.manifest.params[0]).toMatchObject({ id: 'sampler_name-1', default: 'karras' });
    }
    expect(readSettings(settingsFile).plugins).toEqual({ disabled: [] });
  });

  it('uses fresh detection when an existing imported manifest has no selected params', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-plugin-migration-'));
    roots.push(root);
    const bundledDir = path.join(root, 'bundled');
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(bundledDir, { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'workflows', 'demo.json'), JSON.stringify({ imported: true }), 'utf8');
    const settingsFile = path.join(root, 'settings.json');
    writeSettings(settingsFile, {
      ...DEFAULT_SETTINGS,
      plugins: { disabled: [], config: { demo: { 'sampler_name-1': 'karras' } } },
    });
    const existing = {
      id: 'demo',
      name: 'Demo',
      inputs: [],
      params: [],
      outputs: [{ id: 'image-2', kind: 'image' as const, label: 'Image', nodeId: '2', classType: 'SaveImage' }],
      source: { type: 'imported' as const, workflowFile: 'workflows/demo.json' },
    };
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'demo.json'), JSON.stringify(existing), 'utf8');
    const catalog: WorkflowCatalogOptions = {
      bundledDir,
      importedDir: path.join(dataDir, 'workflows'),
      manifestDir: dataDir,
      introspect: async (): Promise<WorkflowSpec> => ({
        id: 'demo', name: 'Demo', inputs: [],
        params: [{ id: 'sampler_name-1', label: 'Sampler', nodeId: '1', field: 'sampler_name', type: 'combo', default: 'euler', options: ['euler', 'karras'] }],
        outputs: existing.outputs,
      }),
    };
    await migrateLegacyPluginConfig(settingsFile, catalog);
    const manifest = readManifest(dataDir, 'demo');
    expect(manifest.status).toBe('valid');
    if (manifest.status === 'valid') expect(manifest.manifest.params[0]).toMatchObject({ id: 'sampler_name-1', default: 'karras' });
  });
});
