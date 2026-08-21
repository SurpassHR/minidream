import { useRef, useState } from 'react';
import type { GenerateData } from '../api';

type PanelId = 'agent' | 'preference' | 'skills' | null;

export default function Composer({
  placeholder,
  composer,
  value,
  onChange,
  onSubmit,
  disabled,
}: {
  placeholder: string;
  composer: GenerateData['composer'];
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const [openPanel, setOpenPanel] = useState<PanelId>(null);
  const [agentMode, setAgentMode] = useState(composer.agentOptions[0] ?? 'Agent 模式');
  const [prefType, setPrefType] = useState(composer.preferences.types[0] ?? '图片');
  const [prefRatio, setPrefRatio] = useState(composer.preferences.ratios[0] ?? '智能');
  const [prefModel, setPrefModel] = useState(composer.preferences.models[0] ?? '');
  const taRef = useRef<HTMLTextAreaElement>(null);

  const canSend = value.trim().length > 0 && !disabled;

  const submit = () => {
    if (!canSend) return;
    onSubmit();
  };

  const toggle = (p: Exclude<PanelId, null>) => {
    setOpenPanel(openPanel === p ? null : p);
  };

  const selectAgent = (opt: string) => {
    setAgentMode(opt);
    setOpenPanel(null);
  };

  return (
    <div className={`composer${focused ? ' focused' : ''}`}>
      {openPanel && <div className="composer-mask" onClick={() => setOpenPanel(null)} />}

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

          {/* 自动：生成偏好 */}
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
                <div className="panel-title">生成偏好</div>
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
                <div className="panel-title">选择比例</div>
                <div className="pref-ratios">
                  {composer.preferences.ratios.map(r => (
                    <button
                      key={r}
                      className={`pref-ratio${prefRatio === r ? ' active' : ''}`}
                      onClick={() => setPrefRatio(r)}
                    >
                      {r}
                    </button>
                  ))}
                </div>
                <div className="panel-title">其他设置</div>
                <div className="pref-row">
                  {composer.preferences.models.map(m => (
                    <button
                      key={m}
                      className={`pref-chip${prefModel === m ? ' active' : ''}`}
                      onClick={() => setPrefModel(m)}
                    >
                      {m}
                    </button>
                  ))}
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
          <button className="composer-tool" title="上传素材" aria-label="上传素材">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <rect x="2.5" y="2.5" width="13" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.3" />
              <circle cx="7" cy="7" r="1.6" fill="currentColor" />
              <path d="m4 12 3.4-3.4 2.4 2.4 1.7-1.7 2.5 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button className="composer-tool" title="参考图" aria-label="参考图">
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
