import { useEffect, useState } from 'react';
import { client } from '../api/client';
import type { ProjectInfo } from '../types';

// 添加项目对话框：输入剧本项目目录路径（绝对路径，或相对当前项目父目录的相对路径）。
// 校验规则（后端强制）：含 mmh3_prompts / prompts 的剧本项目，或空目录（创作起点）；
// 其他目录拒绝添加。添加成功后持久化注册表，之后自动显示在项目栏。
export function AddProjectDialog(props: {
  open: boolean;
  onClose: () => void;
  onAdded: (projects: ProjectInfo[]) => void;
}) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // 打开时重置状态（含 busy，防上次添加残留禁用）
  useEffect(() => {
    if (!props.open) return;
    setPath(''); setError(''); setBusy(false);
  }, [props.open]);

  if (!props.open) return null;

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
          <p className="addproj-hint">输入剧本项目目录路径（绝对路径，或相对当前项目父目录的相对路径）。</p>
          <p className="addproj-hint">可添加：含 mmh3_prompts / prompts 的剧本项目，或空目录（作为新项目起点）。</p>
          <input
            className="ne-input"
            placeholder="/media/hr/Data/mmh3-creation/classroom-story"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            autoFocus
          />
          {error && <div className="ne-error">{error}</div>}
        </div>
        <div className="dialog-actions">
          <button className="btn-ghost" onClick={props.onClose}>取消</button>
          <button className="btn-primary" onClick={doAdd} disabled={!path.trim() || busy}>
            {busy ? '添加中…' : '添加'}
          </button>
        </div>
      </div>
    </div>
  );
}
