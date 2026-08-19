import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons';
import type { ProjectInfo } from '../types';

// 顶栏项目切换器：点击当前项目名弹出下拉面板（项目列表 + 添加入口）。
// 项目 = 故事向导 + 物体设计 + 画布三部分的容器（切换后三视图同步刷新）
function fmtMeta(p: ProjectInfo): string {
  if (p.shots >= 0 && p.duration >= 0) {
    return `${p.shots} 分镜 · ${p.duration.toFixed(2).replace(/\.?0+$/, '')}s`;
  }
  if (p.shots >= 0) return `${p.shots} 分镜`;
  return '尚未构建画布';
}

export function ProjectSwitcher(props: {
  projects: ProjectInfo[];
  activePath: string;
  // 当前项目名兜底：仅在已打开项目时使用 graph 项目名；未打开时固定显示引导文案
  fallbackName: string;
  projectOpen?: boolean;
  onSelect: (path: string) => void;
  onAdd: () => void;
  onRename?: (path: string, name: string) => void;
  onRemove: (path: string, name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = props.projects.find((p) => p.path === props.activePath);

  // 点击外部关闭下拉
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="project-switcher" ref={rootRef}>
      <button
        type="button"
        className="project-switch-btn"
        data-testid="project-name"
        title="切换项目（故事向导 / 物体设计 / 画布共享同一项目）"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ps-ico"><Icon name="film" /></span>
        <span className="ps-name">{props.projectOpen === false ? '未打开项目' : (current?.name ?? (props.fallbackName || '加载中…'))}</span>
        <span className="ps-caret">▾</span>
      </button>
      {open && (
        <div className="project-dropdown" data-testid="project-dropdown">
          <div className="ps-title">项目 <span className="mini">手动添加 · 点击切换</span></div>
          {props.projects.map((p) => (
            <div
              key={p.path}
              className={`ps-item${p.path === props.activePath ? ' active' : ''}`}
              data-testid={`project-${p.name}`}
              title={p.path}
              onClick={() => { props.onSelect(p.path); setOpen(false); }}
            >
              <div className="pico"><Icon name="film" /></div>
              <div className="pinfo">
                <div className="pname">{p.name}</div>
                <div className="pmeta">{fmtMeta(p)}</div>
              </div>
              {p.path === props.activePath && <span className="ps-check"><Icon name="check" /></span>}
              <div className="project-item-actions" data-testid={`project-${p.name}-actions`}>
                {props.onRename && (
                  <button
                    className="proj-edit"
                    title="重命名项目"
                    onClick={(e) => { e.stopPropagation(); props.onRename?.(p.path, p.name); }}
                  ><Icon name="pencil" /></button>
                )}
                <button
                  className="proj-remove"
                  title="删除项目文件（不可恢复）"
                  onClick={(e) => { e.stopPropagation(); props.onRemove(p.path, p.name); }}
                ><Icon name="trash" /></button>
              </div>
            </div>
          ))}
          {props.projects.length === 0 && (
            <div className="q-empty">尚未添加项目</div>
          )}
          <button
            className="ps-add"
            onClick={() => { setOpen(false); props.onAdd(); }}
          >＋ 添加项目</button>
        </div>
      )}
    </div>
  );
}
