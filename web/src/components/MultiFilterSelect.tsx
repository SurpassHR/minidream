import { useEffect, useRef, useState } from 'react';

/** 多选参数中一个带强度的选中项（如 LoRA 名称 + 强度） */
export interface MultiSelectItem {
  name: string;
  strength: number;
}

/**
 * 强度输入：编辑期间保留本地草稿，失焦/回车时解析并钳制后提交。
 * 避免受控输入在键入中间态（如 "-" → Number('-')=NaN）时被立即重置，导致无法输入负值。
 */
function StrengthInput({
  value,
  min,
  max,
  step,
  onCommit,
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (value: number) => void;
  ariaLabel: string;
}) {
  const [draft, setDraft] = useState(String(value));

  // 外部值变化（如切换插件、重置）时同步草稿
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const text = draft.trim();
    const num = Number(text);
    if (text === '' || !Number.isFinite(num)) {
      // 非法输入（空 / 仅符号等）回退为当前值
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, num));
    setDraft(String(clamped));
    onCommit(clamped);
  };

  return (
    <input
      type="number"
      className="multi-filter-chip-strength-input"
      value={draft}
      min={min}
      max={max}
      step={step}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
      onFocus={e => e.currentTarget.select()}
      aria-label={ariaLabel}
    />
  );
}

/**
 * 可筛选多选下拉：适合模型/LoRA 等选项较多且可多选的场景。
 * - 触发按钮显示已选数量；展开后搜索框过滤，点击选项勾选/取消（不关闭）
 * - 已选项以 chip 展示在下方：每项可单独调节强度（数字输入）或移除
 */
export default function MultiFilterSelect({
  value,
  onChange,
  options,
  placeholder = '请选择',
  searchPlaceholder = '输入以筛选…',
  className = '',
  disabled,
  ariaLabel,
  defaultStrength = 1,
  strengthMin = -10,
  strengthMax = 10,
  strengthStep = 0.05,
}: {
  value: MultiSelectItem[];
  onChange: (value: MultiSelectItem[]) => void;
  options: string[];
  placeholder?: string;
  searchPlaceholder?: string;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
  /** 新选中项（无显式强度）的默认强度 */
  defaultStrength?: number;
  strengthMin?: number;
  strengthMax?: number;
  strengthStep?: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const q = query.trim().toLowerCase();
  const selected = value.filter(item => options.includes(item.name));
  const selectedNames = new Set(selected.map(item => item.name));
  const filtered = options.filter(o => o.toLowerCase().includes(q));

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    inputRef.current?.focus();
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = (name: string) => {
    if (selectedNames.has(name)) onChange(value.filter(item => item.name !== name));
    else onChange([...value, { name, strength: defaultStrength }]);
  };

  const remove = (name: string) => onChange(value.filter(item => item.name !== name));

  const setStrength = (name: string, strength: number) => {
    const num = Number.isFinite(strength) ? Math.min(strengthMax, Math.max(strengthMin, strength)) : defaultStrength;
    onChange(value.map(item => (item.name === name ? { ...item, strength: num } : item)));
  };

  const strengthOf = (item: MultiSelectItem): number =>
    Number.isFinite(item.strength) ? Math.min(strengthMax, Math.max(strengthMin, item.strength)) : defaultStrength;

  return (
    <div className={`filter-select multi-filter-select${className ? ` ${className}` : ''}`} ref={rootRef}>
      <button
        type="button"
        className="filter-select-trigger"
        onClick={() => !disabled && setOpen(prev => !prev)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span className="filter-select-value">
          {selected.length > 0 ? `已选 ${selected.length} 项` : placeholder}
        </span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="filter-select-menu" role="listbox" aria-multiselectable="true">
          <input
            ref={inputRef}
            className="filter-select-search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
          />
          <div className="filter-select-options">
            {filtered.length === 0 ? (
              <div className="filter-select-empty">无匹配选项</div>
            ) : (
              filtered.map(o => (
                <button
                  key={o}
                  type="button"
                  className={`filter-select-option${selectedNames.has(o) ? ' active' : ''}`}
                  onClick={() => toggle(o)}
                  role="option"
                  aria-selected={selectedNames.has(o)}
                  title={o}
                >
                  <span className="filter-select-option-text">{o}</span>
                  {selectedNames.has(o) && (
                    <svg className="filter-select-option-check" width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                      <path d="m3 7.5 2.8 2.8L11 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
      {selected.length > 0 && (
        <div className="multi-filter-chips">
          {selected.map(item => (
            <span key={item.name} className="multi-filter-chip" title={item.name}>
              <span className="multi-filter-chip-text">{item.name}</span>
              <label className="multi-filter-chip-strength">
                <span className="multi-filter-chip-strength-label">强度</span>
                <StrengthInput
                  value={strengthOf(item)}
                  min={strengthMin}
                  max={strengthMax}
                  step={strengthStep}
                  onCommit={num => setStrength(item.name, num)}
                  ariaLabel={`${item.name} 强度`}
                />
              </label>
              <button
                type="button"
                className="multi-filter-chip-x"
                onClick={() => remove(item.name)}
                aria-label={`移除 ${item.name}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
