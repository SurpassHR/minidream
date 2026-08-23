import { useEffect, useMemo, useState } from 'react';
import {
  fetchWorkflowGraph,
  type WorkflowGraph,
  type WorkflowGraphField,
  type WorkflowManifest,
  type WorkflowParam,
} from '../api';
import WorkflowNodeGraph from './WorkflowNodeGraph';
import { isParamSelected, paramForField, removeParam, addParamFromField } from './workflowMappingDraft';
import './WorkflowMappingModal.css';

interface Props {
  manifest: WorkflowManifest;
  saving?: boolean;
  error?: string | null;
  onSave: (manifest: WorkflowManifest) => void;
  onRedetect: () => void;
  onClose: () => void;
}

function copyManifest(manifest: WorkflowManifest): WorkflowManifest {
  const copy = JSON.parse(JSON.stringify(manifest)) as WorkflowManifest;
  // 未保存的自动识别结果只作为节点图候选，参数必须由用户在节点视图中显式勾选。
  if (!manifest.hasManifest) copy.params = [];
  return copy;
}

export default function WorkflowMappingModal({ manifest, saving, error, onSave, onRedetect, onClose }: Props) {
  const [draft, setDraft] = useState(() => copyManifest(manifest));
  const [view, setView] = useState<'node' | 'form'>('node');
  const [fullscreen, setFullscreen] = useState(false);
  const [graph, setGraph] = useState<WorkflowGraph | null>(null);
  const [graphLoading, setGraphLoading] = useState(true);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [redetectNotice, setRedetectNotice] = useState(false);

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

  useEffect(() => {
    setDraft(copyManifest(manifest));
    setLocalError(null);
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

  const updateParamDefault = (field: WorkflowGraphField, value: unknown) => {
    setDraft(current => {
      const param = paramForField(current, field);
      if (!param) return current;
      return {
        ...current,
        params: current.params.map(item => item.id === param.id ? { ...item, default: value } : item),
      };
    });
  };

  const toggleField = (field: WorkflowGraphField) => {
    if (!field.selectable || field.connected) return;
    const existing = paramForField(draft, field);
    if (existing) {
      const detail = existing.description ? `\n说明：${existing.description}` : '';
      if (!window.confirm(`取消参数「${existing.label}」？${detail}\n取消后将丢失已填写配置。`)) return;
      setDraft(current => removeParam(current, field));
      return;
    }
    setDraft(current => addParamFromField(current, field));
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

  const save = () => {
    const validation = validate();
    if (validation) {
      setLocalError(validation);
      return;
    }
    setLocalError(null);
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
        </div>
        <div className="workflow-mapping-body">
          {view === 'node' ? (
            <WorkflowNodeGraph graph={displayGraph} loading={graphLoading} error={graphError} onRetry={() => void loadGraph(draft.id)} onToggleParam={toggleField} onChangeParamDefault={updateParamDefault} onFullscreen={() => setFullscreen(value => !value)} fullscreen={fullscreen} />
          ) : (
            <section className="workflow-mapping-section workflow-parameter-form">
              <div className="workflow-mapping-section-head">
                <div>
                  <h3>Widget 参数配置</h3>
                  <p>这里只显示节点视图中已勾选的 widget；返回节点视图可继续选择参数。</p>
                </div>
              </div>
              {draft.params.length > 0 ? (
                draft.params.map((item, index) => (
                  <ParamRow key={item.id || index} item={item} onChange={patch => updateParam(index, patch)} />
                ))
              ) : (
                <div className="workflow-form-empty">
                  <strong>暂无已勾选的 widget</strong>
                  <span>请先切换到节点视图，在节点字段上勾选需要暴露给 LLM 的参数。</span>
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
          <button className="settings-btn primary" disabled={saving} onClick={save}>{saving ? '保存中…' : '保存映射'}</button>
        </footer>
      </div>
    </div>
  );
}

function ParamRow({ item, onChange }: { item: WorkflowParam; onChange: (patch: Partial<WorkflowParam>) => void }) {
  return (
    <div className="workflow-mapping-row">
      <div className="workflow-mapping-row-head"><strong>参数</strong><span className="workflow-mapping-locked">节点视图选择</span></div>
      <div className="workflow-mapping-grid">
        <input value={item.id} readOnly aria-label="参数映射 ID" />
        <input value={item.label} onChange={e => onChange({ label: e.target.value })} placeholder="名称" />
        <input value={item.type} readOnly aria-label="参数类型" />
        <input value={item.nodeId} readOnly aria-label="参数节点" />
        <input value={item.field} readOnly aria-label="参数字段" />
        <input className="wide" value={item.description ?? ''} onChange={e => onChange({ description: e.target.value })} placeholder="description：给用户/LLM 的用途" />
        <input value={String(item.default ?? '')} onChange={item.type === 'combo' ? undefined : e => onChange({ default: e.target.value })} readOnly={item.type === 'combo'} placeholder={item.type === 'combo' ? '节点视图中配置' : '默认值'} />
        <input type="number" value={item.min ?? ''} onChange={e => onChange({ min: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder="最小值" />
        <input type="number" value={item.max ?? ''} onChange={e => onChange({ max: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder="最大值" />
        <input type="number" value={item.step ?? ''} onChange={e => onChange({ step: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder="步长" />
        <input className="wide" value={item.options?.join(', ') ?? ''} readOnly aria-label="combo 选项" placeholder="节点视图中配置 combo 选项" />
      </div>
      <label><input type="checkbox" checked={item.hidden ?? false} onChange={e => onChange({ hidden: e.target.checked })} /> 隐藏</label>
    </div>
  );
}

