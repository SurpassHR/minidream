import { Icon } from '../icons';
import type { ProjectInfo } from '../types';

// 项目列表：真实数据源（/api/projects）+ 点击切换项目（/api/project/switch）
// 统计来自后端：有 .director 图数据时按 shot 节点统计，否则扫 shot_*.md；-1 = 未知
function fmtMeta(p: ProjectInfo): string {
  if (p.shots >= 0 && p.duration >= 0) {
    return `${p.shots} 分镜 · ${p.duration.toFixed(2).replace(/\.?0+$/, '')}s`;
  }
  if (p.shots >= 0) return `${p.shots} 分镜`;
  return '尚未构建画布';
}

export function ProjectList(props: {
  projects: ProjectInfo[];
  activePath: string;
  onSelect: (path: string) => void;
  onAdd: () => void;
  onRemove: (path: string, name: string) => void;
}) {
  return (
    <div className="projects">
      {props.projects.map((p) => (
        <div
          key={p.path}
          className={`proj ${p.path === props.activePath ? 'active' : ''}`}
          data-testid={`project-${p.name}`}
          title={p.path}
          onClick={() => props.onSelect(p.path)}
        >
          <div className="pico"><Icon name="film" /></div>
          <div className="pinfo">
            <div className="pname">{p.name}</div>
            <div className="pmeta">{fmtMeta(p)}</div>
          </div>
          {p.mode && <span className="pmode">{p.mode}</span>}
          <button
            className="proj-remove"
            title="从项目栏移除（不删除目录）"
            onClick={(e) => { e.stopPropagation(); props.onRemove(p.path, p.name); }}
          ><Icon name="x" /></button>
        </div>
      ))}
      {props.projects.length === 0 && (
        <div className="q-empty">尚未添加项目</div>
      )}
      <button className="proj-add" onClick={props.onAdd}>＋ 添加项目</button>
    </div>
  );
}
