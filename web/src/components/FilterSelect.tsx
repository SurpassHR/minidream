import { useEffect, useRef, useState } from 'react';

/**
 * 可筛选下拉：适合选项较多的场景（模型/采样器/调度器等）。
 * - 触发按钮显示当前值，点击展开；顶部搜索框输入即过滤
 * - 点击选项选中并关闭；Escape / 点击外部关闭
 */
export default function FilterSelect({
  value,
  onChange,
  options,
  placeholder = '请选择',
  searchPlaceholder = '输入以筛选…',
  className = '',
  disabled,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  searchPlaceholder?: string;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const q = query.trim().toLowerCase();
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

  const select = (v: string) => {
    onChange(v);
    setOpen(false);
    setQuery('');
  };

  const selected = options.includes(value) ? value : '';

  return (
    <div className={`filter-select${className ? ` ${className}` : ''}`} ref={rootRef}>
      <button
        type="button"
        className="filter-select-trigger"
        onClick={() => !disabled && setOpen(prev => !prev)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={selected}
      >
        <span className="filter-select-value">{selected || placeholder}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="filter-select-menu" role="listbox">
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
                  className={`filter-select-option${o === value ? ' active' : ''}`}
                  onClick={() => select(o)}
                  role="option"
                  aria-selected={o === value}
                  title={o}
                >
                  <span className="filter-select-option-text">{o}</span>
                  {o === value && (
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
    </div>
  );
}
