import { useEffect, useState } from 'react';
import type { ActiveSession, ActivitySnapshot, TaskItem } from '../api';

function formatDuration(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

function sessionStatus(status: ActiveSession['status']): string {
  if (status === 'running') return '进行中';
  if (status === 'canceled') return '已终止';
  if (status === 'completed') return '已完成';
  return '失败';
}

function taskStatus(task: TaskItem): string {
  if (task.status === 'queued') return '排队中';
  if (task.status === 'running') return '生成中';
  if (task.status === 'canceled') return '已取消';
  if (task.status === 'completed') return '已完成';
  if (task.status === 'interrupted') return '已中断';
  return '失败';
}

function taskProgress(task: TaskItem): number {
  if (task.status === 'completed' || task.status === 'failed' || task.status === 'canceled' || task.status === 'interrupted') return 100;
  const stage = task.stages.find(item => item.status === 'active') ?? task.stages[task.stages.length - 1];
  return Math.max(0, Math.min(100, stage?.progress ?? (task.status === 'running' ? 5 : 0)));
}

export default function ActivityPanel({
  snapshot,
  onClose,
  onCancelSession,
  onCancelTask,
}: {
  snapshot: ActivitySnapshot;
  onClose: () => void;
  onCancelSession: (sessionId: string) => void;
  onCancelTask: (taskId: string) => void;
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const runningSessions = snapshot.sessions.filter(session => session.status === 'running');
  const runningTasks = snapshot.tasks.filter(task => task.status === 'queued' || task.status === 'running');
  const count = runningSessions.length + runningTasks.length;
  const visibleSessions = snapshot.sessions;
  const visibleTasks = snapshot.tasks;

  return (
    <div className="activity-panel" role="dialog" aria-modal="true" aria-label="运行中活动">
      <div className="activity-panel-head">
        <div>
          <div className="activity-panel-kicker">实时状态</div>
          <h2>运行中的活动</h2>
        </div>
        <button className="activity-close" onClick={onClose} aria-label="关闭活动面板">×</button>
      </div>

      {visibleSessions.length === 0 && visibleTasks.length === 0 ? (
        <div className="activity-empty">
          <span className="activity-empty-icon">✓</span>
          <p>当前没有正在进行的会话或生成任务</p>
        </div>
      ) : (
        <div className="activity-list">
          {visibleSessions.length > 0 && (
            <section className="activity-section">
              <div className="activity-section-title">对话 <em>{visibleSessions.length}</em></div>
              {visibleSessions.map(session => {
                const isRunning = session.status === 'running';
                return (
                  <div key={session.sessionId} className={`activity-item activity-session${isRunning ? '' : ' activity-history-item'}`}>
                    <div className="activity-item-head">
                      <span className={`activity-pulse${isRunning ? '' : ' history'}`} />
                      <span className="activity-item-title">导演 Agent 对话</span>
                      <span className="activity-item-status">{sessionStatus(session.status)}</span>
                    </div>
                    <p className="activity-item-message">{session.message}</p>
                    <div className="activity-item-meta">
                      <span>{formatDuration(session.startedAt, now)}</span>
                      <span>{session.taskIds.length} 个关联任务</span>
                      {isRunning && (
                        <button className="activity-danger-btn" onClick={() => onCancelSession(session.sessionId)}>
                          终止会话
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </section>
          )}

          {visibleTasks.length > 0 && (
            <section className="activity-section">
              <div className="activity-section-title">生成任务 <em>{visibleTasks.length}</em></div>
              {visibleTasks.map(task => {
                const stage = task.stages.find(item => item.status === 'active') ?? task.stages[task.stages.length - 1];
                const percent = taskProgress(task);
                const isRunning = task.status === 'queued' || task.status === 'running';
                return (
                  <div key={task.id} className={`activity-item activity-task${isRunning ? '' : ' activity-history-item'}`}>
                    <div className="activity-item-head">
                      <span className="activity-task-kind">{task.type === 'video_generation' ? '🎬' : '🎨'}</span>
                      <span className="activity-item-title">{task.workflowId}</span>
                      <span className="activity-item-status">{taskStatus(task)}</span>
                    </div>
                    <p className="activity-item-message">{task.prompt}</p>
                    <div className="activity-progress-track">
                      <div className={`activity-progress-fill${isRunning ? '' : ' history'}`} style={{ width: `${percent}%` }} />
                    </div>
                    <div className="activity-item-meta">
                      <span>{stage?.name ?? taskStatus(task)} · {Math.round(percent)}%</span>
                      {isRunning && (
                        <button className="activity-danger-btn" onClick={() => onCancelTask(task.id)}>
                          取消任务
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
