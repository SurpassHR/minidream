import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  analyzePluginConfig,
  chatPluginSkill,
  fetchPluginSkill,
  fetchWorkflowGraph,
  generatePluginSkillLlm,
  savePluginSkill,
  fetchPluginResponse,
  savePluginResponse,
  regeneratePluginResponse,
  type PluginAnalysis,
  type PluginResponseProtocol,
  type WorkflowGraph,
  type WorkflowGraphField,
  type WorkflowInterfaceCandidates,
  type WorkflowInterfaceInputCandidate,
  type WorkflowInterfaceOutputCandidate,
  type WorkflowManifest,
  type WorkflowNodePosition,
  type WorkflowNodePositions,
  type PluginSkillChatMessage,
  type WorkflowParam,
} from '../api';
import WorkflowNodeGraph from './WorkflowNodeGraph';
import { isParamSelected, paramForField, removeParam, addParamFromField, pinComboValue, setNodeBypass, setParamExposed, validateWorkflowDraft, workflowInterfaceParams } from './workflowMappingDraft';
import './WorkflowMappingModal.css';

interface Props {
  manifest: WorkflowManifest;
  saving?: boolean;
  error?: string | null;
  /** 返回是否保存成功（成功时不自动关闭，由弹窗闪现“已保存”反馈） */
  onSave: (manifest: WorkflowManifest, nodePositions?: WorkflowNodePositions, positionsOnly?: boolean) => Promise<boolean>;
  onRedetect: () => void;
  onClose: () => void;
}

type ResponseProtocolBlock = PluginResponseProtocol['blocks'][number];

type ResponseSourceOption = { source: string; label: string; group: string };

/** 结构性深比较（manifest 为纯 JSON 数据） */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const recordA = a as Record<string, unknown>;
  const recordB = b as Record<string, unknown>;
  if (Array.isArray(recordA) || Array.isArray(recordB)) {
    if (!Array.isArray(recordA) || !Array.isArray(recordB) || recordA.length !== recordB.length) return false;
    return recordA.every((value, index) => deepEqual(value, recordB[index]));
  }
  const keysA = Object.keys(recordA);
  const keysB = Object.keys(recordB);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(key => deepEqual(recordA[key], recordB[key]));
}

function copyManifest(manifest: WorkflowManifest): WorkflowManifest {
  const copy = JSON.parse(JSON.stringify(manifest)) as WorkflowManifest;
  // 未保存的自动识别结果只作为节点图候选，参数必须由用户在节点视图中显式勾选。
  if (!manifest.hasManifest) copy.params = [];
  return copy;
}

export default function WorkflowMappingModal({ manifest, saving, error, onSave, onRedetect, onClose }: Props) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(() => copyManifest(manifest));
  // 保存基准快照 + 保存反馈 toast：继承设置弹窗的「脏状态 toast + 确认保存按钮 + 已保存/失败闪现」模式
  const [savedSnapshot, setSavedSnapshot] = useState<WorkflowManifest | null>(() => structuredClone(copyManifest(manifest)));
  const [toast, setToast] = useState<null | 'saving' | 'saved' | 'failed'>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [view, setView] = useState<'node' | 'form' | 'skill' | 'response'>('node');
  const [editingParamId, setEditingParamId] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [graph, setGraph] = useState<WorkflowGraph | null>(null);
  const [graphLoading, setGraphLoading] = useState(true);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [nodePositions, setNodePositions] = useState<WorkflowNodePositions>({});
  const [savedNodePositions, setSavedNodePositions] = useState<WorkflowNodePositions>({});
  const [localError, setLocalError] = useState<string | null>(null);
  const [redetectNotice, setRedetectNotice] = useState(false);
  const [skillContent, setSkillContent] = useState<string | null>(null);
  const [skillSnapshot, setSkillSnapshot] = useState<string | null>(null);
  const [skillLoading, setSkillLoading] = useState(false);
  const [skillError, setSkillError] = useState<string | null>(null);
  const [skillLoaded, setSkillLoaded] = useState(false);
  const [skillSaving, setSkillSaving] = useState(false);
  const [skillGenerating, setSkillGenerating] = useState(false);
  const [skillChatMessages, setSkillChatMessages] = useState<PluginSkillChatMessage[]>([]);
  const [skillChatInput, setSkillChatInput] = useState('');
  const [skillChatSending, setSkillChatSending] = useState(false);
  const [responseProtocol, setResponseProtocol] = useState<PluginResponseProtocol | null>(null);
  const [responseSnapshot, setResponseSnapshot] = useState<PluginResponseProtocol | null>(null);
  const [responseLoading, setResponseLoading] = useState(false);
  const [responseSaving, setResponseSaving] = useState(false);
  const [responseError, setResponseError] = useState<string | null>(null);
  // plugin-creator 配置建议：只预览，用户确认后才应用到草稿
  const [analysis, setAnalysis] = useState<PluginAnalysis | null>(null);
  const [analysisWarnings, setAnalysisWarnings] = useState<string[]>([]);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  // review 类建议需要用户勾选确认才会应用；键为 nodeId:field
  const [confirmedReview, setConfirmedReview] = useState<Set<string>>(new Set());

  const reviewKey = (item: { field: { nodeId: string; field: string } }) => `${item.field.nodeId}:${item.field.field}`;

  const loadGraph = async (id: string) => {
    setGraphLoading(true);
    setGraphError(null);
    try {
      const result = await fetchWorkflowGraph(id);
      const positions = Object.fromEntries(result.graph.nodes.map(node => [node.nodeId, { x: node.x, y: node.y }])) as WorkflowNodePositions;
      setGraph(result.graph);
      setSavedNodePositions(positions);
      setNodePositions({});
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
      const content = await fetchPluginSkill(id);
      setSkillContent(content);
      setSkillSnapshot(content);
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
      const protocol = JSON.parse(JSON.stringify(result.protocol)) as PluginResponseProtocol;
      setResponseProtocol(protocol);
      setResponseSnapshot(structuredClone(protocol));
    } catch (e) {
      setResponseProtocol(null);
      setResponseError((e as Error).message);
    } finally {
      setResponseLoading(false);
    }
  };

  /** 生成配置建议（只读预览，不落盘） */
  const runAnalysis = async () => {
    if (analysisLoading) return;
    setAnalysisLoading(true);
    setAnalysisError(null);
    try {
      const result = await analyzePluginConfig(draft.id);
      setAnalysis(result.analysis);
      setConfirmedReview(new Set(
        result.analysis.widgets
          .filter(item => item.exposure === 'review' && !item.field.connected)
          .map(reviewKey),
      ));
      setAnalysisWarnings(result.warnings ?? []);
    } catch (e) {
      setAnalysis(null);
      setAnalysisWarnings([]);
      setAnalysisError((e as Error).message);
    } finally {
      setAnalysisLoading(false);
    }
  };

  /** 用户确认：把建议应用到本地草稿（仍需点击保存才落盘） */
  const applySuggestions = () => {
    if (!analysis) return;
    setDraft(current => {
      let next = current;
      for (const item of analysis.widgets) {
        const field = item.field as WorkflowGraphField;
        if (!field.selectable || field.connected) continue;
        if (item.exposure === 'llm' || (item.exposure === 'review' && confirmedReview.has(`${field.nodeId}:${field.field}`))) {
          if (!paramForField(next, field)) next = addParamFromField(next, field);
          next = setParamExposed(next, field, true);
          continue;
        }
        const index = next.params.findIndex(param => param.nodeId === field.nodeId && param.field === field.field);
        if (index < 0) continue;
        const param = next.params[index]!;
        next.params[index] = item.exposure === 'hidden'
          ? { ...param, hidden: true }
          : item.exposure === 'fixed'
            ? { ...param, llm: false }
            : param;
      }
      // 用途描述仅在为空时填充，不覆盖手工内容
      if (!next.description?.trim() && analysis.purpose.description) {
        next = { ...next, description: analysis.purpose.description };
      }
      return next;
    });
    setAnalysis(null);
    setAnalysisWarnings([]);
    setConfirmedReview(new Set());
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

  useEffect(() => {
    const base = copyManifest(manifest);
    setDraft(base);
    setSavedSnapshot(structuredClone(base));
    setToast(null);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setLocalError(null);
    setSkillLoaded(false);
    setSkillContent(null);
    setSkillSnapshot(null);
    setSkillError(null);
    setSkillChatMessages([]);
    setSkillChatInput('');
    setSkillChatSending(false);
    setResponseProtocol(null);
    setResponseSnapshot(null);
    setResponseError(null);
    setAnalysis(null);
    setAnalysisWarnings([]);
    setAnalysisError(null);
    setNodePositions({});
    setSavedNodePositions({});
    void loadGraph(manifest.id);
  }, [manifest]);

  const update = (patch: Partial<WorkflowManifest>) => setDraft(current => ({ ...current, ...patch }));
  const updateParam = (index: number, patch: Partial<WorkflowParam>) => setDraft(current => ({ ...current, params: current.params.map((item, i) => i === index ? { ...item, ...patch } : item) }));
  const updateNodePosition = (nodeId: string, position: WorkflowNodePosition) => {
    setNodePositions(current => ({ ...current, [nodeId]: position }));
  };

  const displayGraph = useMemo<WorkflowGraph | null>(() => {
    if (!graph) return null;
    return {
      ...graph,
      nodes: graph.nodes.map(node => ({
        ...node,
        bypassed: draft.params.some(param => param.bypass === true && param.nodeId === node.nodeId && param.default === true),
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

  const addInputCandidate = (candidate: WorkflowInterfaceInputCandidate) => {
    if (draft.inputs.some(item => item.nodeId === candidate.nodeId && item.field === candidate.field)) return;
    update({
      inputs: [...draft.inputs, {
        id: candidate.id,
        kind: candidate.kind,
        type: candidate.type,
        label: candidate.label,
        nodeId: candidate.nodeId,
        field: candidate.field,
        classType: candidate.classType,
      }],
    });
  };

  const addOutputCandidate = (candidate: WorkflowInterfaceOutputCandidate) => {
    if (draft.outputs.some(item => item.nodeId === candidate.nodeId && item.slot === candidate.slot)) return;
    update({
      outputs: [...draft.outputs, {
        id: candidate.id,
        kind: candidate.kind,
        type: candidate.type,
        slot: candidate.slot,
        label: candidate.title,
        nodeId: candidate.nodeId,
        classType: candidate.classType,
      }],
    });
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
      // 已固定的 combo → 勾选加入 LLM 上下文。
      setDraft(current => setParamExposed(current, field, true));
      return;
    }
    // 新勾选：加入 LLM 上下文。
    setDraft(current => addParamFromField(current, field));
  };

  // 工作流接口只展示对外暴露的普通参数；bypass 是节点视图的内部状态。
  const exposedParams = useMemo(() => draft.params.filter(item => item.llm !== false && item.bypass !== true), [draft.params]);
  const editingParam = editingParamId ? draft.params.find(param => param.id === editingParamId && param.bypass !== true) : undefined;
  const updateEditingParam = (patch: Partial<WorkflowParam>) => {
    if (!editingParam) return;
    updateParam(draft.params.indexOf(editingParam), patch);
  };
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
    const validation = validateWorkflowDraft(draft);
    if (!validation) return null;
    const group = validation.group === 'inputs'
      ? '输入'
      : validation.group === 'params'
        ? '参数'
        : validation.group === 'outputs'
          ? '输出'
          : undefined;
    if (validation.code === 'nameRequired') return t('mapping.validate.nameRequired');
    if (validation.code === 'outputRequired') return t('mapping.validate.outputRequired');
    if (validation.code === 'idRequired') return t('mapping.validate.idRequired', { group: group ? groupLabel(group) : '' });
    if (validation.code === 'idDuplicate') return t('mapping.validate.idDuplicate', { group: group ? groupLabel(group) : '', id: validation.id ?? '' });
    if (validation.code === 'nodeRequired') return t('mapping.validate.nodeRequired', { group: group ? groupLabel(group) : '', id: validation.id ?? '' });
    return t('mapping.validate.fieldRequired', { group: group ? groupLabel(group) : '', id: validation.id ?? '' });
  };

  /** 相对保存基准是否有未提交修改（结构性比较，忽略对象引用） */
  const mappingDirty = useMemo(() => savedSnapshot === null || !deepEqual(draft, savedSnapshot), [draft, savedSnapshot]);
  const changedNodePositions = useMemo<WorkflowNodePositions>(() => Object.fromEntries(
    Object.entries(nodePositions).filter(([nodeId, position]) => {
      const saved = savedNodePositions[nodeId];
      return !saved || saved.x !== position.x || saved.y !== position.y;
    }),
  ), [nodePositions, savedNodePositions]);
  const nodePositionDirty = Object.keys(changedNodePositions).length > 0;
  const responseDirty = useMemo(
    () => responseProtocol !== null && (responseSnapshot === null || !deepEqual(responseProtocol, responseSnapshot)),
    [responseProtocol, responseSnapshot],
  );
  const skillDirty = skillContent !== null && (skillSnapshot === null || skillContent !== skillSnapshot);
  const isDirty = mappingDirty || nodePositionDirty || responseDirty || skillDirty;

  const save = async () => {
    if (toast === 'saving') return;
    const validation = validate();
    if (validation) {
      setLocalError(validation);
      return;
    }
    setLocalError(null);
    setResponseError(null);
    setToast('saving');
    if (skillDirty && skillContent !== null) {
      setSkillSaving(true);
      try {
        const result = await savePluginSkill(draft.id, skillContent);
        setSkillContent(result.content);
        setSkillSnapshot(result.content);
      } catch (e) {
        setSkillError((e as Error).message);
        setSkillSaving(false);
        setToast('failed');
        return;
      }
      setSkillSaving(false);
    }
    if (responseDirty && responseProtocol) {
      setResponseSaving(true);
      try {
        const result = await savePluginResponse(draft.id, responseProtocol);
        setResponseProtocol(result.protocol);
        setResponseSnapshot(structuredClone(result.protocol));
      } catch (e) {
        setResponseError((e as Error).message);
        setResponseSaving(false);
        setToast('failed');
        return;
      }
      setResponseSaving(false);
    }
    let ok = true;
    if (mappingDirty || nodePositionDirty) {
      try {
        ok = await onSave(draft, changedNodePositions, !mappingDirty && nodePositionDirty);
      } catch (e) {
        setResponseError((e as Error).message);
        ok = false;
      }
    }
    if (ok) {
      if (mappingDirty) setSavedSnapshot(structuredClone(draft));
      if (nodePositionDirty) {
        setSavedNodePositions(current => ({ ...current, ...changedNodePositions }));
        setNodePositions({});
      }
      setToast('saved');
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(null), 2200);
    } else {
      setToast('failed');
    }
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
            <WorkflowNodeGraph graph={displayGraph} loading={graphLoading} error={graphError} onRetry={() => void loadGraph(draft.id)}            onToggleParam={toggleField} onChangeParamDefault={updateParamDefault} onRemoveParam={removePinnedParam} onChangeNodePosition={updateNodePosition} onToggleNodeBypass={node => setDraft(current => setNodeBypass(current, node.nodeId, !node.bypassed, node.title))} onOpenParamSettings={setEditingParamId} onFullscreen={() => setFullscreen(value => !value)} fullscreen={fullscreen} />
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
            <WorkflowInterfaceView
              manifest={draft}
              params={workflowInterfaceParams(draft)}
              candidates={graph?.interfaceCandidates}
              onAddInput={addInputCandidate}
              onAddOutput={addOutputCandidate}
              onOpenParamSettings={setEditingParamId}
              onToggleInput={id => update({ inputs: draft.inputs.map(item => item.id === id ? { ...item, hidden: !item.hidden } : item) })}
              onToggleOutput={id => update({ outputs: draft.outputs.map(item => item.id === id ? { ...item, hidden: !item.hidden } : item) })}
              onUpdateInput={(id, patch) => update({ inputs: draft.inputs.map(item => item.id === id ? { ...item, ...patch } : item) })}
              onUpdateOutput={(id, patch) => update({ outputs: draft.outputs.map(item => item.id === id ? { ...item, ...patch } : item) })}
              onRemoveInput={id => update({ inputs: draft.inputs.filter(item => item.id !== id) })}
              onRemoveOutput={id => update({ outputs: draft.outputs.filter(item => item.id !== id) })}
            />
          )}
        </div>
        {editingParam && (
          <ParamSettingsModal
            item={editingParam}
            onChange={updateEditingParam}
            onClose={() => setEditingParamId(null)}
          />
        )}
        {(analysis || analysisLoading || analysisError) && (
          <div className="workflow-mapping-suggest" role="status">
            <div className="workflow-mapping-suggest-head">
              <strong>{t('mapping.suggest.title')}</strong>
              <div className="workflow-skill-actions">
                <button className="settings-btn" disabled={analysisLoading} onClick={() => void runAnalysis()}>{analysisLoading ? t('mapping.suggest.loading') : t('mapping.suggest.refresh')}</button>
                {analysis && <button className="settings-btn primary" onClick={applySuggestions}>{t('mapping.suggest.apply')}</button>
                }
                {!analysisLoading && <button className="settings-btn" onClick={() => { setAnalysis(null); setAnalysisWarnings([]); setAnalysisError(null); }}>{t('common.cancel')}</button>}
              </div>
            </div>
            {analysisError && <p className="workflow-mapping-error">{analysisError}</p>}
            {analysis && (
              <>
                <p className="workflow-mapping-suggest-desc">{analysis.purpose.description || t('mapping.suggest.noPurpose')}</p>
                <ul className="workflow-mapping-suggest-list">
                  {analysis.inputs.filter(item => !item.candidate.hidden).map(item => (
                    <li key={`in-${item.candidate.id}`}><strong>{t('mapping.suggest.input')}</strong>{item.candidate.label}（{item.candidate.kind}）<span className="workflow-mapping-suggest-reason">{item.reason}</span></li>
                  ))}
                  {analysis.outputs.filter(item => !item.candidate.hidden).map(item => (
                    <li key={`out-${item.candidate.id}`}><strong>{t('mapping.suggest.output')}</strong>{item.candidate.label}（{item.candidate.kind}）<span className="workflow-mapping-suggest-reason">{item.reason}</span></li>
                  ))}
                  {analysis.widgets.map(item => {
                    const labelKey = item.exposure === 'llm'
                      ? 'mapping.suggest.exposureLlm'
                      : item.exposure === 'fixed'
                        ? 'mapping.suggest.exposureFixed'
                        : item.exposure === 'hidden'
                          ? 'mapping.suggest.exposureHidden'
                          : 'mapping.suggest.exposureReview';
                    const key = reviewKey(item);
                    const confirmable = item.exposure === 'review' && !item.field.connected;
                    return (
                      <li key={`w-${item.field.nodeId}-${item.field.field}`}>
                        {confirmable && (
                          <label className="workflow-mapping-suggest-confirm">
                            <input
                              type="checkbox"
                              checked={confirmedReview.has(key)}
                              onChange={event => {
                                setConfirmedReview(current => {
                                  const next = new Set(current);
                                  if (event.target.checked) next.add(key); else next.delete(key);
                                  return next;
                                });
                              }}
                            />
                            <span>{t('mapping.suggest.confirmExpose')}</span>
                          </label>
                        )}
                        <strong>{t(labelKey)}</strong>{item.field.nodeId}.{item.field.field}
                        {item.field.value !== undefined && item.exposure !== 'llm' ? ` = ${String(item.field.value)}` : ''}
                        <span className="workflow-mapping-suggest-reason">{item.reason}</span>
                        {item.sources && item.sources.length > 0 && (
                          <span className="workflow-mapping-suggest-reason">
                            {t('mapping.suggest.upstreamHint', {
                              sources: item.sources.map(source => `${source.title || source.classType}(${source.fields.join('/')})`).join('、'),
                            })}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {analysisWarnings.length > 0 && <p className="workflow-mapping-notice">{analysisWarnings.join('；')}</p>}
              </>
            )}
          </div>
        )}
        {(localError || error || (view === 'node' && graph?.manifestError)) && <div className="workflow-mapping-error">{localError || error || graph?.manifestError}</div>}
        {redetectNotice && <div className="workflow-mapping-notice">{t('mapping.redetectNotice')}</div>}
        {(isDirty || toast) && (
          <div className="workflow-mapping-save-toast" role="status">
            <span className="settings-save-toast-msg">
              {toast === 'saving'
                ? t('common.saving')
                : toast === 'saved'
                  ? t('common.saved')
                  : toast === 'failed'
                    ? t('common.saveFailedToast')
                    : t('common.unsavedPrompt')}
            </span>
            {toast !== 'saving' && toast !== 'saved' && (
              <button className="settings-btn primary" disabled={saving || skillSaving || responseSaving} onClick={() => void save()}>
                {t('common.save')}
              </button>
            )}
          </div>
        )}
        <footer className="workflow-mapping-foot">
          <button className="settings-btn" onClick={() => { setRedetectNotice(true); onRedetect(); }}>{t('mapping.redetect')}</button>
          <button className="settings-btn" disabled={analysisLoading} onClick={() => void runAnalysis()}>{analysisLoading ? t('mapping.suggest.loading') : t('mapping.suggest.generate')}</button>
          <span />
          <button className="settings-btn" onClick={onClose}>{t('common.cancel')}</button>
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

function compactValue(value: unknown): string {
  if (value === undefined) return '—';
  if (typeof value === 'string') return value.length > 48 ? `${value.slice(0, 48)}…` : value;
  try {
    const text = JSON.stringify(value);
    return text.length > 48 ? `${text.slice(0, 48)}…` : text;
  } catch {
    return String(value);
  }
}

function WorkflowInterfaceView({ manifest, params, candidates, onAddInput, onAddOutput, onOpenParamSettings, onToggleInput, onToggleOutput, onUpdateInput, onUpdateOutput, onRemoveInput, onRemoveOutput }: {
  manifest: WorkflowManifest;
  params: WorkflowParam[];
  candidates?: WorkflowInterfaceCandidates;
  onAddInput: (candidate: WorkflowInterfaceInputCandidate) => void;
  onAddOutput: (candidate: WorkflowInterfaceOutputCandidate) => void;
  onOpenParamSettings: (paramId: string) => void;
  onToggleInput: (id: string) => void;
  onToggleOutput: (id: string) => void;
  onUpdateInput: (id: string, patch: { label?: string; description?: string }) => void;
  onUpdateOutput: (id: string, patch: { label?: string; description?: string }) => void;
  onRemoveInput: (id: string) => void;
  onRemoveOutput: (id: string) => void;
}) {
  const { t } = useTranslation();
  const visibleInputs = manifest.inputs;
  const visibleOutputs = manifest.outputs;
  const availableInputs = (candidates?.inputs ?? []).filter(candidate => !manifest.inputs.some(item => item.nodeId === candidate.nodeId && item.field === candidate.field));
  const availableOutputs = (candidates?.outputs ?? []).filter(candidate => !manifest.outputs.some(item => item.nodeId === candidate.nodeId && item.slot === candidate.slot));

  return (
    <section className="workflow-mapping-section workflow-interface-view">
      <div className="workflow-mapping-section-head">
        <div>
          <h3>{t('mapping.interface.title')}</h3>
          <p>{t('mapping.interface.desc')}</p>
          <small className="workflow-interface-candidate-hint">{t('mapping.interface.candidateHint')}</small>
        </div>
        <div className="workflow-interface-add-toolbar">
          <label>
            <span>{t('mapping.interface.addInput')}</span>
            <select value="" onChange={event => {
              const candidate = availableInputs.find(item => item.id === event.target.value);
              if (candidate) onAddInput(candidate);
            }} aria-label={t('mapping.interface.addInput')}>
              <option value="">{t('mapping.interface.selectInput')}</option>
              {availableInputs.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.title ?? candidate.classType} · {candidate.label} · {candidate.nodeId}.{candidate.field} · {candidate.type}</option>)}
            </select>
          </label>
          <label>
            <span>{t('mapping.interface.addOutput')}</span>
            <select value="" onChange={event => {
              const candidate = availableOutputs.find(item => item.id === event.target.value);
              if (candidate) onAddOutput(candidate);
            }} aria-label={t('mapping.interface.addOutput')}>
              <option value="">{t('mapping.interface.selectOutput')}</option>
              {availableOutputs.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.title} · {candidate.nodeId}.{candidate.slot} · {candidate.type}</option>)}
            </select>
          </label>
        </div>
      </div>
      {visibleInputs.length === 0 && params.length === 0 && visibleOutputs.length === 0 ? (
        <div className="workflow-interface-empty">{t('mapping.interface.empty')}</div>
      ) : (
        <div className="workflow-interface-groups">
          {visibleInputs.length > 0 && (
            <section className="workflow-interface-group">
              <h4>{t('mapping.interface.inputs')}</h4>
              {visibleInputs.map(item => (
                <div className={`workflow-interface-card${item.hidden ? ' hidden' : ''}`} key={item.id}>
                  <div className="workflow-interface-card-main">
                    <div className="workflow-interface-card-title">
                      <input className="workflow-interface-label-input" value={item.label} onChange={event => onUpdateInput(item.id, { label: event.target.value })} aria-label={`${t('mapping.interface.name')}: ${item.label}`} />
                      <span>{item.kind}</span>
                    </div>
                    <div className="workflow-interface-card-actions">
                      <label className="workflow-interface-visibility">
                        <input type="checkbox" checked={!item.hidden} onChange={() => onToggleInput(item.id)} aria-label={`${t('mapping.interface.toggleExposure')}: ${item.label}`} />
                        {item.hidden ? t('mapping.interface.hidden') : t('mapping.interface.exposed')}
                      </label>
                      <button type="button" className="workflow-interface-remove" onClick={() => onRemoveInput(item.id)} aria-label={`${t('mapping.interface.remove')}: ${item.label}`} title={t('mapping.interface.remove')}>×</button>
                    </div>
                  </div>
                  <input className="workflow-interface-description-input" value={item.description ?? ''} onChange={event => onUpdateInput(item.id, { description: event.target.value })} placeholder={t('mapping.interface.descriptionPlaceholder')} aria-label={`${t('mapping.interface.description')}: ${item.label}`} />
                  <em>{item.nodeId}.{item.field}</em>
                </div>
              ))}
            </section>
          )}
          {params.length > 0 && (
            <section className="workflow-interface-group">
              <h4>{t('mapping.interface.params')}</h4>
              {params.map(item => (
                <div className="workflow-interface-card" key={item.id}>
                  <div className="workflow-interface-card-main">
                    <div><strong>{item.label}</strong><span>{item.type}</span></div>
                    <button
                      type="button"
                      className="workflow-interface-settings"
                      title={t('mapping.interface.openSettings')}
                      aria-label={`${t('mapping.interface.openSettings')}: ${item.label}`}
                      onClick={() => onOpenParamSettings(item.id)}
                    >⚙</button>
                  </div>
                  <small>{item.description || t('mapping.interface.noDescription')}</small>
                  <em>{compactValue(item.default)}</em>
                </div>
              ))}
            </section>
          )}
          {visibleOutputs.length > 0 && (
            <section className="workflow-interface-group">
              <h4>{t('mapping.interface.outputs')}</h4>
              {visibleOutputs.map(item => (
                <div className={`workflow-interface-card${item.hidden ? ' hidden' : ''}`} key={item.id}>
                  <div className="workflow-interface-card-main">
                    <div className="workflow-interface-card-title">
                      <input className="workflow-interface-label-input" value={item.label} onChange={event => onUpdateOutput(item.id, { label: event.target.value })} aria-label={`${t('mapping.interface.name')}: ${item.label}`} />
                      <span>{item.kind}</span>
                    </div>
                    <div className="workflow-interface-card-actions">
                      <label className="workflow-interface-visibility">
                        <input type="checkbox" checked={!item.hidden} onChange={() => onToggleOutput(item.id)} aria-label={`${t('mapping.interface.toggleExposure')}: ${item.label}`} />
                        {item.hidden ? t('mapping.interface.hidden') : t('mapping.interface.exposed')}
                      </label>
                      <button type="button" className="workflow-interface-remove" onClick={() => onRemoveOutput(item.id)} aria-label={`${t('mapping.interface.remove')}: ${item.label}`} title={t('mapping.interface.remove')}>×</button>
                    </div>
                  </div>
                  <input className="workflow-interface-description-input" value={item.description ?? ''} onChange={event => onUpdateOutput(item.id, { description: event.target.value })} placeholder={t('mapping.interface.descriptionPlaceholder')} aria-label={`${t('mapping.interface.description')}: ${item.label}`} />
                  <em>{item.nodeId}{item.slot !== undefined ? `.${item.slot}` : ''}</em>
                </div>
              ))}
            </section>
          )}
        </div>
      )}
    </section>
  );
}

function ParamSettingsModal({ item, onChange, onClose }: {
  item: WorkflowParam;
  onChange: (patch: Partial<WorkflowParam>) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="workflow-param-settings-overlay" onClick={onClose}>
      <div
        className="workflow-param-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${t('mapping.param.title')}: ${item.label}`}
        onClick={event => event.stopPropagation()}
      >
        <header className="workflow-param-settings-head">
          <div>
            <span className="settings-section-kicker">{t('mapping.param.title')}</span>
            <h3>{item.label}</h3>
          </div>
          <button className="settings-close" onClick={onClose} aria-label={t('common.close')}>×</button>
        </header>
        <div className="workflow-param-settings-body">
          <ParamRow item={item} onChange={onChange} />
        </div>
        <footer className="workflow-param-settings-foot">
          <button className="settings-btn" onClick={onClose}>{t('common.close')}</button>
        </footer>
      </div>
    </div>
  );
}

function ParamRow({ item, onChange }: {
  item: WorkflowParam;
  onChange: (patch: Partial<WorkflowParam>) => void;
}) {
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
        <Field label={t('mapping.param.field')}><input value={item.field || '—'} readOnly aria-label={t('mapping.param.field')} /></Field>
        <Field label="description" wide><input className="wide" value={item.description ?? ''} onChange={e => onChange({ description: e.target.value })} placeholder={t('mapping.param.descPlaceholder')} /></Field>
        {item.type === 'BOOLEAN' ? (
          <Field label={t('mapping.param.default')} wide>
            <label className="workflow-mapping-bool-default">
              <input type="checkbox" checked={item.default === true} onChange={e => onChange({ default: e.target.checked })} aria-label={t('mapping.param.default')} />
              <span>{item.default === true ? t('common.enabled') : t('common.disabled')}</span>
            </label>
          </Field>
        ) : comboOptions.length > 0 ? (
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
      <div className="workflow-mapping-row-foot">
        <label className="workflow-mapping-hidden"><input type="checkbox" checked={item.hidden ?? false} onChange={e => onChange({ hidden: e.target.checked })} /> {t('mapping.param.hidden')}</label>
      </div>
    </div>
  );
}

