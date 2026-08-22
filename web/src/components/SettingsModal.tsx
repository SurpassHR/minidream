import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchAgentModels,
  fetchAppSettings,
  saveAgentSettings,
  saveComfySettings,
  savePluginsSettings,
  saveStorageSettings,
  type AgentModel,
  type AgentThinking,
  type ComfyStatus,
  type FabricatedHistoryMessage,
  type WorkflowParam,
  type WorkflowSpec,
} from '../api';
import FilterSelect from './FilterSelect';

interface Category {
  id: string;
  label: string;
  icon: React.ReactNode;
}

const MAX_ATTEMPTS = 12;
const RETRY_INTERVAL = 2000;

const CATEGORIES: Category[] = [
  {
    id: 'comfyui',
    label: 'ComfyUI 服务',
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
    label: 'Agent 配置',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <path d="M9 2.25a4 4 0 0 0-4 4v2.5a4 4 0 0 0 8 0v-2.5a4 4 0 0 0-4-4Z" stroke="currentColor" strokeWidth="1.3" />
        <path d="M2.75 8.5v1.25a6.25 6.25 0 0 0 12.5 0V8.5M9 14.75v1.5M6.5 16.25h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'storage',
    label: '产物存储',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h3l1.5 1.5H14A1.5 1.5 0 0 1 15.5 7v6A1.5 1.5 0 0 1 14 14.5H4A1.5 1.5 0 0 1 2.5 13v-7.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M5.5 9.5h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'plugins',
    label: '插件',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <path d="M6 2.5v2M12 2.5v2M4.5 4.5h9v3A2.5 2.5 0 0 1 11 10H7a2.5 2.5 0 0 1-2.5-2.5v-3Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M9 10v5.5M6.5 15.5h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    ),
  },
];

const PLUGIN_KIND_LABEL = { image: '图片', video: '视频', text: '文本' };

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

  // 插件（工作流）状态：停用列表 + 参数配置（workflowId → { paramId: 值 }）
  const [pluginDisabled, setPluginDisabled] = useState<string[]>([]);
  const [pluginDraft, setPluginDraft] = useState<Set<string> | null>(null);
  const [pluginConfig, setPluginConfig] = useState<Record<string, Record<string, string>>>({});
  const [pluginConfigDraft, setPluginConfigDraft] = useState<Record<string, Record<string, string>> | null>(null);
  /** 当前进入插件详情设置的工作流 id；null 表示显示插件列表 */
  const [configTarget, setConfigTarget] = useState<string | null>(null);
  const [pluginsTip, setPluginsTip] = useState<string | null>(null);
  const [pluginsSaved, setPluginsSaved] = useState<{ disabled: string[]; config: Record<string, Record<string, string>> } | null>(null);
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
          setPluginConfig(s.plugins.config ?? {});
          setPluginsSaved({ disabled: s.plugins.disabled, config: s.plugins.config ?? {} });
        }
        setSettingsLoaded(true);
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

  // 插件开关与参数配置草稿：打开时以服务端值为初始值
  useEffect(() => {
    if (!open) return;
    setPluginDraft(new Set(pluginDisabled));
    setPluginConfigDraft(pluginConfig);
    setConfigTarget(null);
  }, [open, pluginDisabled, pluginConfig, workflows]);

  const togglePlugin = (id: string) => {
    setPluginDraft(prev => {
      const next = new Set(prev ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** 更新某工作流的参数覆盖草稿 */
  const setPluginParam = (wfId: string, paramId: string, value: string) => {
    setPluginConfigDraft(prev => {
      const base = prev ?? {};
      const wf = { ...(base[wfId] ?? {}) };
      wf[paramId] = value;
      return { ...base, [wfId]: wf };
    });
  };

  /** 当前 select 显示值：覆盖配置 → 工作流默认值 → 选项首项 */
  const configValueOf = (wfId: string, param: WorkflowParam): string => {
    const overridden = pluginConfigDraft?.[wfId]?.[param.id];
    if (overridden) return overridden;
    const options = param.options ?? [];
    const def = typeof param.default === 'string' ? param.default : undefined;
    if (def && options.includes(def)) return def;
    return options[0] ?? '';
  };

  /** 该工作流可配置的 combo 参数（模型/CLIP/VAE/LoRA/采样器/调度器等） */
  const comboParamsOf = (wf: WorkflowSpec): WorkflowParam[] =>
    wf.params.filter(p => p.type === 'combo' && (p.options?.length ?? 0) > 0);

  const savePlugins = async (): Promise<boolean> => {
    setPluginsTip(null);
    setPluginsError(null);
    try {
      const disabled = pluginDraft ? [...pluginDraft] : [];
      const config = pluginConfigDraft ?? {};
      const res = await savePluginsSettings(disabled, config);
      if (res.ok) {
        setPluginDisabled(res.plugins.disabled);
        setPluginConfig(res.plugins.config);
        setPluginsSaved({ disabled: res.plugins.disabled, config: res.plugins.config });
        setPluginsTip('插件配置已保存并生效');
        return true;
      }
      setPluginsError('保存失败');
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
        (!setEquals(pluginDraft ?? new Set(), new Set(pluginsSaved.disabled)) ||
          !objEquals(pluginConfigDraft ?? {}, pluginsSaved.config)),
    }),
    [settingsLoaded, baseUrl, baseUrlSaved, agentModel, agentThinking, agentPoll, agentFabricated, agentSaved, outputDir, outputDirSaved, pluginDraft, pluginConfigDraft, pluginsSaved],
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
          setTip('已连接');
          onRefreshWorkflows?.();
          return;
        }
        n += 1;
        setAttempt(n);
        if (n >= MAX_ATTEMPTS) {
          setReconnecting(false);
          setTip('自动重连未成功，请检查地址后重试');
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
      setError('地址需以 http:// 或 https:// 开头');
      return false;
    }
    setError(null);
    setTip(null);
    stopReconnect();
    try {
      const res = await saveComfySettings(url);
      if (!res.ok) {
        setError(res.error ?? '保存失败');
        return false;
      }
      setBaseUrl(res.baseUrl);
      setBaseUrlSaved(res.baseUrl);
      if (res.connected) {
        setTip('已连接');
        onRefreshStatus();
        onRefreshWorkflows?.();
      } else {
        setTip('地址已保存，正在自动重连…');
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
      setStorageError('产物存储目录必须是绝对路径');
      return false;
    }
    setStorageTip(null);
    setStorageError(null);
    try {
      const res = await saveStorageSettings(value);
      setOutputDir(res.storage.outputDir);
      setOutputDirSaved(res.storage.outputDir);
      setStorageTip('产物存储目录已保存并生效');
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
        setAgentError(result.error ?? '保存失败');
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
      setAgentTip('Agent 配置已保存并生效');
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

  const FABRICATED_ROLE_LABEL: Record<FabricatedHistoryMessage['role'], string> = {
    system: '系统',
    user: '用户',
    assistant: '助手',
  };

  if (!open) return null;

  const connected = comfyStatus?.connected;
  const statusText = connected
    ? `已连接（${comfyStatus?.baseUrl ?? baseUrl}）${comfyStatus?.system?.comfyui_version ? `· v${comfyStatus.system.comfyui_version}` : ''}`
    : `未连接${comfyStatus?.error ? `：${comfyStatus.error}` : ''}`;

  // 插件区：列表视图 ↔ 单插件详情设置（钻取）
  const pluginTarget = configTarget ? (workflows.find(w => w.id === configTarget) ?? null) : null;
  const pluginSection = pluginTarget ? (
    <section className="settings-section">
      <button className="plugin-detail-back" onClick={() => setConfigTarget(null)}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M8.5 3 4.5 7l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        返回插件列表
      </button>
      <h3 className="settings-section-title plugin-detail-title">{pluginTarget.name}</h3>
      <p className="settings-section-desc">
        配置该插件使用的模型与采样参数（扩散模型、CLIP、VAE、LoRA、采样器、调度器等，选项来自 ComfyUI
        节点）。{pluginDraft?.has(pluginTarget.id) ? '该插件当前已停用，配置将保留。' : ''}
      </p>
      {comboParamsOf(pluginTarget).length === 0 ? (
        <div className="pref-empty">该插件没有可配置参数（需连接 ComfyUI 才能读取节点选项）</div>
      ) : (
        <div className="plugin-detail-grid">
          {comboParamsOf(pluginTarget).map(param => (
            <label key={param.id} className="plugin-config-field">
              <span className="plugin-config-label">{param.label}</span>
              <FilterSelect
                className="plugin-config-select"
                value={configValueOf(pluginTarget.id, param)}
                onChange={v => setPluginParam(pluginTarget.id, param.id, v)}
                options={param.options ?? []}
                ariaLabel={param.label}
                searchPlaceholder={`筛选 ${param.label}…`}
              />
            </label>
          ))}
        </div>
      )}
      {pluginsError && <div className="settings-error">{pluginsError}</div>}
      {pluginsTip && <div className="settings-tip">{pluginsTip}</div>}
    </section>
  ) : (
    <section className="settings-section">
      <h3 className="settings-section-title">生成插件（工作流）</h3>
      <p className="settings-section-desc">
        启用/停用生成插件，点击插件右侧的设置按钮可配置该插件的模型与采样参数（扩散模型、CLIP、VAE、
        LoRA、采样器、调度器等，选项来自 ComfyUI 节点）。停用的插件不会出现在生成流程中。
      </p>
      {workflows.length === 0 ? (
        <div className="pref-empty">暂无插件：请把 workflow 文件放到 server/workflows/</div>
      ) : (
        <div className="plugin-groups">
          {(['image', 'video'] as const).map(kind => {
            const list = workflows.filter(w =>
              kind === 'video'
                ? w.outputs.some(o => o.kind === 'video')
                : w.outputs.some(o => o.kind === 'image'),
            );
            if (list.length === 0) return null;
            return (
              <div key={kind} className="plugin-group">
                <div className="plugin-group-title">{kind === 'image' ? '图像' : '视频'}</div>
                <div className="plugin-list">
                  {list.map(w => {
                    const disabled = pluginDraft?.has(w.id) ?? false;
                    const hasConfig = comboParamsOf(w).length > 0;
                    return (
                      <div key={w.id} className={`plugin-card${disabled ? ' off' : ''}`}>
                        <div className="plugin-card-head">
                          <span className="plugin-card-name">{w.name}</span>
                          <div className="plugin-card-acts">
                            {hasConfig && (
                              <button
                                className="plugin-config-btn"
                                onClick={() => setConfigTarget(w.id)}
                                title="插件设置"
                                aria-label={`设置 ${w.name}`}
                              >
                                <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                                  <circle cx="8" cy="8" r="2.6" stroke="currentColor" strokeWidth="1.3" />
                                  <path
                                    d="M8 1.8v1.9M8 12.3v1.9M1.8 8h1.9M12.3 8h1.9M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6 11 5M5 11l-1.4 1.4"
                                    stroke="currentColor"
                                    strokeWidth="1.3"
                                    strokeLinecap="round"
                                  />
                                </svg>
                              </button>
                            )}
                            <button
                              className={`plugin-toggle${disabled ? '' : ' on'}`}
                              onClick={() => togglePlugin(w.id)}
                              role="switch"
                              aria-checked={!disabled}
                              aria-label={`${disabled ? '启用' : '停用'} ${w.name}`}
                            >
                              <span className="plugin-toggle-knob" />
                            </button>
                          </div>
                        </div>
                        {w.description && <div className="plugin-card-desc">{w.description}</div>}
                        <div className="plugin-card-badges">
                          {w.inputs.map(i => (
                            <em key={i.id} className={`wf-badge in ${i.kind}`}>
                              输入·{PLUGIN_KIND_LABEL[i.kind]}
                              {i.required ? '·必传' : ''}
                            </em>
                          ))}
                          {w.outputs.map(o => (
                            <em key={o.id} className={`wf-badge out ${o.kind}`}>
                              输出·{PLUGIN_KIND_LABEL[o.kind]}
                            </em>
                          ))}
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
    </section>
  );

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" role="dialog" aria-modal="true" aria-label="设置" onClick={e => e.stopPropagation()}>
        <header className="settings-header">
          <h2 className="settings-title">设置</h2>
          <button className="settings-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="settings-body">
          <nav className="settings-cats" aria-label="设置分类">
            {CATEGORIES.map(c => (
              <button
                key={c.id}
                className={`settings-cat${active === c.id ? ' active' : ''}`}
                onClick={() => setActive(c.id)}
              >
                {c.icon}
                <span>{c.label}</span>
              </button>
            ))}
          </nav>
          <div className="settings-pane">
            {active === 'comfyui' && (
              <section className="settings-section">
                <h3 className="settings-section-title">ComfyUI 连接</h3>
                <p className="settings-section-desc">
                  生成任务与素材上传都由服务端代理到这个地址。保存新地址后会自动尝试重连。
                </p>
                <label className="settings-field">
                  <span className="settings-label">ComfyUI 地址</span>
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
                  {reconnecting && <span className="settings-retry">正在自动重连（{attempt}/{MAX_ATTEMPTS}）…</span>}
                </div>
                {error && <div className="settings-error">{error}</div>}
                {tip && <div className="settings-tip">{tip}</div>}
                {reconnecting && (
                  <div className="settings-actions">
                    <button className="settings-btn" onClick={stopReconnect}>
                      停止重试
                    </button>
                  </div>
                )}
              </section>
            )}

            {active === 'agent' && (
              <section className="settings-section">
                <h3 className="settings-section-title">Agent 配置</h3>
                <p className="settings-section-desc">
                  选择创作 Agent 使用的默认模型与思考强度。配置会保存到服务端，并应用于后续对话。
                </p>
                <label className="settings-field">
                  <span className="settings-label">默认模型</span>
                  <select
                    className="settings-select"
                    value={agentModel}
                    onChange={e => setAgentModel(e.target.value)}
                  >
                    <option value="">使用 Pi 默认模型</option>
                    {agentModel && !agentModels.some(model => model.id === agentModel) && (
                      <option value={agentModel}>{agentModel}（当前值）</option>
                    )}
                    {agentModels.map(model => (
                      <option key={model.id} value={model.id}>
                        {model.id}{model.thinking ? ' · 支持思考' : ''}{model.images ? ' · 支持图片' : ''}
                      </option>
                    ))}
                  </select>
                  <span className="settings-field-hint">
                    {agentModelsLoading ? '正在读取 Pi 模型列表…' : '模型列表来自当前 Pi 配置；列表为空时仍可使用 Pi 默认模型'}
                  </span>
                </label>
                <label className="settings-field">
                  <span className="settings-label">思考强度</span>
                  <select
                    className="settings-select"
                    value={agentThinking}
                    onChange={e => setAgentThinking(e.target.value as AgentThinking)}
                  >
                    <option value="off">关闭</option>
                    <option value="minimal">最低</option>
                    <option value="low">低</option>
                    <option value="medium">中</option>
                    <option value="high">高</option>
                    <option value="xhigh">极高</option>
                    <option value="max">最大</option>
                  </select>
                  <span className="settings-field-hint">思考越深通常响应越慢；最低是当前 v2 默认值。</span>
                </label>
                <label className="settings-field">
                  <span className="settings-switch-head">
                    <span className="settings-label">Agent 轮询生成状态</span>
                    <button
                      className={`plugin-toggle${agentPoll ? ' on' : ''}`}
                      onClick={() => setAgentPoll(v => !v)}
                      role="switch"
                      aria-checked={agentPoll}
                      aria-label="Agent 轮询生成状态"
                    >
                      <span className="plugin-toggle-knob" />
                    </button>
                  </span>
                  <span className="settings-field-hint">
                    开启后 Agent 会主动查询任务状态，并在完成后输出结果摘要（更慢、更耗 token）；关闭则依赖实时事件流推送进度与产物，响应更快。
                  </span>
                </label>
                <div className="settings-field">
                  <span className="settings-label">虚构对话历史（每请求注入）</span>
                  <span className="settings-field-hint">
                    只要有配置，就**每个对话请求**都注入：把下面的虚构对话构建为真实交替的用户/助手消息，在每次 LLM 调用前注入请求头部（参考 custom-first-control-prompt 请求路径注入——种子消息只在请求路径上、不写入会话日志，因此必须每次请求重新注入，否则后续轮次模型会“遗忘”准则；前缀字节级一致，保持缓存复用）。内容和条数都可自由配置；留空则不注入。
                  </span>
                  <div className="fabricated-list">
                    {agentFabricated.length === 0 && (
                      <div className="fabricated-empty">尚未配置，将不注入参考对话，模型直接使用真实消息。</div>
                    )}
                    {agentFabricated.map((m, i) => (
                      <div key={i} className="fabricated-row">
                        <select
                          className="settings-select fabricated-role"
                          value={m.role}
                          onChange={e => updateFabricated(i, { role: e.target.value as FabricatedHistoryMessage['role'] })}
                          aria-label={`第 ${i + 1} 条虚构历史角色`}
                        >
                          {(Object.keys(FABRICATED_ROLE_LABEL) as FabricatedHistoryMessage['role'][]).map(r => (
                            <option key={r} value={r}>
                              {FABRICATED_ROLE_LABEL[r]}
                            </option>
                          ))}
                        </select>
                        <input
                          className="settings-input fabricated-content"
                          value={m.content}
                          onChange={e => updateFabricated(i, { content: e.target.value })}
                          placeholder="消息内容"
                        />
                        <button
                          className="fabricated-del"
                          onClick={() => removeFabricated(i)}
                          aria-label={`删除第 ${i + 1} 条虚构历史`}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                  <button className="settings-btn fabricated-add" onClick={addFabricated}>
                    + 添加消息
                  </button>
                </div>
                {agentError && <div className="settings-error">{agentError}</div>}
                {agentTip && <div className="settings-tip">{agentTip}</div>}
              </section>
            )}

            {active === 'storage' && (
              <section className="settings-section">
                <h3 className="settings-section-title">生成产物存储</h3>
                <p className="settings-section-desc">
                  生成完成后，项目会把 ComfyUI 的临时产物转存到这里，并使用本地文件作为草稿和聊天结果。
                </p>
                <label className="settings-field">
                  <span className="settings-label">本地存储目录（绝对路径）</span>
                  <input
                    className="settings-input"
                    value={outputDir}
                    onChange={e => setOutputDir(e.target.value)}
                    placeholder="/path/to/director-workbench/server/data/drafts"
                    spellCheck={false}
                  />
                </label>
                <div className="storage-path-hint">目录不存在时会自动创建；需要当前服务进程具备读写权限。</div>
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
                ? '保存中…'
                : toastFlash === 'saved'
                  ? '已保存 ✓'
                  : toastFlash === 'failed'
                    ? '保存失败，请检查对应面板的提示'
                    : '有配置已修改，是否保存？'}
            </span>
            {!savingAll && toastFlash !== 'saved' && (
              <button className="settings-btn primary" onClick={handleSaveAll}>
                保存
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
