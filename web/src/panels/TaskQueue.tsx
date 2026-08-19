import { Icon } from '../icons';
import type { TaskKind, TaskRecord, TaskStatus } from '../types';

const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: '排队中', running: '运行中', success: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断',
};

const KIND_LABEL: Record<TaskKind, string> = {
  'comfy-generation': '视频生成',
  'comfy-design': '参考图',
  'ollama-vision': '图像理解',
  'ollama-embedding': '知识库检索',
};

function projectName(path?: string): string {
  if (!path) return '全局';
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function TaskStatusIcon({ status }: { status: TaskStatus }) {
  if (status === 'success') return <span className="q-icon ok"><Icon name="check" /></span>;
  if (status === 'failed' || status === 'interrupted') return <span className="q-icon rec"><Icon name="x" /></span>;
  if (status === 'running') return <span className="q-icon rec">●</span>;
  if (status === 'cancelled') return <span className="q-icon">×</span>;
  return <span className="q-icon">·</span>;
}

export function TaskQueue(props: {
  tasks: TaskRecord[];
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  const tasks = [...props.tasks].sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <div className="task-queue" data-testid="task-queue">
      <div className="task-queue-summary">
        <span>{tasks.filter((task) => task.status === 'queued').length} 排队</span>
        <span>{tasks.filter((task) => task.status === 'running').length} 运行</span>
        <span>{tasks.filter((task) => task.status === 'failed' || task.status === 'interrupted').length} 异常</span>
      </div>
      {tasks.map((task) => (
        <div key={task.id} className={`task-row task-${task.status}`} data-testid={`task-row-${task.id}`}>
          <TaskStatusIcon status={task.status} />
          <div className="task-main">
            <div className="task-row-head">
              <span className="task-label">{task.label}</span>
            </div>
            <div className="task-meta">
              <span>{KIND_LABEL[task.kind]}</span>
              <span title={task.projectDir}>{projectName(task.projectDir)}</span>
              {task.status === 'running' && <span>{task.progress}%</span>}
            </div>
            {task.status === 'running' && <div className="task-progress"><i style={{ width: `${Math.max(0, Math.min(100, task.progress))}%` }} /></div>}
            {task.error && <div className="task-error">{task.error}</div>}
          </div>
          <span className={`task-status task-status-${task.status}`}>{STATUS_LABEL[task.status]}</span>
          <div className="task-actions">
            {task.status === 'queued' && (
              <button type="button" className="btn-ghost" aria-label="取消排队任务" title="取消排队任务" onClick={() => props.onCancel(task.id)}>取消</button>
            )}
            {(task.status === 'failed' || task.status === 'interrupted') && (
              <button type="button" className="btn-ghost" aria-label="重试任务" title="重试任务" onClick={() => props.onRetry(task.id)}>重试</button>
            )}
          </div>
        </div>
      ))}
      {tasks.length === 0 && <div className="task-empty">暂无任务</div>}
    </div>
  );
}
