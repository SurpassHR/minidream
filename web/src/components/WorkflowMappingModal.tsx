import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  chatPluginSkill,
  fetchPluginSkill,
  fetchWorkflowGraph,
  generatePluginSkillLlm,
  savePluginSkill,
  fetchPluginResponse,
  savePluginResponse,
  regeneratePluginResponse,
  type PluginResponseProtocol,
  type WorkflowGraph,
  type WorkflowGraphField,
  type WorkflowManifest,
  type PluginSkillChatMessage,
  type WorkflowParam,
} from '../api';
import WorkflowNodeGraph from './WorkflowNodeGraph';
import { isParamSelected, paramForField, removeParam, addParamFromField, pinComboValue, setParamExposed } from './workflowMappingDraft';
import './WorkflowMappingModal.css';

interface Props {
  manifest: WorkflowManifest;
  saving?: boolean;
  error?: string | null;
  onSave: (manifest: WorkflowManifest) => void;
  onRedetect: () => void;
  onClose: () => void;
}

type ResponseProtocolBlock = PluginResponseProtocol['blocks'][number];

type ResponseSourceOption = { source: string; label: string; group: string };

function copyManifest(manifest: WorkflowManifest): WorkflowManifest {
  const copy = JSON.parse(JSON.stringify(manifest)) as WorkflowManifest;
  // 未保存的自动识别结果只作为节点图候选，参数必须由用户在节点视图中显式勾选。
  if (!manifest.hasManifest) copy.params = [];
  return copy;
}

export default function WorkflowMappingModal({ manifest, saving, error, onSave, onRedetect, onClose }: Props) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(() => copyManifest(manifest));
  const [view, setView] = useState<'node' | 'form' | 'skill' | 'response'>('node');
  const [fullscreen, setFullscreen] = useState(false);
  const [graph, setGraph] = useState<WorkflowGraph | null>(null);
  const [graphLoading, setGraphLoading] = useState(true);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [redetectNotice, setRedetectNotice] = useState(false);
  const [skillContent, setSkillContent] = useState<string | null>(null);
  const [skillLoading, setSkillLoading] = useState(false);
  const [skillError, setSkillError] = useState<string | null>(null);
  const [skillLoaded, setSkillLoaded] = useState(false);
  const [skillSaving, setSkillSaving] = useState(false);
  const [skillGenerating, setSkillGenerating] = useState(false);
  const [skillChatMessages, setSkillChatMessages] = useState<PluginSkillChatMessage[]>([]);
  const [skillChatInput, setSkillChatInput] = useState('');
  const [skillChatSending, setSkillChatSending] = useState(false);
  const [responseProtocol, setResponseProtocol] = useState<PluginResponseProtocol | null>(null);
  const [responseLoading, setResponseLoading] = useState(false);
  const [responseSaving, setResponseSaving] = useState(false);
  const [responseError, setResponseError] = useState<string | null>(null);

  const loadGraph = async (id: string) => {
    setGraphLoading(true);
    setGraphError(null);
    try {
      const result = await fetchWorkflowGraph(id);
      setGraph(result.graph);
    } catch (e) {
      setGraph(null);
      setGraphError((e as Error).message);
    } finally {
      setGraphLoading(false);
    }
  };

  const loadSkill = async (id: string) => {
    setSkillLoading(true);
    setSkillError(null);
    try {
      setSkillContent(await fetchPluginSkill(id));
      setSkillLoaded(true);
    } catch (e) {
      setSkillContent(null);
      setSkillError((e as Error).message);
    } finally {
      setSkillLoading(false);
    }
  };

  const loadResponse = async (id: string) => {
    setResponseLoading(true);
    setResponseError(null);
    try {
      const result = await fetchPluginResponse(id);
      setResponseProtocol(JSON.parse(JSON.stringify(result.protocol)) as PluginResponseProtocol);
    } catch (e) {
      setResponseProtocol(null);
      setResponseError((e as Error).message);
    } finally {
      setResponseLoading(false);
    }
  };

  const selectView = (next: 'node' | 'form' | 'skill' | 'response') => {
    setView(next);
    if (next === 'skill' && !skillLoaded) void loadSkill(draft.id);
    if (next === 'response' && responseProtocol === null) void loadResponse(draft.id);
  };

  const generateSkill = async (id: string) => {
    setSkillGenerating(true);
    setSkillError(null);
    try {
      const res = await generatePluginSkillLlm(id);
      setSkillContent(res.content);
      setSkillLoaded(true);
    } catch (e) {
      setSkillError((e as Error).message);
    } finally {
      setSkillGenerating(false);
    }
  };

  const sendSkillChat = async (id: string) => {
    const message = skillChatInput.trim();
    if (!message || skillChatSending) return;
    const userTurn: PluginSkillChatMessage = { role: 'user', content: message };
    const history = [...skillChatMessages, userTurn];
    setSkillChatMessages(history);
    setSkillChatInput('');
    setSkillChatSending(true);
    setSkillError(null);
    try {
      const result = await chatPluginSkill(id, message, skillChatMessages, skillContent ?? '');
      setSkillContent(result.skill);
      setSkillLoaded(true);
      setSkillChatMessages(current => [...current, { role: 'assistant', content: result.reply }]);
    } catch (e) {
      setSkillError((e as Error).message);
    } finally {
      setSkillChatSending(false);
    }
  };

  const saveSkill = async (id: string) => {
    if (skillContent === null) return;
    setSkillSaving(true);
    setSkillError(null);
    try {
      const result = await savePluginSkill(id, skillContent);
      setSkillContent(result.content);
      setSkillLoaded(true);
    } catch (e) {
      setSkillError((e as Error).message);
    } finally {
      setSkillSaving(false);
    }
  };

  useEffect(() => {
    setDraft(copyManifest(manifest));
    setLocalError(null);
    setSkillLoaded(false);
    setSkillContent(null);
    setSkillError(null);
    setSkillChatMessages([]);
    setSkillChatInput('');
    setSkillChatSending(false);
    setResponseProtocol(null);
    setResponseError(null);
    void loadGraph(manifest.id);
  }, [manifest]);

  const update = (patch: Partial<WorkflowManifest>) => setDraft(current => ({ ...current, ...patch }));
  const updateParam = (index: number, patch: Partial<WorkflowParam>) => setDraft(current => ({ ...current, params: current.params.map((item, i) => i === index ? { ...item, ...patch } : item) }));

  const displayGraph = useMemo<WorkflowGraph | null>(() => {
    if (!graph) return null;
    return {
      ...graph,
      nodes: graph.nodes.map(node => ({
        ...node,
        fields: node.fields.map(field => {
          const selected = isParamSelected(draft, field);
          const param = paramForField(draft, field);
          return {
            ...field,
            selected,
            paramId: param?.id,
            ...(param ? { value: param.default, multiple: param.multiple, strengthable: param.strengthable } : {}),
          };
        }),
      })),
    };
  }, [graph, draft]);

  /** 直接在节点视图配置 combo 值：无参数时生成一个不加入 LLM 上下文的固定参数 */
  const updateParamDefault = (field: WorkflowGraphField, value: unknown) => {
    setDraft(current => pinComboValue(current, field, value));
  };

  /** 完全移除参数（含固定值），恢复模板默认 */
  const removePinnedParam = (field: WorkflowGraphField) => {
    const existing = paramForField(draft, field);
    if (existing?.description) {
      if (!window.confirm(t('mapping.confirmRemoveParam', { label: existing.label, desc: existing.description }))) return;
    }
    setDraft(current => removeParam(current, field));
  };

  const toggleField = (field: WorkflowGraphField) => {
    if (!field.selectable || field.connected) return;
    const existing = paramForField(draft, field);
    if (existing) {
      if (isParamSelected(draft, field)) {
        // 取消勾选：combo 保留固定值仅退出 LLM 上下文；普通参数无独立配置，整项删除
        if (field.type === 'COMBO') {
          setDraft(current => setParamExposed(current, field, false));
          return;
        }
        const detail = existing.description ? `\n${t('mapping.confirmUncheckDetail', { desc: existing.description })}` : '';
        if (!window.confirm(t('mapping.confirmUncheckParam', { label: existing.label, detail }))) return;
        setDraft(current => removeParam(current, field));
        return;
      }
      // 已固定的 combo → 勾选加入 LLM 上下文
      setDraft(current => setParamExposed(current, field, true));
      return;
    }
    setDraft(current => addParamFromField(current, field));
  };

  const exposedParams = useMemo(() => draft.params.filter(item => item.llm !== false), [draft.params]);
  const responseSources = useMemo<ResponseSourceOption[]>(() => [
    { source: 'generation.prompt', label: t('mapping.source.finalPrompt'), group: t('mapping.group.generation') },
    ...(draft.params.some(item => !item.hidden && item.llm !== false && /负面|反面|negative/i.test(`${item.label} ${item.description ?? ''}`)) ? [{ source: 'generation.negativePrompt', label: t('mapping.source.finalNegativePrompt'), group: t('mapping.group.generation') }] : []),
    { source: 'generation.workflowName', label: t('mapping.source.workflowName'), group: t('mapping.group.generation') },
    { source: 'generation.intent', label: t('mapping.source.intent'), group: t('mapping.group.generation') },
    { source: 'route.requestedWorkflow', label: t('mapping.source.requestedWorkflow'), group: t('mapping.group.route') },
    { source: 'route.finalWorkflow', label: t('mapping.source.finalWorkflow'), group: t('mapping.group.route') },
    { source: 'route.reason', label: t('mapping.source.routeReason'), group: t('mapping.group.route') },
    { source: 'result.count', label: t('mapping.source.resultCount'), group: t('mapping.group.result') },
    { source: 'result.types', label: t('mapping.source.resultTypes'), group: t('mapping.group.result') },
    { source: 'result.status', label: t('mapping.source.resultStatus'), group: t('mapping.group.result') },
    { source: 'assistant.reply', label: t('mapping.source.assistantReply'), group: t('mapping.group.assistant') },
    ...draft.inputs.filter(item => !item.hidden).map(item => ({ source: `input.${item.id}`, label: item.label, group: t('mapping.group.widgetInput') })),
    ...exposedParams.map(item => ({ source: `param.${item.id}`, label: `${item.label}（${item.id}）`, group: t('mapping.group.widgetParam') })),
  ], [draft.inputs, exposedParams, t]);

  const updateResponse = (patch: Partial<PluginResponseProtocol>) => {
    setResponseProtocol(current => current ? { ...current, ...patch } : current);
  };
  const updateResponseBlock = (index: number, patch: Partial<ResponseProtocolBlock>) => {
    setResponseProtocol(current => current ? {
      ...current,
      blocks: current.blocks.map((block, i) => i === index ? { ...block, ...patch } : block),
    } : current);
  };
  const addResponseBlock = (type: ResponseProtocolBlock['type']) => {
    const source = type === 'assistant-reply' ? 'assistant.reply' : type === 'field' ? 'generation.prompt' : undefined;
    const block: ResponseProtocolBlock = {
      id: `block-${Date.now()}`,
      type,
      ...(source ? { source } : { template: t('mapping.response.customReply') }),
      label: type === 'assistant-reply' ? '' : type === 'field' ? t('mapping.source.finalPrompt') : t('mapping.response.customReply'),
      container: 'text',
      format: type === 'assistant-reply' ? 'markdown' : type === 'template' ? 'plain' : 'code',
      ...(type === 'field' ? { language: 'text' } : {}),
      timing: type === 'template' ? 'always' : 'submit',
    };
    setResponseProtocol(current => current ? { ...current, blocks: [...current.blocks, block] } : current);
  };
  const removeResponseBlock = (index: number) => {
    setResponseProtocol(current => current ? { ...current, blocks: current.blocks.filter((_, i) => i !== index) } : current);
  };
  const moveResponseBlock = (index: number, direction: -1 | 1) => {
    setResponseProtocol(current => {
      if (!current) return current;
      const target = index + direction;
      if (target < 0 || target >= current.blocks.length) return current;
      const blocks = [...current.blocks];
      [blocks[index], blocks[target]] = [blocks[target]!, blocks[index]!];
      return { ...current, blocks };
    });
  };
  const saveResponse = async (id: string) => {
    if (!responseProtocol || responseSaving) return;
    setResponseSaving(true);
    setResponseError(null);
    try {
      const result = await savePluginResponse(id, responseProtocol);
      setResponseProtocol(result.protocol);
    } catch (e) {
      setResponseError((e as Error).message);
    } finally {
      setResponseSaving(false);
    }
  };
  const regenerateResponse = async (id: string) => {
    setResponseLoading(true);
    setResponseError(null);
    try {
      const result = await regeneratePluginResponse(id);
      setResponseProtocol(result.protocol);
    } catch (e) {
      setResponseError((e as Error).message);
    } finally {
      setResponseLoading(false);
    }
  };

  const groupLabel = (group: string) => t(({ 输入: 'mapping.groupInput', 参数: 'mapping.groupParam', 输出: 'mapping.groupOutput' }[group] ?? 'mapping.groupInput') as 'mapping.groupInput');

  const validate = (): string | null => {
    if (!draft.name.trim()) return t('mapping.validate.nameRequired');
    if (!draft.outputs.some(output => !output.hidden)) return t('mapping.validate.outputRequired');
    for (const [group, items] of [['输入', draft.inputs], ['参数', draft.params], ['输出', draft.outputs]] as const) {
      const ids = new Set<string>();
      for (const item of items) {
        if (!item.id.trim()) return t('mapping.validate.idRequired', { group: groupLabel(group) });
        if (ids.has(item.id)) return t('mapping.validate.idDuplicate', { group: groupLabel(group), id: item.id });
        ids.add(item.id);
        if (!item.nodeId) return t('mapping.validate.nodeRequired', { group: groupLabel(group), id: item.id });
        if ('field' in item && !item.field) return t('mapping.validate.fieldRequired', { group: groupLabel(group), id: item.id });
      }
    }
    return null;
  };

  const save = async () => {
    const validation = validate();
    if (validation) {
      setLocalError(validation);
      return;
    }
    setLocalError(null);
    setResponseError(null);
    if (responseProtocol) {
      setResponseSaving(true);
      try {
        await savePluginResponse(draft.id, responseProtocol);
      } catch (e) {
        setResponseError((e as Error).message);
        setResponseSaving(false);
        return;
      }
      setResponseSaving(false);
    }
    onSave(draft);
  };

  return (
    <div className={`workflow-mapping-overlay${fullscreen ? ' fullscreen' : ''}`} onClick={onClose}>
      <div className={`workflow-mapping-modal${fullscreen ? ' fullscreen' : ''}`} role="dialog" aria-modal="true" aria-label={t('mapping.ariaLabel')} onClick={event => event.stopPropagation()}>
        <header className="workflow-mapping-head">
          <div>
            <span className="settings-section-kicker">WORKFLOW PLUGIN</span>
            <h2>{draft.name || draft.id}</h2>
            <input className="settings-input" value={draft.description ?? ''} onChange={event => update({ description: event.target.value })} placeholder={t('mapping.descPlaceholder')} />
          </div>
          <div className="workflow-mapping-head-actions">
            {view === 'node' && <button className="settings-btn" onClick={() => setFullscreen(value => !value)}>{fullscreen ? t('common.exitFullscreen') : t('common.fullscreen')}</button>}
            <button className="settings-close" onClick={onClose} aria-label={t('common.close')}>×</button>
          </div>
        </header>
        <div className="workflow-mapping-tabs" role="tablist" aria-label={t('mapping.tabsAria')}>
          <button className={view === 'node' ? 'active' : ''} role="tab" aria-selected={view === 'node'} onClick={() => setView('node')}>{t('mapping.tabNode')}</button>
          <button className={view === 'form' ? 'active' : ''} role="tab" aria-selected={view === 'form'} onClick={() => setView('form')}>{t('mapping.tabForm')}</button>
          <button className={view === 'skill' ? 'active' : ''} role="tab" aria-selected={view === 'skill'} onClick={() => selectView('skill')}>Skill</button>
          <button className={view === 'response' ? 'active' : ''} role="tab" aria-selected={view === 'response'} onClick={() => selectView('response')}>{t('mapping.tabResponse')}</button>
        </div>
        <div className="workflow-mapping-body">
          {view === 'node' ? (
            <WorkflowNodeGraph graph={displayGraph} loading={graphLoading} error={graphError} onRetry={() => void loadGraph(draft.id)} onToggleParam={toggleField} onChangeParamDefault={updateParamDefault} onRemoveParam={removePinnedParam} onFullscreen={() => setFullscreen(value => !value)} fullscreen={fullscreen} />
          ) : view === 'skill' ? (
            <section className="workflow-mapping-section workflow-skill-view">
              <div className="workflow-mapping-section-head">
                <div>
                  <h3>Skill</h3>
                  <p>{t('mapping.skill.desc')}</p>
                </div>
                <div className="workflow-skill-actions">
                  {skillError && <button className="settings-btn" onClick={() => void loadSkill(draft.id)}>{t('common.retry')}</button>}
                  <button className="settings-btn" disabled={skillLoading || skillGenerating} onClick={() => void generateSkill(draft.id)}>{skillGenerating ? t('mapping.skill.generating') : t('mapping.skill.generate')}</button>
                  <button className="settings-btn primary" disabled={skillLoading || skillSaving || skillContent === null} onClick={() => void saveSkill(draft.id)}>{skillSaving ? t('common.saving') : t('common.save')}</button>
                </div>
              </div>
              {skillLoading && <p className="workflow-skill-hint">{t('common.loading')}</p>}
              {skillError && <p className="workflow-mapping-error">{skillError}</p>}
              {!skillLoading && skillContent !== null && (
                <>
                  <textarea
                    className="workflow-skill-editor"
                    value={skillContent}
                    onChange={event => setSkillContent(event.target.value)}
                    spellCheck={false}
                    aria-label={t('mapping.skill.contentAria')}
                  />
                  <div className="workflow-skill-chat" aria-label={t('mapping.skill.chatTitle')}>
                    <div className="workflow-skill-chat-head">
                      <div>
                        <strong>{t('mapping.skill.chatTitle')}</strong>
                        <span>{t('mapping.skill.chatDesc')}</span>
                      </div>
                      {skillChatMessages.length > 0 && <button className="settings-btn" onClick={() => setSkillChatMessages([])}>{t('mapping.skill.clearChat')}</button>}
                    </div>
                    {skillChatMessages.length > 0 && (
                      <div className="workflow-skill-chat-messages">
                        {skillChatMessages.map((item, index) => (
                          <div className={`workflow-skill-chat-message ${item.role}`} key={`${item.role}-${index}`}>
                            <span className="workflow-skill-chat-role">{item.role === 'user' ? t('mapping.skill.you') : t('mapping.skill.assistant')}</span>
                            <p>{item.content}</p>
                          </div>
                        ))}
                      </div>
                    )}
                    <form className="workflow-skill-chat-form" onSubmit={event => { event.preventDefault(); void sendSkillChat(draft.id); }}>
                      <textarea
                        value={skillChatInput}
                        onChange={event => setSkillChatInput(event.target.value)}
                        placeholder={t('mapping.skill.chatPlaceholder')}
                        aria-label={t('mapping.skill.chatInputAria')}
                        rows={2}
                        disabled={skillChatSending}
                      />
                      <button className="settings-btn primary" type="submit" disabled={skillChatSending || !skillChatInput.trim()}>{skillChatSending ? t('mapping.skill.adjusting') : t('common.send')}</button>
                    </form>
                  </div>
                </>
              )}
            </section>
          ) : view === 'response' ? (
            <section className="workflow-mapping-section workflow-response-view">
              <div className="workflow-mapping-section-head">
                <div>
                  <h3>{t('mapping.response.title')}</h3>
                  <p>{t('mapping.response.desc')}</p>
                </div>
                <div className="workflow-skill-actions">
                  <button className="settings-btn" disabled={responseLoading} onClick={() => void regenerateResponse(draft.id)}>{t('mapping.response.restore')}</button>
                  <button className="settings-btn primary" disabled={responseLoading || responseSaving || responseProtocol === null} onClick={() => void saveResponse(draft.id)}>{responseSaving ? t('common.saving') : t('mapping.response.save')}</button>
                </div>
              </div>
              {responseLoading && <p className="workflow-skill-hint">{t('common.loading')}</p>}
              {responseError && <p className="workflow-mapping-error">{responseError}</p>}
              {responseProtocol && !responseLoading && (
                <div className="workflow-response-editor">
                  <div className="workflow-response-thinking">
                    <div className="workflow-response-row-head"><strong>{t('mapping.response.thinking')}</strong><span>{t('mapping.response.thinkingDesc')}</span></div>
                    <label className="workflow-response-control"><input type="checkbox" checked={responseProtocol.thinking.enabled} onChange={event => updateResponse({ thinking: { ...responseProtocol.thinking, enabled: event.target.checked } })} /> {t('mapping.response.show')}</label>
                    <label className="workflow-response-control">{t('mapping.response.container')}
                      <select value={responseProtocol.thinking.container} onChange={event => updateResponse({ thinking: { ...responseProtocol.thinking, container: event.target.value as 'text' | 'collapsible' } })}>
                        <option value="text">{t('mapping.response.containerText')}</option><option value="collapsible">{t('mapping.response.containerCollapsible')}</option>
                      </select>
                    </label>
                    <label className="workflow-response-control">{t('mapping.response.format')}
                      <select value={responseProtocol.thinking.format} onChange={event => updateResponse({ thinking: { ...responseProtocol.thinking, format: event.target.value as 'plain' | 'markdown' | 'code' } })}>
                        <option value="plain">{t('mapping.response.formatPlain')}</option><option value="markdown">Markdown</option><option value="code">{t('mapping.response.formatCode')}</option>
                      </select>
                    </label>
                    {responseProtocol.thinking.container === 'collapsible' && <label className="workflow-response-control"><input type="checkbox" checked={responseProtocol.thinking.defaultOpen ?? false} onChange={event => updateResponse({ thinking: { ...responseProtocol.thinking, defaultOpen: event.target.checked } })} /> {t('mapping.response.defaultOpen')}</label>}
                  </div>
                  <div className="workflow-response-toolbar">
                    <strong>{t('mapping.response.blocks')}</strong>
                    <div>
                      <button className="settings-btn" onClick={() => addResponseBlock('field')}>{t('mapping.response.addField')}</button>
                      <button className="settings-btn" onClick={() => addResponseBlock('template')}>{t('mapping.response.addTemplate')}</button>
                      <button className="settings-btn" onClick={() => addResponseBlock('assistant-reply')}>{t('mapping.response.addAssistant')}</button>
                    </div>
                  </div>
                  {responseProtocol.blocks.map((block, index) => {
                    const groups = [...new Set(responseSources.map(option => option.group))];
                    return (
                      <div className="workflow-response-block" key={block.id}>
                        <div className="workflow-response-block-head">
                          <input className="workflow-response-block-id" value={block.label ?? ''} onChange={event => updateResponseBlock(index, { label: event.target.value })} placeholder={t('mapping.response.labelPlaceholder')} />
                          <span>#{index + 1}</span>
                          <button className="settings-btn" disabled={index === 0} onClick={() => moveResponseBlock(index, -1)}>{t('mapping.response.moveUp')}</button>
                          <button className="settings-btn" disabled={index === responseProtocol.blocks.length - 1} onClick={() => moveResponseBlock(index, 1)}>{t('mapping.response.moveDown')}</button>
                          <button className="settings-btn" onClick={() => removeResponseBlock(index)}>{t('common.delete')}</button>
                        </div>
                        {block.type === 'template' ? (
                          <textarea className="workflow-response-template" value={block.template ?? ''} onChange={event => updateResponseBlock(index, { template: event.target.value })} placeholder={t('mapping.response.templatePlaceholder')} rows={3} />
                        ) : (
                          <label className="workflow-response-field">{t('mapping.response.source')}
                            <select value={block.source ?? ''} onChange={event => updateResponseBlock(index, { source: event.target.value })}>
                              {groups.map(group => <optgroup key={group} label={group}>{responseSources.filter(option => option.group === group).map(option => <option key={option.source} value={option.source}>{option.label} · {option.source}</option>)}</optgroup>)}
                            </select>
                          </label>
                        )}
                        {block.type === 'template' && <label className="workflow-response-field">{t('mapping.response.insertPlaceholder')}
                          <select value="" onChange={event => { const source = event.target.value; if (!source) return; updateResponseBlock(index, { template: `${block.template ?? ''}{{${source}}}` }); }}><option value="">{t('mapping.response.selectField')}</option>{[...new Set(responseSources.map(option => option.group))].map(group => <optgroup key={group} label={group}>{responseSources.filter(option => option.group === group).map(option => <option key={option.source} value={option.source}>{option.label}</option>)}</optgroup>)}</select>
                        </label>}
                        <div className="workflow-response-controls">
                          <label>{t('mapping.response.container')}<select value={block.container} onChange={event => updateResponseBlock(index, { container: event.target.value as 'text' | 'collapsible' })}><option value="text">{t('mapping.response.containerText')}</option><option value="collapsible">{t('mapping.response.containerCollapsible')}</option></select></label>
                          <label>{t('mapping.response.format')}<select value={block.format} onChange={event => updateResponseBlock(index, { format: event.target.value as 'plain' | 'markdown' | 'code' })}><option value="plain">{t('mapping.response.formatPlain')}</option><option value="markdown">Markdown</option><option value="code">{t('mapping.response.formatCode')}</option></select></label>
                          <label>{t('mapping.response.timing')}<select value={block.timing} onChange={event => updateResponseBlock(index, { timing: event.target.value as 'submit' | 'complete' | 'always' })}><option value="submit">{t('mapping.response.timingSubmit')}</option><option value="complete">{t('mapping.response.timingComplete')}</option><option value="always">{t('mapping.response.timingAlways')}</option></select></label>
                          {block.container === 'collapsible' && <label><input type="checkbox" checked={block.defaultOpen ?? false} onChange={event => updateResponseBlock(index, { defaultOpen: event.target.checked })} /> {t('mapping.response.defaultOpen')}</label>}
                          {block.format === 'code' && <label>{t('mapping.response.language')}<input value={block.language ?? 'text'} onChange={event => updateResponseBlock(index, { language: event.target.value })} /></label>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          ) : (
            <section className="workflow-mapping-section workflow-parameter-form">
              <div className="workflow-mapping-section-head">
                <div>
                  <h3>{t('mapping.form.title')}</h3>
                  <p>{t('mapping.form.desc')}</p>
                </div>
              </div>
              {exposedParams.length > 0 ? (
                exposedParams.map((item, index) => (
                  <ParamRow key={item.id || index} item={item} onChange={patch => updateParam(draft.params.indexOf(item), patch)} />
                ))
              ) : (
                <div className="workflow-form-empty">
                  <strong>{t('mapping.form.emptyTitle')}</strong>
                  <span>{t('mapping.form.emptyDesc')}</span>
                  <button className="settings-btn" onClick={() => setView('node')}>{t('mapping.form.goNode')}</button>
                </div>
              )}
            </section>
          )}
        </div>
        {(localError || error || (view === 'node' && graph?.manifestError)) && <div className="workflow-mapping-error">{localError || error || graph?.manifestError}</div>}
        {redetectNotice && <div className="workflow-mapping-notice">{t('mapping.redetectNotice')}</div>}
        <footer className="workflow-mapping-foot">
          <button className="settings-btn" onClick={() => { setRedetectNotice(true); onRedetect(); }}>{t('mapping.redetect')}</button>
          <span />
          <button className="settings-btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="settings-btn primary" disabled={saving || responseSaving} onClick={() => void save()}>{saving || responseSaving ? t('common.saving') : t('mapping.saveMapping')}</button>
        </footer>
      </div>
    </div>
  );
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <label className={`workflow-mapping-field${wide ? ' wide' : ''}`}>
      <span className="workflow-mapping-field-label">{label}</span>
      {children}
    </label>
  );
}

function ParamRow({ item, onChange }: { item: WorkflowParam; onChange: (patch: Partial<WorkflowParam>) => void }) {
  const { t } = useTranslation();
  const isNumeric = item.type === 'INT' || item.type === 'FLOAT';
  const isCombo = item.type === 'combo';
  const comboOptions = isCombo && !item.multiple ? (item.options ?? []) : [];
  return (
    <div className="workflow-mapping-row">
      <div className="workflow-mapping-row-head"><strong>{t('mapping.param.title')}</strong><span className="workflow-mapping-locked">{t('mapping.param.nodeLocked')}</span></div>
      <div className="workflow-mapping-grid">
        <Field label={t('mapping.param.id')}><input value={item.id} readOnly aria-label={t('mapping.param.id')} /></Field>
        <Field label={t('mapping.param.name')}><input value={item.label} onChange={e => onChange({ label: e.target.value })} placeholder={t('mapping.param.name')} /></Field>
        <Field label={t('mapping.param.type')}><input value={item.type} readOnly aria-label={t('mapping.param.type')} /></Field>
        <Field label={t('mapping.param.nodeId')}><input value={item.nodeId} readOnly aria-label={t('mapping.param.nodeId')} /></Field>
        <Field label={t('mapping.param.field')}><input value={item.field} readOnly aria-label={t('mapping.param.field')} /></Field>
        <Field label="description" wide><input className="wide" value={item.description ?? ''} onChange={e => onChange({ description: e.target.value })} placeholder={t('mapping.param.descPlaceholder')} /></Field>
        {comboOptions.length > 0 ? (
          <Field label={t('mapping.param.default')} wide>
            <select value={String(item.default ?? '')} onChange={e => onChange({ default: e.target.value })} aria-label={t('mapping.param.default')}>
              <option value="" disabled>{t('common.select')}</option>
              {comboOptions.map(option => <option key={option} value={option}>{option}</option>)}
            </select>
          </Field>
        ) : (
          <Field label={t('mapping.param.default')}>
            <input value={String(item.default ?? '')} onChange={isCombo ? undefined : e => onChange({ default: e.target.value })} readOnly={isCombo} placeholder={isCombo ? t('mapping.param.configureInNode') : t('mapping.param.default')} />
          </Field>
        )}
        {isNumeric && <Field label={t('mapping.param.min')}><input type="number" value={item.min ?? ''} onChange={e => onChange({ min: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder={t('mapping.param.min')} /></Field>}
        {isNumeric && <Field label={t('mapping.param.max')}><input type="number" value={item.max ?? ''} onChange={e => onChange({ max: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder={t('mapping.param.max')} /></Field>}
        {isNumeric && <Field label={t('mapping.param.step')}><input type="number" value={item.step ?? ''} onChange={e => onChange({ step: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder={t('mapping.param.step')} /></Field>}
        {isCombo && comboOptions.length === 0 && <Field label={t('mapping.param.comboOptions')} wide><input className="wide" value={item.options?.join(', ') ?? ''} readOnly aria-label={t('mapping.param.comboOptions')} placeholder={t('mapping.param.comboOptionsPlaceholder')} /></Field>}
      </div>
      <label className="workflow-mapping-hidden"><input type="checkbox" checked={item.hidden ?? false} onChange={e => onChange({ hidden: e.target.checked })} /> {t('mapping.param.hidden')}</label>
    </div>
  );
}

