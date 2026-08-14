export interface ProjectInfo {
  id: string;
  name: string;
  meta: string;   // 如 "3 分镜 · 11.25s"
  mode: string;   // 如 "KEYFRAME" / "REF2V"
}

export function ProjectList(props: {
  projects: ProjectInfo[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="projects">
      {props.projects.map((p) => (
        <div
          key={p.id}
          className={`proj ${p.id === props.activeId ? 'active' : ''}`}
          onClick={() => props.onSelect(p.id)}
        >
          <div className="pico">🎬</div>
          <div className="pinfo">
            <div className="pname">{p.name}</div>
            <div className="pmeta">{p.meta}</div>
          </div>
          <span className="pmode">{p.mode}</span>
        </div>
      ))}
    </div>
  );
}
