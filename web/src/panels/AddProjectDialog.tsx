import { useEffect, useState } from 'react';
import { client } from '../api/client';
import type { ProjectInfo } from '../types';

// 添加项目对话框：可手动输入路径，也可通过本机原生文件浏览器选择真实目录。
// 校验规则（后端强制）：含 mmh3_prompts / prompts 的剧本项目，或空目录（创作起点）；
// 其他目录拒绝添加。添加成功后持久化注册表，之后自动显示在项目栏。
export function AddProjectDialog(props: {
  open: boolean;
  onClose: () => void;
  onAdded: (projects: ProjectInfo[]) => void;
}) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [error, setError] = useState('');

  // 打开时重置状态（含 busy，防上次添加残留禁用）
  useEffect(() => {
    if (!props.open) return;
    setPath(''); setError(''); setBusy(false); setPickerBusy(false);
  }, [props.open]);

  if (!props.open) return null;

  const chooseDirectory = async () => {
    setPickerBusy(true); setError('');
    try {
      const selected = await client.pickProjectDirectory();
      if (selected) setPath(selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPickerBusy(false);
    }
  };

  const doAdd = async () => {
    if (!path.trim()) return;
    setBusy(true); setError('');
    try {
      const projects = await client.addProject(path.trim());
      props.onAdded(projects);
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="dialog-mask" onClick={props.onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">添加项目</div>
        <div className="dialog-body">
          <p className="addproj-hint">选择或输入剧本项目目录路径。</p>
          <p className="addproj-hint">可添加：含 mmh3_prompts / prompts 的剧本项目，或空目录（作为新项目起点）。</p>
          <div className="addproj-path-row">
            <input
              className="ne-input"
              placeholder="/media/hr/Data/mmh3-creation/classroom-story"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              autoFocus
              disabled={busy || pickerBusy}
            />
            <button className="btn-ghost addproj-browse" onClick={() => { void chooseDirectory(); }} disabled={busy || pickerBusy}>
              {pickerBusy ? '打开中…' : '浏览'}
            </button>
          </div>
          {error && <div className="ne-error">{error}</div>}
        </div>
        <div className="dialog-actions">
          <button className="btn-ghost" onClick={props.onClose} disabled={busy || pickerBusy}>取消</button>
          <button className="btn-primary" onClick={doAdd} disabled={!path.trim() || busy || pickerBusy}>
            {busy ? '添加中…' : '添加'}
          </button>
        </div>
      </div>
    </div>
  );
}
