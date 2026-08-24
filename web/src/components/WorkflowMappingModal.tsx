import { useEffect, useMemo, useState } from 'react';
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
      await savePluginSkill(id, skillContent);
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
      if (!window.confirm(`删除参数「${existing.label}」？\n说明：${existing.description}\n删除后将恢复模板默认值。`)) return;
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
        const detail = existing.description ? `\n说明：${existing.description}` : '';
        if (!window.confirm(`取消参数「${existing.label}」？${detail}\n取消后将丢失已填写配置。`)) return;
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
    { source: 'generation.prompt', label: '最终正面提示词', group: '生成内容' },
    ...(draft.params.some(item => !item.hidden && item.llm !== false && /负面|反面|negative/i.test(`${item.label} ${item.description ?? ''}`)) ? [{ source: 'generation.negativePrompt', label: '最终反面提示词', group: '生成内容' }] : []),
    { source: 'generation.workflowName', label: '工作流名称', group: '生成内容' },
    { source: 'generation.intent', label: '生成意图', group: '生成内容' },
    { source: 'route.requestedWorkflow', label: '请求工作流', group: '路由' },
    { source: 'route.finalWorkflow', label: '最终工作流', group: '路由' },
    { source: 'route.reason', label: '路由原因', group: '路由' },
    { source: 'result.count', label: '结果数量', group: '结果' },
    { source: 'result.types', label: '结果类型', group: '结果' },
    { source: 'result.status', label: '任务状态', group: '结果' },
    { source: 'assistant.reply', label: 'Agent 正文', group: '助手' },
    ...draft.inputs.filter(item => !item.hidden).map(item => ({ source: `input.${item.id}`, label: item.label, group: 'Widget 输入' })),
    ...exposedParams.map(item => ({ source: `param.${item.id}`, label: `${item.label}（${item.id}）`, group: 'Widget 参数' })),
  ], [draft.inputs, exposedParams]);

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
      ...(source ? { source } : { template: '标题：{{generation.workflowName}}' }),
      label: type === 'assistant-reply' ? '' : type === 'field' ? '生成提示词' : '自定义回复',
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

  const validate = (): string | null => {
    if (!draft.name.trim()) return '工作流名称不能为空';
    if (!draft.outputs.some(output => !output.hidden)) return '至少保留一个可用输出映射';
    for (const [group, items] of [['输入', draft.inputs], ['参数', draft.params], ['输出', draft.outputs]] as const) {
      const ids = new Set<string>();
      for (const item of items) {
        if (!item.id.trim()) return `${group}映射 ID 不能为空`;
        if (ids.has(item.id)) return `${group}映射 ID 重复：${item.id}`;
        ids.add(item.id);
        if (!item.nodeId) return `${group}映射 ${item.id} 尚未选择节点`;
        if ('field' in item && !item.field) return `${group}映射 ${item.id} 尚未选择字段`;
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
      <div className={`workflow-mapping-modal${fullscreen ? ' fullscreen' : ''}`} role="dialog" aria-modal="true" aria-label="编辑工作流映射" onClick={event => event.stopPropagation()}>
        <header className="workflow-mapping-head">
          <div>
            <span className="settings-section-kicker">WORKFLOW PLUGIN</span>
            <h2>{draft.name || draft.id}</h2>
            <input className="settings-input" value={draft.description ?? ''} onChange={event => update({ description: event.target.value })} placeholder="给 LLM 的工作流用途描述" />
          </div>
          <div className="workflow-mapping-head-actions">
            {view === 'node' && <button className="settings-btn" onClick={() => setFullscreen(value => !value)}>{fullscreen ? '退出全屏' : '全屏'}</button>}
            <button className="settings-close" onClick={onClose} aria-label="关闭">×</button>
          </div>
        </header>
        <div className="workflow-mapping-tabs" role="tablist" aria-label="映射编辑视图">
          <button className={view === 'node' ? 'active' : ''} role="tab" aria-selected={view === 'node'} onClick={() => setView('node')}>节点视图</button>
          <button className={view === 'form' ? 'active' : ''} role="tab" aria-selected={view === 'form'} onClick={() => setView('form')}>表单视图</button>
          <button className={view === 'skill' ? 'active' : ''} role="tab" aria-selected={view === 'skill'} onClick={() => selectView('skill')}>Skill</button>
          <button className={view === 'response' ? 'active' : ''} role="tab" aria-selected={view === 'response'} onClick={() => selectView('response')}>回复协议</button>
        </div>
        <div className="workflow-mapping-body">
          {view === 'node' ? (
            <WorkflowNodeGraph graph={displayGraph} loading={graphLoading} error={graphError} onRetry={() => void loadGraph(draft.id)} onToggleParam={toggleField} onChangeParamDefault={updateParamDefault} onRemoveParam={removePinnedParam} onFullscreen={() => setFullscreen(value => !value)} fullscreen={fullscreen} />
          ) : view === 'skill' ? (
            <section className="workflow-mapping-section workflow-skill-view">
              <div className="workflow-mapping-section-head">
                <div>
                  <h3>Skill</h3>
                  <p>LLM 通过 MCP 工具 workflow.skill 获取的插件使用说明；可直接编辑保存，或用 plugin-skill-creator 重新生成。</p>
                </div>
                <div className="workflow-skill-actions">
                  {skillError && <button className="settings-btn" onClick={() => void loadSkill(draft.id)}>重试</button>}
                  <button className="settings-btn" disabled={skillLoading || skillGenerating} onClick={() => void generateSkill(draft.id)}>{skillGenerating ? '生成中…' : '生成 Skill'}</button>
                  <button className="settings-btn primary" disabled={skillLoading || skillSaving || skillContent === null} onClick={() => void saveSkill(draft.id)}>{skillSaving ? '保存中…' : '保存'}</button>
                </div>
              </div>
              {skillLoading && <p className="workflow-skill-hint">加载中…</p>}
              {skillError && <p className="workflow-mapping-error">{skillError}</p>}
              {!skillLoading && skillContent !== null && (
                <>
                  <textarea
                    className="workflow-skill-editor"
                    value={skillContent}
                    onChange={event => setSkillContent(event.target.value)}
                    spellCheck={false}
                    aria-label="插件 Skill 内容"
                  />
                  <div className="workflow-skill-chat" aria-label="Skill 调整对话">
                    <div className="workflow-skill-chat-head">
                      <div>
                        <strong>对话调整 Skill</strong>
                        <span>上下文包含当前 widget 参数和 Skill；调整结果只更新上方预览。</span>
                      </div>
                      {skillChatMessages.length > 0 && <button className="settings-btn" onClick={() => setSkillChatMessages([])}>清空对话</button>}
                    </div>
                    {skillChatMessages.length > 0 && (
                      <div className="workflow-skill-chat-messages">
                        {skillChatMessages.map((item, index) => (
                          <div className={`workflow-skill-chat-message ${item.role}`} key={`${item.role}-${index}`}>
                            <span className="workflow-skill-chat-role">{item.role === 'user' ? '你' : 'Skill 助手'}</span>
                            <p>{item.content}</p>
                          </div>
                        ))}
                      </div>
                    )}
                    <form className="workflow-skill-chat-form" onSubmit={event => { event.preventDefault(); void sendSkillChat(draft.id); }}>
                      <textarea
                        value={skillChatInput}
                        onChange={event => setSkillChatInput(event.target.value)}
                        placeholder="例如：隐藏 prompt 预览，并把完成后的回复压缩成一句话"
                        aria-label="调整 Skill 的消息"
                        rows={2}
                        disabled={skillChatSending}
                      />
                      <button className="settings-btn primary" type="submit" disabled={skillChatSending || !skillChatInput.trim()}>{skillChatSending ? '调整中…' : '发送'}</button>
                    </form>
                  </div>
                </>
              )}
            </section>
          ) : view === 'response' ? (
            <section className="workflow-mapping-section workflow-response-view">
              <div className="workflow-mapping-section-head">
                <div>
                  <h3>回复协议</h3>
                  <p>选择 widget 值或生成上下文作为占位符，并分别设置容器、格式和显示时机。协议只在点击保存后生效。</p>
                </div>
                <div className="workflow-skill-actions">
                  <button className="settings-btn" disabled={responseLoading} onClick={() => void regenerateResponse(draft.id)}>恢复默认</button>
                  <button className="settings-btn primary" disabled={responseLoading || responseSaving || responseProtocol === null} onClick={() => void saveResponse(draft.id)}>{responseSaving ? '保存中…' : '保存协议'}</button>
                </div>
              </div>
              {responseLoading && <p className="workflow-skill-hint">加载中…</p>}
              {responseError && <p className="workflow-mapping-error">{responseError}</p>}
              {responseProtocol && !responseLoading && (
                <div className="workflow-response-editor">
                  <div className="workflow-response-thinking">
                    <div className="workflow-response-row-head"><strong>思维链</strong><span>Agent 的 thinking 事件</span></div>
                    <label className="workflow-response-control"><input type="checkbox" checked={responseProtocol.thinking.enabled} onChange={event => updateResponse({ thinking: { ...responseProtocol.thinking, enabled: event.target.checked } })} /> 显示</label>
                    <label className="workflow-response-control">容器
                      <select value={responseProtocol.thinking.container} onChange={event => updateResponse({ thinking: { ...responseProtocol.thinking, container: event.target.value as 'text' | 'collapsible' } })}>
                        <option value="text">普通文本</option><option value="collapsible">可折叠</option>
                      </select>
                    </label>
                    <label className="workflow-response-control">格式
                      <select value={responseProtocol.thinking.format} onChange={event => updateResponse({ thinking: { ...responseProtocol.thinking, format: event.target.value as 'plain' | 'markdown' | 'code' } })}>
                        <option value="plain">纯文本</option><option value="markdown">Markdown</option><option value="code">代码块</option>
                      </select>
                    </label>
                    {responseProtocol.thinking.container === 'collapsible' && <label className="workflow-response-control"><input type="checkbox" checked={responseProtocol.thinking.defaultOpen ?? false} onChange={event => updateResponse({ thinking: { ...responseProtocol.thinking, defaultOpen: event.target.checked } })} /> 默认展开</label>}
                  </div>
                  <div className="workflow-response-toolbar">
                    <strong>回复内容块</strong>
                    <div>
                      <button className="settings-btn" onClick={() => addResponseBlock('field')}>+ 字段</button>
                      <button className="settings-btn" onClick={() => addResponseBlock('template')}>+ 模板</button>
                      <button className="settings-btn" onClick={() => addResponseBlock('assistant-reply')}>+ Agent 正文</button>
                    </div>
                  </div>
                  {responseProtocol.blocks.map((block, index) => {
                    const groups = [...new Set(responseSources.map(option => option.group))];
                    return (
                      <div className="workflow-response-block" key={block.id}>
                        <div className="workflow-response-block-head">
                          <input className="workflow-response-block-id" value={block.label ?? ''} onChange={event => updateResponseBlock(index, { label: event.target.value })} placeholder="显示标题" />
                          <span>#{index + 1}</span>
                          <button className="settings-btn" disabled={index === 0} onClick={() => moveResponseBlock(index, -1)}>上移</button>
                          <button className="settings-btn" disabled={index === responseProtocol.blocks.length - 1} onClick={() => moveResponseBlock(index, 1)}>下移</button>
                          <button className="settings-btn" onClick={() => removeResponseBlock(index)}>删除</button>
                        </div>
                        {block.type === 'template' ? (
                          <textarea className="workflow-response-template" value={block.template ?? ''} onChange={event => updateResponseBlock(index, { template: event.target.value })} placeholder="输入文本，可使用 {{param.id}} 占位符" rows={3} />
                        ) : (
                          <label className="workflow-response-field">数据来源
                            <select value={block.source ?? ''} onChange={event => updateResponseBlock(index, { source: event.target.value })}>
                              {groups.map(group => <optgroup key={group} label={group}>{responseSources.filter(option => option.group === group).map(option => <option key={option.source} value={option.source}>{option.label} · {option.source}</option>)}</optgroup>)}
                            </select>
                          </label>
                        )}
                        {block.type === 'template' && <label className="workflow-response-field">插入占位符
                          <select value="" onChange={event => { const source = event.target.value; if (!source) return; updateResponseBlock(index, { template: `${block.template ?? ''}{{${source}}}` }); }}><option value="">选择字段…</option>{[...new Set(responseSources.map(option => option.group))].map(group => <optgroup key={group} label={group}>{responseSources.filter(option => option.group === group).map(option => <option key={option.source} value={option.source}>{option.label}</option>)}</optgroup>)}</select>
                        </label>}
                        <div className="workflow-response-controls">
                          <label>容器<select value={block.container} onChange={event => updateResponseBlock(index, { container: event.target.value as 'text' | 'collapsible' })}><option value="text">普通文本</option><option value="collapsible">可折叠</option></select></label>
                          <label>格式<select value={block.format} onChange={event => updateResponseBlock(index, { format: event.target.value as 'plain' | 'markdown' | 'code' })}><option value="plain">纯文本</option><option value="markdown">Markdown</option><option value="code">代码块</option></select></label>
                          <label>时机<select value={block.timing} onChange={event => updateResponseBlock(index, { timing: event.target.value as 'submit' | 'complete' | 'always' })}><option value="submit">提交时</option><option value="complete">完成时</option><option value="always">始终</option></select></label>
                          {block.container === 'collapsible' && <label><input type="checkbox" checked={block.defaultOpen ?? false} onChange={event => updateResponseBlock(index, { defaultOpen: event.target.checked })} /> 默认展开</label>}
                          {block.format === 'code' && <label>语言<input value={block.language ?? 'text'} onChange={event => updateResponseBlock(index, { language: event.target.value })} /></label>}
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
                  <h3>Widget 参数配置</h3>
                  <p>这里只显示加入 LLM 上下文的 widget；未勾选但固定了 combo 值的参数只在节点视图中维护。</p>
                </div>
              </div>
              {exposedParams.length > 0 ? (
                exposedParams.map((item, index) => (
                  <ParamRow key={item.id || index} item={item} onChange={patch => updateParam(draft.params.indexOf(item), patch)} />
                ))
              ) : (
                <div className="workflow-form-empty">
                  <strong>暂无加入 LLM 上下文的参数</strong>
                  <span>请先切换到节点视图，在节点字段上勾选需要暴露给 LLM 的参数；combo 可直接在节点上配置固定值。</span>
                  <button className="settings-btn" onClick={() => setView('node')}>前往节点视图</button>
                </div>
              )}
            </section>
          )}
        </div>
        {(localError || error || (view === 'node' && graph?.manifestError)) && <div className="workflow-mapping-error">{localError || error || graph?.manifestError}</div>}
        {redetectNotice && <div className="workflow-mapping-notice">重新识别结果已加载，点击保存后才会写入清单。</div>}
        <footer className="workflow-mapping-foot">
          <button className="settings-btn" onClick={() => { setRedetectNotice(true); onRedetect(); }}>重新识别</button>
          <span />
          <button className="settings-btn" onClick={onClose}>取消</button>
          <button className="settings-btn primary" disabled={saving || responseSaving} onClick={() => void save()}>{saving || responseSaving ? '保存中…' : '保存映射'}</button>
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
  const isNumeric = item.type === 'INT' || item.type === 'FLOAT';
  const isCombo = item.type === 'combo';
  const comboOptions = isCombo && !item.multiple ? (item.options ?? []) : [];
  return (
    <div className="workflow-mapping-row">
      <div className="workflow-mapping-row-head"><strong>参数</strong><span className="workflow-mapping-locked">节点视图选择</span></div>
      <div className="workflow-mapping-grid">
        <Field label="映射 ID"><input value={item.id} readOnly aria-label="参数映射 ID" /></Field>
        <Field label="名称"><input value={item.label} onChange={e => onChange({ label: e.target.value })} placeholder="名称" /></Field>
        <Field label="参数类型"><input value={item.type} readOnly aria-label="参数类型" /></Field>
        <Field label="节点 ID"><input value={item.nodeId} readOnly aria-label="参数节点" /></Field>
        <Field label="字段"><input value={item.field} readOnly aria-label="参数字段" /></Field>
        <Field label="description" wide><input className="wide" value={item.description ?? ''} onChange={e => onChange({ description: e.target.value })} placeholder="description：给用户/LLM 的用途" /></Field>
        {comboOptions.length > 0 ? (
          <Field label="默认值" wide>
            <select value={String(item.default ?? '')} onChange={e => onChange({ default: e.target.value })} aria-label="combo 默认值">
              <option value="" disabled>请选择…</option>
              {comboOptions.map(option => <option key={option} value={option}>{option}</option>)}
            </select>
          </Field>
        ) : (
          <Field label="默认值">
            <input value={String(item.default ?? '')} onChange={isCombo ? undefined : e => onChange({ default: e.target.value })} readOnly={isCombo} placeholder={isCombo ? '节点视图中配置' : '默认值'} />
          </Field>
        )}
        {isNumeric && <Field label="最小值"><input type="number" value={item.min ?? ''} onChange={e => onChange({ min: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder="最小值" /></Field>}
        {isNumeric && <Field label="最大值"><input type="number" value={item.max ?? ''} onChange={e => onChange({ max: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder="最大值" /></Field>}
        {isNumeric && <Field label="步长"><input type="number" value={item.step ?? ''} onChange={e => onChange({ step: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder="步长" /></Field>}
        {isCombo && comboOptions.length === 0 && <Field label="combo 选项" wide><input className="wide" value={item.options?.join(', ') ?? ''} readOnly aria-label="combo 选项" placeholder="节点视图中配置 combo 选项" /></Field>}
      </div>
      <label className="workflow-mapping-hidden"><input type="checkbox" checked={item.hidden ?? false} onChange={e => onChange({ hidden: e.target.checked })} /> 隐藏</label>
    </div>
  );
}

