import { useState } from 'react';

// YAML 导出结果对话框：展示协议 YAML 文本，可一键复制。
// 导出失败时展示后端校验错误（不产出坏 YAML）。
export function YamlExportDialog(props: {
  open: boolean;
  yaml: string | null;
  error: string | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (!props.open) return null;

  const copy = () => {
    if (!props.yaml) return;
    void navigator.clipboard.writeText(props.yaml).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="dialog-mask" onClick={props.onClose}>
      <div className="dialog dialog-wide" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">导出 Prompt YAML（MMH3 协议 v1）</div>
        <div className="dialog-body">
          {props.error ? (
            <>
              <p className="ne-error" style={{ whiteSpace: 'pre-wrap' }}>{props.error}</p>
              <p className="addproj-hint">修复画布问题后重试：chain 链必须线性、每个分镜需有归属提示词。</p>
            </>
          ) : (
            <>
              <p className="addproj-hint">
                剧情顺序 = chain 链式参考的拓扑序（与时间线一致）；seed 自动填 42，可在 ComfyUI 中调整。
              </p>
              <pre className="yaml-preview">{props.yaml}</pre>
            </>
          )}
        </div>
        <div className="dialog-actions">
          <button className="btn-ghost" onClick={props.onClose}>关闭</button>
          {props.yaml && (
            <button className="btn-primary" onClick={copy}>{copied ? '已复制 ✓' : '复制 YAML'}</button>
          )}
        </div>
      </div>
    </div>
  );
}
