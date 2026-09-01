import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import type { TaskItem } from '../api';

function taskStatusLabel(task: TaskItem): string {
  if (task.status === 'queued') return i18n.t('sessionTasks.queued');
  if (task.status === 'running') return i18n.t('sessionTasks.running');
  if (task.status === 'canceled') return i18n.t('sessionTasks.canceled');
  if (task.status === 'completed') return i18n.t('sessionTasks.completed');
  if (task.status === 'interrupted') return i18n.t('sessionTasks.interrupted');
  return i18n.t('sessionTasks.failed');
}

function taskProgressPercent(task: TaskItem): number {
  if (
    task.status === 'completed' ||
    task.status === 'failed' ||
    task.status === 'canceled' ||
    task.status === 'interrupted'
  ) {
    return 100;
  }
  const stage =
    task.stages.find(item => item.status === 'active') ??
    task.stages[task.stages.length - 1];
  return Math.max(
    0,
    Math.min(100, stage?.progress ?? (task.status === 'running' ? 5 : 0)),
  );
}

const RING_RADIUS = 8;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * 当前会话任务指示器：左侧导航栏语言切换上方的圆形小按钮。
 * 有进行中/排队任务时显示进度环，否则为状态点；点击在右侧展开任务详情。
 */
export default function SessionTaskIndicator({
  tasks,
  onCancelTask,
}: {
  tasks: TaskItem[];
  onCancelTask?: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (tasks.length === 0) setOpen(false);
  }, [tasks.length]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (tasks.length === 0) return null;

  const active = tasks.filter(task => task.status === 'queued' || task.status === 'running');
  const finished = tasks.filter(task => task.status !== 'queued' && task.status !== 'running');
  const shown = expanded ? tasks : active;
  const activeTask = active[0];

  return (
    <div className="session-task-rail" ref={rootRef}>
      <button
        className={`session-task-rail-trigger${active.length > 0 ? ' active' : ''}`}
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        aria-label={t('sessionTasks.ariaLabel')}
        title={t('sessionTasks.ariaLabel')}
      >
        <span className={`session-task-icon-wrap${active.length > 0 ? ' active' : ''}`}>
          {/* 任务清单图标：进行中时由进度环圈住 */}
          <svg className="session-task-icon" viewBox="0 0 20 20" width="18" height="18" fill="none">
            <path d="M6.2 4.4h9.3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <path d="M6.2 9.9h9.3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <path d="M6.2 15.4h6.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <path d="m2.9 4.4 1.1 1 2-2.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            <path d="m2.9 9.9 1.1 1 2-2.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {activeTask && (
            <svg className="session-task-ring" viewBox="0 0 20 20" width="22" height="22">
              <circle className="session-task-ring-bg" cx="10" cy="10" r={RING_RADIUS} />
              <circle
                className="session-task-ring-fg"
                cx="10"
                cy="10"
                r={RING_RADIUS}
                strokeDasharray={`${(taskProgressPercent(activeTask) / 100) * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
                transform="rotate(-90 10 10)"
              />
            </svg>
          )}
        </span>
      </button>

      {open && (
        <div
          className="session-task-popover"
          role="dialog"
          aria-label={t('sessionTasks.ariaLabel')}
        >
          <div className="session-task-popover-head">
            <span className="session-task-popover-title">
              {active.length > 0
                ? t('sessionTasks.title', { count: active.length })
                : t('sessionTasks.finishedOnly', { count: finished.length })}
            </span>
            {finished.length > 0 && (
              <button
                className="session-task-toggle"
                onClick={() => setExpanded(value => !value)}
              >
                {expanded
                  ? t('sessionTasks.hideFinished')
                  : t('sessionTasks.showFinished', { count: finished.length })}
              </button>
            )}
          </div>
          {shown.length === 0 ? (
            <p className="session-task-empty">{t('sessionTasks.noneActive')}</p>
          ) : (
            <ul className="session-task-list">
              {shown.map(task => {
                const isActive = task.status === 'queued' || task.status === 'running';
                const percent = taskProgressPercent(task);
                return (
                  <li key={task.id} className={`session-task-item${isActive ? '' : ' finished'}`}>
                    <div className="session-task-item-head">
                      <span className="session-task-kind">
                        {task.type === 'video_generation' ? '🎬' : '🎨'}
                      </span>
                      <span className="session-task-workflow">{task.workflowId}</span>
                      <span className="session-task-status">{taskStatusLabel(task)}</span>
                      {isActive && onCancelTask && (
                        <button
                          className="session-task-cancel"
                          onClick={() => onCancelTask(task.id)}
                        >
                          {t('chat.cancelTask')}
                        </button>
                      )}
                    </div>
                    <div className="session-task-progress-track">
                      <div
                        className={`session-task-progress-fill${isActive ? '' : ' finished'}`}
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}