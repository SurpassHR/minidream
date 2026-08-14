import { useEffect, useState } from 'react';
import { client } from '../api/client';
import type { NodeType } from '../types';

// 项目导入对话框：列工作区文件 → 选择 → 指定标题与类型 → 导入为画布节点
export function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState('');
  const [title, setTitle] = useState('');
  const [type, setType] = useState<NodeType>('shot');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // 打开时拉取工作区文件列表（过滤目录项）；重置全部状态（含 busy，防上次导入后残留禁用）
  useEffect(() => {
    if (!open) return;
    setSelected(''); setTitle(''); setError(''); setBusy(false);
    void client.listWorkspace()
      .then((paths) => setFiles(paths.filter((p) => !p.endsWith('/'))))
      .catch(() => setFiles([]));
  }, [open]);

  if (!open) return null;

  const pick = (f: string) => {
    setSelected(f);
    const base = f.split('/').pop() ?? f;
    setTitle(base.replace(/\.[^.]+$/, ''));
  };

  const doImport = async () => {
    if (!selected) return;
    setBusy(true); setError('');
    try {
      await client.importFile(selected, type, title || selected);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="dialog-mask" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">导入项目文件</div>
        <div className="dialog-body">
          <select
            className="ne-input" value={type}
            onChange={(e) => setType(e.target.value as NodeType)}
          >
            <option value="shot">分镜（shot）</option>
            <option value="prompt">提示词（prompt）</option>
            <option value="script">剧本（script）</option>
          </select>
          <div className="import-list">
            {files.map((f) => (
              <div
                key={f}
                className={`import-row ${selected === f ? 'sel' : ''}`}
                onClick={() => pick(f)}
              >{f}</div>
            ))}
            {files.length === 0 && <div className="q-empty">工作区无文件（后端未启动或目录为空）</div>}
          </div>
          <input
            className="ne-input" placeholder="节点标题" value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          {error && <div className="ne-error">{error}</div>}
        </div>
        <div className="dialog-actions">
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={doImport} disabled={!selected || busy}>{busy ? '导入中…' : '导入'}</button>
        </div>
      </div>
    </div>
  );
}
