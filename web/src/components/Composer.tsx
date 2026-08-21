import { useEffect, useRef, useState } from 'react';
import type { ComfyStatus, GenerateData, WorkflowParam, WorkflowSpec } from '../api';

type PanelId = 'agent' | 'preference' | 'skills' | null;

export interface Attachment {
  id: string;
  kind: 'image' | 'video';
  name: string;
  dataUrl: string;
}

export interface ComposerSubmitOpts {
  workflowId?: string;
  params?: Record<string, unknown>;
  images?: { name?: string; dataUrl: string }[];
  videos?: { name?: string; dataUrl: string }[];
}

export default function Composer({
  placeholder,
  composer,
  value,
  onChange,
  onSubmit,
  disabled,
  workflows,
  selectedWorkflowId,
  onSelectWorkflow,
  comfyStatus,
}: {
  placeholder: string;
  composer: GenerateData['composer'];
  value: string;
  onChange: (v: string) => void;
  onSubmit: (opts: ComposerSubmitOpts) => void;
  disabled?: boolean;
  workflows: WorkflowSpec[];
  selectedWorkflowId: string | null;
  onSelectWorkflow: (id: string) => void;
  comfyStatus: ComfyStatus | null;
}) {
  const [focused, setFocused] = useState(false);
  const [openPanel, setOpenPanel] = useState<PanelId>(null);
  const [agentMode, setAgentMode] = useState(composer.agentOptions[0] ?? 'Agent 模式');
  const [prefType, setPrefType] = useState(composer.preferences.types[0] ?? '图片');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [params, setParams] = useState<Record<string, unknown>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // 当前选中 workflow（按 图片/视频 输出过滤）
  const selected = workflows.find(w => w.id === selectedWorkflowId) ?? null;
  const filtered = workflows.filter(w =>
    prefType === '视频' ? w.outputs.some(o => o.kind === 'video') : w.outputs.some(o => o.kind === 'image'),
  );
  // 默认优先选不需要上传素材的工作流（避免默认选中 img2img 等强制依赖参考图的）
  const activeWorkflow =
    (selected && filtered.some(w => w.id === selected.id) ? selected : null) ??
    filtered.find(w => !w.inputs.some(i => i.kind !== 'text')) ??
    filtered[0] ??
    null;

  // workflow 切换时重置参数为默认值
  useEffect(() => {
    if (!activeWorkflow) return;
    const next: Record<string, unknown> = {};
    for (const p of activeWorkflow.params) next[p.id] = p.default;
    setParams(next);
  }, [activeWorkflow?.id]);

  const canSend = value.trim().length > 0 && !disabled;

  const submit = () => {
    if (!canSend) return;
    const imageAtts = attachments.filter(a => a.kind === 'image');
    const videoAtts = attachments.filter(a => a.kind === 'video');
    onSubmit({
      workflowId: activeWorkflow?.id,
      params: Object.keys(params).length ? params : undefined,
      images: imageAtts.map(a => ({ name: a.name, dataUrl: a.dataUrl })),
      videos: videoAtts.map(a => ({ name: a.name, dataUrl: a.dataUrl })),
    });
    setAttachments([]);
  };

  const toggle = (p: Exclude<PanelId, null>) => {
    setOpenPanel(openPanel === p ? null : p);
  };

  const selectAgent = (opt: string) => {
    setAgentMode(opt);
    setOpenPanel(null);
  };

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const kind: Attachment['kind'] = file.type.startsWith('video/') ? 'video' : 'image';
      setAttachments(prev => [
        ...prev,
        { id: `a${Date.now()}`, kind, name: file.name, dataUrl: String(reader.result) },
      ]);
    };
    reader.readAsDataURL(file);
  };

  const removeAttachment = (id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  };

  const kindLabel = { image: '图片', video: '视频', text: '文本' };

  const setParam = (id: string, v: unknown) => setParams(prev => ({ ...prev, [id]: v }));

  return (
    <div className={`composer${focused ? ' focused' : ''}`}>
      {openPanel && <div className="composer-mask" onClick={() => setOpenPanel(null)} />}

      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map(a => (
            <span key={a.id} className="attachment-chip">
              <em className={`attachment-kind ${a.kind}`}>{kindLabel[a.kind]}</em>
              {a.name}
              <button className="attachment-remove" onClick={() => removeAttachment(a.id)} aria-label="移除">
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <textarea
        ref={taRef}
        className="composer-input"
        rows={2}
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />

      <div className="composer-bottom">
        <div className="composer-modes">
          {/* Agent 模式下拉（创作类型） */}
          <div className="composer-mode-wrap">
            <button
              className={`composer-mode${openPanel === 'agent' ? ' open' : ''}`}
              onClick={() => toggle('agent')}
            >
              {agentMode}
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {openPanel === 'agent' && (
              <div className="composer-panel agent-panel">
                <div className="panel-title">创作类型</div>
                <ul className="agent-options">
                  {composer.agentOptions.map(opt => (
                    <li key={opt}>
                      <button
                        className={`agent-option${agentMode === opt ? ' active' : ''}`}
                        onClick={() => selectAgent(opt)}
                      >
                        <span>{opt}</span>
                        {agentMode === opt && (
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                            <path d="m3 7.5 2.8 2.8L11 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* 自动：生成偏好（类型 + 工作流 + 动态参数） */}
          <div className="composer-mode-wrap">
            <button
              className={`composer-mode${openPanel === 'preference' ? ' open' : ''}`}
              onClick={() => toggle('preference')}
            >
              自动
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {openPanel === 'preference' && (
              <div className="composer-panel pref-panel">
                <div className="panel-title">生成类型</div>
                <div className="pref-row">
                  {composer.preferences.types.map(t => (
                    <button
                      key={t}
                      className={`pref-chip${prefType === t ? ' active' : ''}`}
                      onClick={() => setPrefType(t)}
                    >
                      {t}
                    </button>
                  ))}
                </div>

                <div className="panel-title">工作流（自动识别输入/输出）</div>
                {filtered.length === 0 ? (
                  <div className="pref-empty">
                    {workflows.length === 0
                      ? '暂无 workflow：请把 workflow_api.json 放到 server/workflows/'
                      : `没有${prefType}输出的工作流`}
                  </div>
                ) : (
                  <ul className="workflow-list">
                    {filtered.map(w => (
                      <li key={w.id}>
                        <button
                          className={`workflow-item${activeWorkflow?.id === w.id ? ' active' : ''}`}
                          onClick={() => {
                            onSelectWorkflow(w.id);
                            setOpenPanel(null);
                          }}
                        >
                          <span className="workflow-item-name">{w.name}</span>
                          <span className="workflow-item-badges">
                            {w.inputs.map(i => (
                              <em key={i.id} className={`wf-badge in ${i.kind}`}>
                                输入·{kindLabel[i.kind]}
                                {i.required ? '·必传' : ''}
                              </em>
                            ))}
                            {w.outputs.map(o => (
                              <em key={o.id} className={`wf-badge out ${o.kind}`}>
                                输出·{kindLabel[o.kind]}
                              </em>
                            ))}
                          </span>
                          {w.description && <span className="workflow-item-desc">{w.description}</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {activeWorkflow && activeWorkflow.params.length > 0 && (
                  <>
                    <div className="panel-title">参数（自动提取）</div>
                    <div className="param-grid">
                      {activeWorkflow.params.map(p => (
                        <ParamControl key={p.id} param={p} value={params[p.id]} onChange={v => setParam(p.id, v)} />
                      ))}
                    </div>
                  </>
                )}

                {activeWorkflow?.inputs.some(i => i.kind === 'image') && (
                  <div className="pref-hint">该工作流需要参考图：点右下角上传按钮添加</div>
                )}
                <div className={`pref-comfy${comfyStatus?.connected ? ' ok' : ' bad'}`}>
                  ComfyUI：{comfyStatus?.connected ? `已连接（${comfyStatus.baseUrl}）` : '未连接'}
                </div>
              </div>
            )}
          </div>

          {/* 使用技能 */}
          <div className="composer-mode-wrap">
            <button
              className={`composer-mode${openPanel === 'skills' ? ' open' : ''}`}
              onClick={() => toggle('skills')}
            >
              使用技能
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {openPanel === 'skills' && (
              <div className="composer-panel skills-panel">
                <div className="panel-title">技能</div>
                <ul className="skill-list">
                  {composer.skills.map(s => (
                    <li key={s.id}>
                      <button
                        className="skill-item"
                        onClick={() => {
                          onChange(`使用技能：${s.name}。${s.desc}`);
                          setOpenPanel(null);
                        }}
                      >
                        <span className="skill-item-name">
                          {s.name}
                          {s.tag && <em className="skill-item-tag">{s.tag}</em>}
                        </span>
                        <span className="skill-item-desc">{s.desc}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="skill-footer">
                  {composer.skillFooter.map(f => (
                    <button key={f} className="skill-footer-btn" onClick={() => setOpenPanel(null)}>
                      {f}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="composer-actions">
          <input ref={fileRef} type="file" accept="image/*,video/*" hidden onChange={onPickFile} />
          <button
            className="composer-tool"
            title="上传素材（图片/视频）"
            aria-label="上传素材"
            onClick={() => fileRef.current?.click()}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <rect x="2.5" y="2.5" width="13" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.3" />
              <circle cx="7" cy="7" r="1.6" fill="currentColor" />
              <path d="m4 12 3.4-3.4 2.4 2.4 1.7-1.7 2.5 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            className="composer-tool"
            title="参考图"
            aria-label="参考图"
            onClick={() => fileRef.current?.click()}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M4 2.5h7l3 3v10H4a1.5 1.5 0 0 1-1.5-1.5V4A1.5 1.5 0 0 1 4 2.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              <path d="M11 2.5V6h3.5M6.5 9.5v4M4.5 11.5h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
          <button
            className={`composer-send${canSend ? ' enabled' : ''}`}
            disabled={!canSend}
            onClick={submit}
            title="发送"
            aria-label="发送"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M10 2.5v11m0 0 4.5-4.5M10 13.5 5.5 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

function ParamControl({
  param,
  value,
  onChange,
}: {
  param: WorkflowParam;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  // value 尚未初始化时回退到 param.default，避免受控/非受控切换警告
  const v = value ?? param.default;
  if (param.type === 'BOOLEAN') {
    return (
      <label className="param-row">
        <span>{param.label}</span>
        <input type="checkbox" checked={!!v} onChange={e => onChange(e.target.checked)} />
      </label>
    );
  }
  if (param.type === 'combo' && param.options?.length) {
    return (
      <label className="param-row">
        <span>{param.label}</span>
        <select value={String(v)} onChange={e => onChange(e.target.value)}>
          {param.options.map(o => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (param.type === 'STRING') {
    return (
      <label className="param-row">
        <span>{param.label}</span>
        <input type="text" value={String(v)} onChange={e => onChange(e.target.value)} />
      </label>
    );
  }
  return (
    <label className="param-row">
      <span>{param.label}</span>
      <input
        type="number"
        value={v as number}
        min={param.min}
        max={param.max}
        step={param.step}
        onChange={e => onChange(param.type === 'FLOAT' ? Number(e.target.value) : Math.round(Number(e.target.value)))}
      />
    </label>
  );
}
