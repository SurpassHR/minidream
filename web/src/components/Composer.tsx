import { useRef, useState } from 'react';

export default function Composer({
  placeholder,
  modes,
  value,
  onChange,
  onSubmit,
  disabled,
  mode,
  onModeChange,
}: {
  placeholder: string;
  modes: string[];
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  mode: string;
  onModeChange: (mode: string) => void;
}) {
  const [focused, setFocused] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const canSend = value.trim().length > 0 && !disabled;

  const submit = () => {
    if (!canSend) return;
    onSubmit();
  };

  return (
    <div className={`composer${focused ? ' focused' : ''}`}>
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
          {modes.map(m => (
            <button
              key={m}
              className={`composer-mode${mode === m ? ' active' : ''}`}
              onClick={() => onModeChange(m)}
            >
              {m}
              {m === modes[0] && (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          ))}
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
