import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import type { ActiveSession, ActivitySnapshot, TaskItem } from '../api';

function formatDuration(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return i18n.t('activity.secShort', { s: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return i18n.t('activity.minShort', { m: minutes });
  return i18n.t('activity.hourMinShort', { h: Math.floor(minutes / 60), m: minutes % 60 });
}

function sessionStatus(status: ActiveSession['status']): string {
  if (status === 'running') return i18n.t('activity.sessionRunning');
  if (status === 'canceled') return i18n.t('activity.sessionCanceled');
  if (status === 'completed') return i18n.t('activity.sessionCompleted');
  return i18n.t('activity.sessionFailed');
}

function taskStatus(task: TaskItem): string {
  if (task.status === 'queued') return i18n.t('activity.taskQueued');
  if (task.status === 'running') return i18n.t('activity.taskRunning');
  if (task.status === 'canceled') return i18n.t('activity.taskCanceled');
  if (task.status === 'completed') return i18n.t('activity.taskCompleted');
  if (task.status === 'interrupted') return i18n.t('activity.taskInterrupted');
  return i18n.t('activity.taskFailed');
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
  const { t } = useTranslation();
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
    <div className="activity-panel" role="dialog" aria-modal="true" aria-label={t('statusbar.ariaLabel')}>
      <div className="activity-panel-head">
        <div>
          <div className="activity-panel-kicker">{t('activity.kicker')}</div>
          <h2>{t('activity.title')}</h2>
        </div>
        <button className="activity-close" onClick={onClose} aria-label={t('activity.closeAria')}>×</button>
      </div>

      {visibleSessions.length === 0 && visibleTasks.length === 0 ? (
        <div className="activity-empty">
          <span className="activity-empty-icon">✓</span>
          <p>{t('activity.empty')}</p>
        </div>
      ) : (
        <div className="activity-list">
          {visibleSessions.length > 0 && (
            <section className="activity-section">
              <div className="activity-section-title">{t('activity.sessions')} <em>{visibleSessions.length}</em></div>
              {visibleSessions.map(session => {
                const isRunning = session.status === 'running';
                return (
                  <div key={session.sessionId} className={`activity-item activity-session${isRunning ? '' : ' activity-history-item'}`}>
                    <div className="activity-item-head">
                      <span className={`activity-pulse${isRunning ? '' : ' history'}`} />
                      <span className="activity-item-title">{t('activity.sessionItemTitle')}</span>
                      <span className="activity-item-status">{sessionStatus(session.status)}</span>
                    </div>
                    <p className="activity-item-message">{session.message}</p>
                    <div className="activity-item-meta">
                      <span>{formatDuration(session.startedAt, now)}</span>
                      <span>{t('activity.relatedTasks', { count: session.taskIds.length })}</span>
                      {isRunning && (
                        <button className="activity-danger-btn" onClick={() => onCancelSession(session.sessionId)}>
                          {t('activity.terminateSession')}
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
              <div className="activity-section-title">{t('activity.tasks')} <em>{visibleTasks.length}</em></div>
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
                          {t('chat.cancelTask')}
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
