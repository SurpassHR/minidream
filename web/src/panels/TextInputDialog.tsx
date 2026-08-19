import { useEffect, useState } from 'react';

export function TextInputDialog(props: {
  open: boolean;
  title: string;
  body?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  busy?: boolean;
  error?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(props.defaultValue ?? '');

  useEffect(() => {
    if (props.open) setValue(props.defaultValue ?? '');
  }, [props.open, props.defaultValue]);

  if (!props.open) return null;

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || props.busy) return;
    props.onConfirm(trimmed);
  };

  return (
    <div className="dialog-mask" onClick={props.onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">{props.title}</div>
        {props.body && <div className="dialog-body">{props.body}</div>}
        <div className="dialog-body">
          <input
            className="ne-input"
            data-testid="text-dialog-input"
            aria-label="名称"
            autoFocus
            placeholder={props.placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          />
          {props.error && <div className="ne-error">{props.error}</div>}
        </div>
        <div className="dialog-actions">
          <button className="btn-ghost" onClick={props.onCancel} disabled={props.busy}>取消</button>
          <button
            className="btn-primary"
            data-testid="text-dialog-confirm"
            onClick={submit}
            disabled={!value.trim() || props.busy}
          >{props.busy ? '保存中…' : (props.confirmLabel ?? '保存')}</button>
        </div>
      </div>
    </div>
  );
}
