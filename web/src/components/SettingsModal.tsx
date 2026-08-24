import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  deleteWorkflowPlugin,
  fetchAgentModels,
  fetchAppSettings,
  fetchPlugins,
  importWorkflowPlugin,
  redetectWorkflowManifest,
  saveAgentSettings,
  saveComfySettings,
  saveStorageSettings,
  savePluginsSettings,
  saveWorkflowManifest,
  type AgentModel,
  type AgentThinking,
  type ComfyStatus,
  type FabricatedHistoryMessage,
  type WorkflowManifest,
  type WorkflowParam,
  type WorkflowPluginRecord,
  type WorkflowSpec,
} from '../api';
import WorkflowMappingModal from './WorkflowMappingModal';

interface Category {
  id: string;
  icon: React.ReactNode;
}

const MAX_ATTEMPTS = 12;
const RETRY_INTERVAL = 2000;

const CATEGORIES: Category[] = [
  {
    id: 'comfyui',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <rect x="1.5" y="1.5" width="6.5" height="6.5" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
        <rect x="10" y="1.5" width="6.5" height="6.5" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
        <rect x="1.5" y="10" width="6.5" height="6.5" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
        <rect x="10" y="10" width="6.5" height="6.5" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    ),
  },
  {
    id: 'agent',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <path d="M9 2.25a4 4 0 0 0-4 4v2.5a4 4 0 0 0 8 0v-2.5a4 4 0 0 0-4-4Z" stroke="currentColor" strokeWidth="1.3" />
        <path d="M2.75 8.5v1.25a6.25 6.25 0 0 0 12.5 0V8.5M9 14.75v1.5M6.5 16.25h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'storage',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h3l1.5 1.5H14A1.5 1.5 0 0 1 15.5 7v6A1.5 1.5 0 0 1 14 14.5H4A1.5 1.5 0 0 1 2.5 13v-7.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M5.5 9.5h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'plugins',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <path d="M6 2.5v2M12 2.5v2M4.5 4.5h9v3A2.5 2.5 0 0 1 11 10H7a2.5 2.5 0 0 1-2.5-2.5v-3Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M9 10v5.5M6.5 15.5h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    ),
  },
];

const PLUGIN_KIND_LABEL: Record<string, string> = { image: 'common.kindImage', video: 'common.kindVideo', text: 'common.kindText' };
const CATEGORY_KEY: Record<string, string> = {
  comfyui: 'settings.catComfyui',
  agent: 'settings.catAgent',
  storage: 'settings.catStorage',
  plugins: 'settings.catPlugins',
};
const ROLE_KEY: Record<string, string> = {
  system: 'settings.agent.roleSystem',
  user: 'settings.agent.roleUser',
  assistant: 'settings.agent.roleAssistant',
};

/** 两个 Set 内容是否一致 */
function setEquals(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

/** 两个 JSON 可序列化对象是否一致 */
function objEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export default function SettingsModal({
  open,
  onClose,
  comfyStatus,
  workflows,
  onRefreshStatus,
  onRefreshWorkflows,
}: {
  open: boolean;
  onClose: () => void;
  comfyStatus: ComfyStatus | null;
  workflows: WorkflowSpec[];
  onRefreshStatus: () => void;
  onRefreshWorkflows?: () => void;
}) {
  const { t } = useTranslation();
  const [active, setActive] = useState(CATEGORIES[0]!.id);
  const [baseUrl, setBaseUrl] = useState('');
  const [baseUrlSaved, setBaseUrlSaved] = useState('');
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tip, setTip] = useState<string | null>(null);

  const [outputDir, setOutputDir] = useState('');
  const [outputDirSaved, setOutputDirSaved] = useState('');
  const [storageTip, setStorageTip] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [agentModel, setAgentModel] = useState('');
  const [agentThinking, setAgentThinking] = useState<AgentThinking>('minimal');
  const [agentPoll, setAgentPoll] = useState(false);
  const [agentModels, setAgentModels] = useState<AgentModel[]>([]);
  const [agentModelsLoading, setAgentModelsLoading] = useState(false);
  const [agentTip, setAgentTip] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [agentFabricated, setAgentFabricated] = useState<FabricatedHistoryMessage[]>([]);
  const [agentSaved, setAgentSaved] = useState<{
    model: string;
    thinking: AgentThinking;
    pollTaskStatus: boolean;
    fabricatedHistory: FabricatedHistoryMessage[];
  } | null>(null);

  // 插件（工作流）状态：仅保留启用/停用；参数配置属于工作流 manifest。
  const [pluginDisabled, setPluginDisabled] = useState<string[]>([]);
  const [pluginDraft, setPluginDraft] = useState<Set<string> | null>(null);
  const [pluginsTip, setPluginsTip] = useState<string | null>(null);
  const [pluginsSaved, setPluginsSaved] = useState<string[] | null>(null);
  const [pluginRecords, setPluginRecords] = useState<WorkflowPluginRecord[]>([]);
  const [mappingTarget, setMappingTarget] = useState<WorkflowManifest | null>(null);
  const [mappingSaving, setMappingSaving] = useState(false);
  const [mappingError, setMappingError] = useState<string | null>(null);
  const [pluginImporting, setPluginImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [savingAll, setSavingAll] = useState(false);
  const [toastFlash, setToastFlash] = useState<'saved' | 'failed' | null>(null);
  const [pluginsError, setPluginsError] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusRef = useRef<ComfyStatus | null>(comfyStatus);
  statusRef.current = comfyStatus;

  // 打开时同步设置
  useEffect(() => {
    if (!open) return;
    setError(null);
    setTip(null);
    setStorageTip(null);
    setStorageError(null);
    setAgentTip(null);
    setAgentError(null);
    setPluginsTip(null);
    setPluginsError(null);
    setReconnecting(false);
    setAttempt(0);
    setSettingsLoaded(false);
    setToastFlash(null);
    setSavingAll(false);

    fetchAppSettings()
      .then(s => {
        const savedBase = s.comfyui?.baseUrl || comfyStatus?.baseUrl || '';
        setBaseUrl(savedBase);
        setBaseUrlSaved(savedBase);
        if (s.storage?.outputDir) {
          setOutputDir(s.storage.outputDir);
          setOutputDirSaved(s.storage.outputDir);
        }
        if (s.agent) {
          setAgentModel(s.agent.model);
          setAgentThinking(s.agent.thinking);
          setAgentPoll(s.agent.pollTaskStatus);
          setAgentFabricated(s.agent.fabricatedHistory ?? []);
          setAgentSaved({
            model: s.agent.model,
            thinking: s.agent.thinking,
            pollTaskStatus: s.agent.pollTaskStatus,
            fabricatedHistory: s.agent.fabricatedHistory ?? [],
          });
        }
        if (s.plugins) {
          setPluginDisabled(s.plugins.disabled);
          setPluginsSaved(s.plugins.disabled);
        }
        setSettingsLoaded(true);
        void fetchPlugins().then(setPluginRecords).catch(() => setPluginRecords([]));
        setAgentModelsLoading(true);
        void fetchAgentModels()
          .then(result => setAgentModels(result.models))
          .catch(() => setAgentModels([]))
          .finally(() => setAgentModelsLoading(false));
      })
      .catch(() => {
        if (comfyStatus?.baseUrl) {
          setBaseUrl(comfyStatus.baseUrl);
          setBaseUrlSaved(comfyStatus.baseUrl);
        }
        setSettingsLoaded(true);
      });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // 插件开关草稿：打开时以服务端值为初始值
  useEffect(() => {
    if (!open) return;
    setPluginDraft(new Set(pluginDisabled));
  }, [open, pluginDisabled]);

  const refreshPluginRecords = async () => {
    const records = await fetchPlugins();
    setPluginRecords(records);
    onRefreshWorkflows?.();
  };

  const openMappingEditor = (plugin: WorkflowPluginRecord) => {
    setMappingError(null);
    setMappingTarget(plugin as WorkflowManifest);
  };

  /** 保存映射：成功返回 true 并保持弹窗打开（由弹窗闪现“已保存”反馈），失败返回 false */
  const handleMappingSave = async (manifest: WorkflowManifest): Promise<boolean> => {
    setMappingSaving(true);
    setMappingError(null);
    try {
      const result = await saveWorkflowManifest(manifest.id, manifest);
      setPluginRecords(records => records.map(record => record.id === result.plugin.id ? result.plugin : record));
      onRefreshWorkflows?.();
      return true;
    } catch (e) {
      setMappingError((e as Error).message);
      return false;
    } finally {
      setMappingSaving(false);
    }
  };

  const handleMappingRedetect = async () => {
    if (!mappingTarget) return;
    try {
      const detected = await redetectWorkflowManifest(mappingTarget.id);
      setMappingTarget(detected);
    } catch (e) {
      setMappingError((e as Error).message);
    }
  };

  const handlePluginFile = async (file: File) => {
    setPluginImporting(true);
    setPluginsError(null);
    try {
      const workflow = JSON.parse(await file.text()) as Record<string, unknown>;
      let result;
      try {
        result = await importWorkflowPlugin({ filename: file.name, workflow });
      } catch (e) {
        if (!String((e as Error).message).includes('HTTP 409')) throw e;
        if (!window.confirm(t('settings.plugins.confirmOverwrite', { name: file.name.replace(/\\.json$/i, '')}))) return;
        result = await importWorkflowPlugin({ filename: file.name, workflow, overwrite: true });
      }
      await refreshPluginRecords();
      await openMappingEditor(result.plugin);
    } catch (e) {
      setPluginsError((e as Error).message);
    } finally {
      setPluginImporting(false);
    }
  };

  const handleDeletePlugin = async (plugin: WorkflowPluginRecord) => {
    if (!window.confirm(t('settings.plugins.confirmDelete', { name: plugin.name }))) return;
    try {
      await deleteWorkflowPlugin(plugin.id);
      if (mappingTarget?.id === plugin.id) setMappingTarget(null);
      await refreshPluginRecords();
    } catch (e) {
      setPluginsError((e as Error).message);
    }
  };


  const togglePlugin = (id: string) => {
    setPluginDraft(prev => {
      const next = new Set(prev ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };


  const savePlugins = async (): Promise<boolean> => {
    setPluginsTip(null);
    setPluginsError(null);
    try {
      const disabled = pluginDraft ? [...pluginDraft] : [];
      const res = await savePluginsSettings(disabled);
      if (res.ok) {
        setPluginDisabled(res.plugins.disabled);
        setPluginsSaved(res.plugins.disabled);
        setPluginsTip(t('settings.plugins.savedTip'));
        return true;
      }
      setPluginsError(t('common.saveFailed'));
      return false;
    } catch (e) {
      setPluginsError((e as Error).message);
      return false;
    }
  };

  /** 各分类是否相对已保存值有未提交修改 */
  const dirty = useMemo(
    () => ({
      comfyui: settingsLoaded && baseUrl.trim() !== baseUrlSaved,
      agent:
        settingsLoaded &&
        agentSaved !== null &&
        (agentModel !== agentSaved.model ||
          agentThinking !== agentSaved.thinking ||
          agentPoll !== agentSaved.pollTaskStatus ||
          !objEquals(agentFabricated, agentSaved.fabricatedHistory)),
      storage: settingsLoaded && outputDir.trim() !== outputDirSaved,
      plugins:
        settingsLoaded &&
        pluginsSaved !== null &&
        !setEquals(pluginDraft ?? new Set(), new Set(pluginsSaved)),
    }),
    [settingsLoaded, baseUrl, baseUrlSaved, agentModel, agentThinking, agentPoll, agentFabricated, agentSaved, outputDir, outputDirSaved, pluginDraft, pluginsSaved],
  );
  const isDirty = dirty.comfyui || dirty.agent || dirty.storage || dirty.plugins;

  /** toast 闪现提示（已保存/保存失败） */
  const flashToast = (kind: 'saved' | 'failed') => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    setToastFlash(kind);
    flashTimerRef.current = setTimeout(() => setToastFlash(null), 2200);
  };

  /** 全局保存：仅保存有修改的分类，全部成功才算成功 */
  const handleSaveAll = async () => {
    if (savingAll) return;
    setSavingAll(true);
    let ok = true;
    if (dirty.comfyui) ok = (await saveComfy()) && ok;
    if (dirty.agent) ok = (await saveAgent()) && ok;
    if (dirty.storage) ok = (await saveStorage()) && ok;
    if (dirty.plugins) ok = (await savePlugins()) && ok;
    setSavingAll(false);
    flashToast(ok ? 'saved' : 'failed');
  };

  // Esc 关闭；卸载时清理重连定时器
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (flashTimerRef.current) {
        clearTimeout(flashTimerRef.current);
        flashTimerRef.current = null;
      }
    };
  }, [open, onClose]);

  const stopReconnect = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setReconnecting(false);
    setTip(null);
  };

  /** 保存后若未连上，自动周期性重试直到成功或达到上限 */
  const startAutoReconnect = () => {
    setReconnecting(true);
    setAttempt(0);
    let n = 0;
    const run = () => {
      onRefreshStatus();
      timerRef.current = setTimeout(() => {
        if (statusRef.current?.connected) {
          setReconnecting(false);
          setTip(t('settings.comfyui.connected'));
          onRefreshWorkflows?.();
          return;
        }
        n += 1;
        setAttempt(n);
        if (n >= MAX_ATTEMPTS) {
          setReconnecting(false);
          setTip(t('settings.comfyui.reconnectFailed'));
          return;
        }
        run();
      }, RETRY_INTERVAL);
    };
    run();
  };

  const saveComfy = async (): Promise<boolean> => {
    const url = baseUrl.trim();
    if (!/^https?:\/\//i.test(url)) {
      setError(t('settings.comfyui.urlInvalid'));
      return false;
    }
    setError(null);
    setTip(null);
    stopReconnect();
    try {
      const res = await saveComfySettings(url);
      if (!res.ok) {
        setError(res.error ?? t('common.saveFailed'));
        return false;
      }
      setBaseUrl(res.baseUrl);
      setBaseUrlSaved(res.baseUrl);
      if (res.connected) {
        setTip(t('settings.comfyui.connected'));
        onRefreshStatus();
        onRefreshWorkflows?.();
      } else {
        setTip(t('settings.comfyui.savedReconnecting'));
        startAutoReconnect();
      }
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  const saveStorage = async (): Promise<boolean> => {
    const value = outputDir.trim();
    if (!value.startsWith('/')) {
      setStorageError(t('settings.storage.absoluteRequired'));
      return false;
    }
    setStorageTip(null);
    setStorageError(null);
    try {
      const res = await saveStorageSettings(value);
      setOutputDir(res.storage.outputDir);
      setOutputDirSaved(res.storage.outputDir);
      setStorageTip(t('settings.storage.savedTip'));
      return true;
    } catch (e) {
      setStorageError((e as Error).message);
      return false;
    }
  };

  const saveAgent = async (): Promise<boolean> => {
    setAgentTip(null);
    setAgentError(null);
    try {
      const result = await saveAgentSettings({
        model: agentModel,
        thinking: agentThinking,
        pollTaskStatus: agentPoll,
        fabricatedHistory: agentFabricated,
      });
      if (!result.ok) {
        setAgentError(result.error ?? t('common.saveFailed'));
        return false;
      }
      setAgentModel(result.agent.model);
      setAgentThinking(result.agent.thinking);
      setAgentPoll(result.agent.pollTaskStatus);
      setAgentFabricated(result.agent.fabricatedHistory ?? []);
      setAgentSaved({
        model: result.agent.model,
        thinking: result.agent.thinking,
        pollTaskStatus: result.agent.pollTaskStatus,
        fabricatedHistory: result.agent.fabricatedHistory ?? [],
      });
      setAgentTip(t('settings.agent.savedTip'));
      return true;
    } catch (e) {
      setAgentError((e as Error).message);
      return false;
    }
  };

  /** 更新某条虚构历史消息 */
  const updateFabricated = (index: number, patch: Partial<FabricatedHistoryMessage>) => {
    setAgentFabricated(prev => prev.map((m, i) => (i === index ? { ...m, ...patch } : m)));
  };

  const addFabricated = () => {
    setAgentFabricated(prev => [...prev, { role: 'user', content: '' }]);
  };

  const removeFabricated = (index: number) => {
    setAgentFabricated(prev => prev.filter((_, i) => i !== index));
  };

  if (!open) return null;

  const kindLabel = (kind: string) => t(PLUGIN_KIND_LABEL[kind] as 'common.kindImage');
  const connected = comfyStatus?.connected;
  const statusText = connected
    ? `${t('settings.connected', { url: comfyStatus?.baseUrl ?? baseUrl })}${comfyStatus?.system?.comfyui_version ? ` · v${comfyStatus.system.comfyui_version}` : ''}`
    : comfyStatus?.error
      ? t('settings.disconnectedWithError', { error: comfyStatus.error })
      : t('settings.disconnected');

  // 插件区：只负责导入、映射和启用/停用；combo 参数统一在节点视图中配置。
  const pluginList = pluginRecords.length > 0 ? pluginRecords : workflows;
  const pluginSection = (
    <section className="settings-section">
      <h3 className="settings-section-title">{t('settings.plugins.sectionTitle')}</h3>
      <p className="settings-section-desc">
        {t('settings.plugins.sectionDesc')}
      </p>
      <input ref={fileInputRef} type="file" accept=".json,application/json" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void handlePluginFile(file); }} />
      <div className="workflow-plugin-toolbar">
        <button className="settings-btn primary" disabled={pluginImporting} onClick={() => fileInputRef.current?.click()}>{pluginImporting ? t('settings.plugins.importing') : t('settings.plugins.importBtn')}</button>
        <span className="settings-field-hint">{t('settings.plugins.importHint')}</span>
      </div>
      {pluginList.length === 0 ? (
        <div className="pref-empty">{t('settings.plugins.empty')}</div>
      ) : (
        <div className="plugin-groups">
          {(['image', 'video'] as const).map(kind => {
            const list = pluginList.filter(w => kind === 'video' ? w.outputs.some(o => o.kind === 'video') : !w.outputs.some(o => o.kind === 'video'));
            if (list.length === 0) return null;
            return (
              <div key={kind} className="plugin-group">
                <div className="plugin-group-title">{kind === 'image' ? t('settings.plugins.groupImage') : t('settings.plugins.groupVideo')}</div>
                <div className="plugin-list">
                  {list.map(w => {
                    const disabled = pluginDraft?.has(w.id) ?? false;
                    const record = pluginRecords.find(plugin => plugin.id === w.id);
                    return (
                      <div key={w.id} className={`plugin-card${disabled ? ' off' : ''}`}>
                        <div className="plugin-card-head">
                          <span className="plugin-card-name">{w.name}</span>
                          <div className="plugin-card-acts">
                            <button className="plugin-mapping-btn" onClick={() => record && void openMappingEditor(record)} title={t('settings.plugins.mappingTitle')}>{t('settings.plugins.mappingBtn')}</button>
                            {record && <button className="plugin-delete-btn" onClick={() => void handleDeletePlugin(record)} title={t('settings.plugins.deleteTitle')}>{t('common.delete')}</button>}
                            <button className={`plugin-toggle${disabled ? '' : ' on'}`} onClick={() => togglePlugin(w.id)} role="switch" aria-checked={!disabled} aria-label={t('settings.plugins.toggleAria', { action: disabled ? t('settings.plugins.enable') : t('settings.plugins.disable'), name: w.name })}>
                              <span className="plugin-toggle-knob" />
                            </button>
                          </div>
                        </div>
                        {w.description && <div className="plugin-card-desc">{w.description}</div>}
                        {record?.manifestError && <div className="settings-error">{t('settings.plugins.manifestError', { error: record.manifestError })}</div>}
                        {record?.source && <div className="plugin-card-source">{record.source.type === 'imported' ? t('settings.plugins.sourceImported') : record.hasManifest ? t('settings.plugins.sourceEdited') : t('settings.plugins.sourceAuto')}</div>}
                        <div className="plugin-card-badges">
                          {w.inputs.map(i => <em key={i.id} className={`wf-badge in ${i.kind}`}>{i.required ? t('settings.plugins.badgeInRequired', { kind: kindLabel(i.kind) }) : t('settings.plugins.badgeIn', { kind: kindLabel(i.kind) })}</em>)}
                          {w.outputs.map(o => <em key={o.id} className={`wf-badge out ${o.kind}`}>{t('settings.plugins.badgeOut', { kind: kindLabel(o.kind) })}</em>)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {pluginsError && <div className="settings-error">{pluginsError}</div>}
      {pluginsTip && <div className="settings-tip">{pluginsTip}</div>}
      {mappingTarget && <WorkflowMappingModal manifest={mappingTarget} saving={mappingSaving} error={mappingError} onSave={handleMappingSave} onRedetect={handleMappingRedetect} onClose={() => setMappingTarget(null)} />}
    </section>
  );

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" role="dialog" aria-modal="true" aria-label={t('common.settings')} onClick={e => e.stopPropagation()}>
        <header className="settings-header">
          <h2 className="settings-title">{t('common.settings')}</h2>
          <button className="settings-close" onClick={onClose} aria-label={t('common.close')}>
            ×
          </button>
        </header>
        <div className="settings-body">
          <nav className="settings-cats" aria-label={t('settings.catsAria')}>
            {CATEGORIES.map(c => (
              <button
                key={c.id}
                className={`settings-cat${active === c.id ? ' active' : ''}`}
                onClick={() => setActive(c.id)}
              >
                {c.icon}
                <span>{t(CATEGORY_KEY[c.id] as 'settings.catComfyui')}</span>
              </button>
            ))}
          </nav>
          <div className="settings-pane">
            {active === 'comfyui' && (
              <section className="settings-section">
                <h3 className="settings-section-title">{t('settings.comfyui.title')}</h3>
                <p className="settings-section-desc">
                  {t('settings.comfyui.desc')}
                </p>
                <label className="settings-field">
                  <span className="settings-label">{t('settings.comfyui.url')}</span>
                  <input
                    className="settings-input"
                    value={baseUrl}
                    onChange={e => setBaseUrl(e.target.value)}
                    placeholder="http://127.0.0.1:8188"
                    spellCheck={false}
                  />
                </label>
                <div className="settings-status">
                  <span className={`settings-dot ${connected ? 'ok' : 'bad'}`} />
                  <span>{statusText}</span>
                  {reconnecting && <span className="settings-retry">{t('settings.comfyui.reconnecting', { n: attempt, max: MAX_ATTEMPTS })}</span>}
                </div>
                {error && <div className="settings-error">{error}</div>}
                {tip && <div className="settings-tip">{tip}</div>}
                {reconnecting && (
                  <div className="settings-actions">
                    <button className="settings-btn" onClick={stopReconnect}>
                      {t('settings.comfyui.stopRetry')}
                    </button>
                  </div>
                )}
              </section>
            )}

            {active === 'agent' && (
              <section className="settings-section">
                <h3 className="settings-section-title">{t('settings.agent.title')}</h3>
                <p className="settings-section-desc">
                  {t('settings.agent.desc')}
                </p>
                <label className="settings-field">
                  <span className="settings-label">{t('settings.agent.model')}</span>
                  <select
                    className="settings-select"
                    value={agentModel}
                    onChange={e => setAgentModel(e.target.value)}
                  >
                    <option value="">{t('settings.agent.useDefault')}</option>
                    {agentModel && !agentModels.some(model => model.id === agentModel) && (
                      <option value={agentModel}>{t('settings.agent.currentValue', { model: agentModel })}</option>
                    )}
                    {agentModels.map(model => (
                      <option key={model.id} value={model.id}>
                        {model.id}{model.thinking ? t('settings.agent.supportsThinking') : ''}{model.images ? t('settings.agent.supportsImages') : ''}
                      </option>
                    ))}
                  </select>
                  <span className="settings-field-hint">
                    {agentModelsLoading ? t('settings.agent.modelsLoading') : t('settings.agent.modelsHint')}
                  </span>
                </label>
                <label className="settings-field">
                  <span className="settings-label">{t('settings.agent.thinkingLabel')}</span>
                  <select
                    className="settings-select"
                    value={agentThinking}
                    onChange={e => setAgentThinking(e.target.value as AgentThinking)}
                  >
                    <option value="off">{t('settings.agent.thinkingOff')}</option>
                    <option value="minimal">{t('settings.agent.thinkingMinimal')}</option>
                    <option value="low">{t('settings.agent.thinkingLow')}</option>
                    <option value="medium">{t('settings.agent.thinkingMedium')}</option>
                    <option value="high">{t('settings.agent.thinkingHigh')}</option>
                    <option value="xhigh">{t('settings.agent.thinkingXhigh')}</option>
                    <option value="max">{t('settings.agent.thinkingMax')}</option>
                  </select>
                  <span className="settings-field-hint">{t('settings.agent.thinkingHint')}</span>
                </label>
                <label className="settings-field">
                  <span className="settings-switch-head">
                    <span className="settings-label">{t('settings.agent.pollLabel')}</span>
                    <button
                      className={`plugin-toggle${agentPoll ? ' on' : ''}`}
                      onClick={() => setAgentPoll(v => !v)}
                      role="switch"
                      aria-checked={agentPoll}
                      aria-label={t('settings.agent.pollAria')}
                    >
                      <span className="plugin-toggle-knob" />
                    </button>
                  </span>
                  <span className="settings-field-hint">
                    {t('settings.agent.pollHint')}
                  </span>
                </label>
                <div className="settings-field">
                  <span className="settings-label">{t('settings.agent.fabricatedLabel')}</span>
                  <span className="settings-field-hint">
                    {t('settings.agent.fabricatedHint')}
                  </span>
                  <div className="fabricated-list">
                    {agentFabricated.length === 0 && (
                      <div className="fabricated-empty">{t('settings.agent.fabricatedEmpty')}</div>
                    )}
                    {agentFabricated.map((m, i) => (
                      <div key={i} className="fabricated-row">
                        <select
                          className="settings-select fabricated-role"
                          value={m.role}
                          onChange={e => updateFabricated(i, { role: e.target.value as FabricatedHistoryMessage['role'] })}
                          aria-label={t('settings.agent.fabricatedRoleAria', { n: i + 1 })}
                        >
                          {(Object.keys(ROLE_KEY) as FabricatedHistoryMessage['role'][]).map(r => (
                            <option key={r} value={r}>
                              {t(ROLE_KEY[r] as 'settings.agent.roleSystem')}
                            </option>
                          ))}
                        </select>
                        <input
                          className="settings-input fabricated-content"
                          value={m.content}
                          onChange={e => updateFabricated(i, { content: e.target.value })}
                          placeholder={t('settings.agent.messageContent')}
                        />
                        <button
                          className="fabricated-del"
                          onClick={() => removeFabricated(i)}
                          aria-label={t('settings.agent.fabricatedDeleteAria', { n: i + 1 })}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                  <button className="settings-btn fabricated-add" onClick={addFabricated}>
                    {t('settings.agent.addMessage')}
                  </button>
                </div>
                {agentError && <div className="settings-error">{agentError}</div>}
                {agentTip && <div className="settings-tip">{agentTip}</div>}
              </section>
            )}

            {active === 'storage' && (
              <section className="settings-section">
                <h3 className="settings-section-title">{t('settings.storage.title')}</h3>
                <p className="settings-section-desc">
                  {t('settings.storage.desc')}
                </p>
                <label className="settings-field">
                  <span className="settings-label">{t('settings.storage.dir')}</span>
                  <input
                    className="settings-input"
                    value={outputDir}
                    onChange={e => setOutputDir(e.target.value)}
                    placeholder="/path/to/director-workbench/server/data/drafts"
                    spellCheck={false}
                  />
                </label>
                <div className="storage-path-hint">{t('settings.storage.dirHint')}</div>
                {storageError && <div className="settings-error">{storageError}</div>}
                {storageTip && <div className="settings-tip">{storageTip}</div>}
              </section>
            )}

            {active === 'plugins' && pluginSection}

          </div>
        </div>
        {(isDirty || toastFlash) && (
          <div className="settings-save-toast" role="status">
            <span className="settings-save-toast-msg">
              {savingAll
                ? t('common.saving')
                : toastFlash === 'saved'
                  ? t('common.saved')
                  : toastFlash === 'failed'
                    ? t('common.saveFailedToast')
                    : t('common.unsavedPrompt')}
            </span>
            {!savingAll && toastFlash !== 'saved' && (
              <button className="settings-btn primary" onClick={handleSaveAll}>
                {t('common.save')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
