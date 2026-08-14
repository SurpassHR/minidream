import type { GenTask } from '../types';

export function GenQueue({ tasks }: { tasks: GenTask[] }) {
  return (
    <div className="queue">
      <div className="panel-title">生成队列 <span className="mini">ComfyUI</span></div>
      {tasks.map((t) => (
        <div key={t.id} className="q-row">
          {t.status === 'success' && <span className="q-icon ok">✓</span>}
          {t.status === 'running' && <span className="q-icon rec">●</span>}
          {t.status === 'queued' && <span className="q-icon">·</span>}
          {t.status === 'failed' && <span className="q-icon rec">✕</span>}
          <span className="q-name">
            {t.status === 'success' && t.result ? t.result.videoPath : t.status === 'failed' ? `失败：${t.error ?? ''}` : `生成中 ${t.progress}%`}
          </span>
          {t.status === 'running' && (
            <div className="q-bar"><i style={{ width: `${t.progress}%` }} /></div>
          )}
        </div>
      ))}
      {tasks.length === 0 && <div className="q-empty">暂无生成任务</div>}
    </div>
  );
}
