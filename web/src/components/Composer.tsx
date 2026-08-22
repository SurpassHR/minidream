import { useRef, useState } from 'react';
import type { GenerateData } from '../api';
import { computeResolution } from '../resolution';

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
  /** 生成比例（如 16:9 / 智能） */
  ratio?: string;
  /** 生成尺寸（MP，如 1 / 1.5 / 8） */
  size?: number;
}

/** 尺寸显示：1 → 1MP，1.5 → 1.5MP */
function formatSize(v: number): string {
  const n = Math.round(v * 100) / 100;
  return Number.isInteger(n) ? String(n) : String(n);
}

export default function Composer({
  placeholder,
  composer,
  value,
  onChange,
  onSubmit,
  onStop,
  disabled,
}: {
  placeholder: string;
  composer: GenerateData['composer'];
  value: string;
  onChange: (v: string) => void;
  onSubmit: (opts: ComposerSubmitOpts) => void;
  onStop?: () => void;
  disabled?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const [openPanel, setOpenPanel] = useState<PanelId>(null);
  const [agentMode, setAgentMode] = useState(composer.agentOptions[0] ?? 'Agent 模式');
  const [ratio, setRatio] = useState(composer.preferences.ratios[0] ?? '智能');
  const sizeCfg = composer.preferences.sizes ?? { min: 0.5, max: 10, step: 0.5, default: 1 };
  const [size, setSize] = useState(sizeCfg.default);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const canSend = value.trim().length > 0 && !disabled;

  const clampSize = (v: number) => Math.min(sizeCfg.max, Math.max(sizeCfg.min, v));
  // 当前比例+尺寸对应的像素预览（智能比例 → null）
  const preview = computeResolution(ratio, size);

  const submit = () => {
    if (!canSend) return;
    const imageAtts = attachments.filter(a => a.kind === 'image');
    const videoAtts = attachments.filter(a => a.kind === 'video');
    onSubmit({
      images: imageAtts.map(a => ({ name: a.name, dataUrl: a.dataUrl })),
      videos: videoAtts.map(a => ({ name: a.name, dataUrl: a.dataUrl })),
      ratio,
      size,
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

          {/* 生成比例 + 生成尺寸 */}
          <div className="composer-mode-wrap">
            <button
              className={`composer-mode${openPanel === 'preference' ? ' open' : ''}`}
              onClick={() => toggle('preference')}
              title="生成比例 / 生成尺寸"
            >
              {ratio} · {formatSize(size)}MP
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {openPanel === 'preference' && (
              <div className="composer-panel pref-panel">
                <div className="panel-title">生成比例</div>
                <div className="pref-ratios">
                  {composer.preferences.ratios.map(r => (
                    <button
                      key={r}
                      className={`pref-ratio${ratio === r ? ' active' : ''}`}
                      onClick={() => setRatio(r)}
                    >
                      {r}
                    </button>
                  ))}
                </div>

                <div className="panel-title">生成尺寸</div>
                <div className="pref-size">
                  <div className="pref-size-row">
                    <button
                      className="pref-size-btn"
                      onClick={() => setSize(prev => clampSize(Math.round((prev - sizeCfg.step) / sizeCfg.step) * sizeCfg.step))}
                      aria-label="减小尺寸"
                    >
                      −
                    </button>
                    <div className="pref-size-input-wrap">
                      <input
                        className="pref-size-input"
                        type="number"
                        min={sizeCfg.min}
                        max={sizeCfg.max}
                        step={sizeCfg.step}
                        value={size}
                        onChange={e => {
                          const v = parseFloat(e.target.value);
                          setSize(Number.isFinite(v) ? clampSize(v) : sizeCfg.default);
                        }}
                      />
                      <span className="pref-size-unit">MP</span>
                    </div>
                    <button
                      className="pref-size-btn"
                      onClick={() => setSize(prev => clampSize(Math.round((prev + sizeCfg.step) / sizeCfg.step) * sizeCfg.step))}
                      aria-label="增大尺寸"
                    >
                      +
                    </button>
                  </div>
                  <input
                    className="pref-size-range"
                    type="range"
                    min={sizeCfg.min}
                    max={sizeCfg.max}
                    step={sizeCfg.step}
                    value={size}
                    onChange={e => setSize(clampSize(parseFloat(e.target.value)))}
                  />
                  <div className="pref-size-scale">
                    <span>{formatSize(sizeCfg.min)}MP</span>
                    <span>{formatSize(sizeCfg.max)}MP</span>
                  </div>
                  <div className="pref-size-preview">
                    {preview ? (
                      <>
                        <span className="pref-size-preview-px">{preview.width} × {preview.height} px</span>
                        {preview.capped && (
                          <span className="pref-size-preview-hint">已按最大边长等比缩放</span>
                        )}
                      </>
                    ) : (
                      <span className="pref-size-preview-hint">智能比例：跟随工作流默认分辨率</span>
                    )}
                  </div>
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
          {disabled ? (
            <button
              className="composer-stop"
              onClick={onStop}
              title="停止生成"
              aria-label="停止生成"
            >
              <span className="composer-stop-icon" />
              停止
            </button>
          ) : (
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
          )}
        </div>
      </div>
    </div>
  );
}
