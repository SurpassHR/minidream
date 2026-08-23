import { readSettings, updatePluginsSettings } from './settings.js';
import { listCatalogSources, type WorkflowCatalogOptions } from './workflow-catalog.js';
import { readManifest, writeManifest, type WorkflowManifestRecord } from './workflow-plugin-store.js';

/**
 * Move the old workflowId -> paramId combo overrides into each workflow manifest.
 * A legacy override is retained only when it matches a detected combo parameter;
 * after the migration pass the legacy config is cleared so execution has one source
 * of truth: manifest.params[].default.
 */
export async function migrateLegacyPluginConfig(settingsFile: string, catalog: WorkflowCatalogOptions): Promise<void> {
  const settings = readSettings(settingsFile);
  const legacy = settings.plugins.config ?? {};
  if (Object.keys(legacy).length === 0) return;

  const sources = listCatalogSources(catalog);
  for (const [workflowId, values] of Object.entries(legacy)) {
    const source = sources.find(item => item.id === workflowId);
    if (!source) continue;

    const existing = readManifest(catalog.manifestDir, workflowId);
    const base = existing.status === 'valid' && existing.manifest.params.length > 0
      ? existing.manifest
      : await catalog.introspect(source.json);
    let changed = false;
    const params = base.params
      .filter(param => existing.status === 'valid' || (param.type === 'combo' && values[param.id] !== undefined))
      .map(param => {
        const override = values[param.id];
        if (override === undefined || param.type !== 'combo') return param;
        changed = true;
        return { ...param, default: override };
      });

    if (!changed) continue;
    const manifest: WorkflowManifestRecord = {
      ...base,
      id: workflowId,
      source: existing.status === 'valid'
        ? existing.manifest.source
        : source.source,
      params,
      hasManifest: true,
      editable: true,
    };
    writeManifest(catalog.manifestDir, manifest);
  }

  // The migration is intentionally one-shot. Values that did not match a current
  // workflow are discarded as obsolete rather than remaining a second config path.
  updatePluginsSettings(settingsFile, { config: {} });
}
