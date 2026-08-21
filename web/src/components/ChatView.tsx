import { useEffect, useState } from 'react';
import type { ChatMessage, ChatStage, GenerationOutput } from '../api';

interface RevealState {
  /** 当前展示到的 thinking 日志条数 */
  logsShown: number;
  /** 是否展示任务卡片 */
  taskShown: boolean;
  /** 是否展示完成态 */
  doneShown: boolean;
  /** 是否已取消 */
  cancelled: boolean;
}

function initialReveal(stages?: ChatStage[]): RevealState {
  if (!stages?.length) return { logsShown: 0, taskShown: false, doneShown: false, cancelled: false };
  const first = stages[0];
  return {
    logsShown: first?.type === 'thinking' ? 0 : (first?.logs?.length ?? 0),
    taskShown: first?.type === 'task' || first?.type === 'done',
    doneShown: first?.type === 'done',
    cancelled: false,
  };
}

function AgentAvatar() {
  return (
    <svg width="28" height="28" viewBox="0 0 40 40" fill="none">
      <rect width="40" height="40" rx="12" fill="#00cae0" />
      <rect x="8" y="10" width="24" height="17" rx="3.5" fill="white" />
      <path d="M8 15.5h24M13 10v5.5M27 10v5.5" stroke="#00a1c2" strokeWidth="1.6" />
      <path d="m24.5 21.5 3 3-3 3" stroke="#00a1c2" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="17.5" cy="24.5" r="3" fill="#00a1c2" />
    </svg>
  );
}

function TaskCard({
  stage,
  cancelled,
  onCancel,
}: {
  stage: ChatStage;
  cancelled: boolean;
  onCancel?: () => void;
}) {
  const p = stage.progress ?? { completed: 0, total: 1 };
  const percent = cancelled ? 100 : Math.min(100, (p.completed / Math.max(1, p.total)) * 100);
  return (
    <div className="task-card">
      <div className="task-card-head">
        <span className="task-card-type">{stage.taskLabel ?? '生成中…'}</span>
        <span className="task-card-count">
          ({p.completed}/{p.total})
        </span>
      </div>
      <div className="task-card-progress">
        <div className={`task-card-bar${cancelled ? ' cancelled' : ''}`} style={{ width: `${percent}%` }} />
      </div>
      {stage.queued && !cancelled && (
        <div className="task-card-queued">
          <span>排队中...</span>
          <em>{stage.queueLabel ?? '1 个任务排队中'}</em>
          {onCancel && (
            <button className="task-cancel" onClick={onCancel}>
              取消生成
            </button>
          )}
        </div>
      )}
      {cancelled && <div className="task-card-cancelled">已取消生成</div>}
    </div>
  );
}

/* ---------------- 生成结果渲染 ---------------- */

function ResultImages({ outputs }: { outputs: GenerationOutput[] }) {
  const images = outputs.filter(o => o.kind === 'image');
  if (!images.length) return null;
  return (
    <div className="result-grid">
      {images.map((img, i) => (
        <figure key={`${img.url ?? i}`} className="result-figure">
          <img className="result-img" src={img.url} alt={img.label ?? `生成图片 ${i + 1}`} loading="lazy" />
          <figcaption>{img.label}</figcaption>
        </figure>
      ))}
    </div>
  );
}

function ResultVideos({ outputs }: { outputs: GenerationOutput[] }) {
  const videos = outputs.filter(o => o.kind === 'video');
  if (!videos.length) return null;
  return (
    <div className="result-videos">
      {videos.map((v, i) => (
        <div key={`${v.url ?? i}`} className="result-video-wrap">
          <video className="result-video" src={v.url} controls playsInline preload="metadata" />
          <div className="result-video-label">{v.label ?? `生成视频 ${i + 1}`}</div>
        </div>
      ))}
    </div>
  );
}

function ResultTexts({ outputs }: { outputs: GenerationOutput[] }) {
  const texts = outputs.filter(o => o.kind === 'text');
  if (!texts.length) return null;
  return (
    <div className="result-texts">
      {texts.map((t, i) => (
        <pre key={i} className="result-text">
          {t.text}
        </pre>
      ))}
    </div>
  );
}

function GenerationResults({ outputs }: { outputs: GenerationOutput[] }) {
  if (!outputs?.length) return null;
  return (
    <div className="generation-results">
      <ResultImages outputs={outputs} />
      <ResultVideos outputs={outputs} />
      <ResultTexts outputs={outputs} />
    </div>
  );
}

function ErrorBox({ logs }: { logs: string[] }) {
  return (
    <div className="chat-error">
      {logs.map((log, i) => (
        <div key={i}>{log}</div>
      ))}
    </div>
  );
}

export default function ChatView({
  messages,
  onRegenerate,
  onCancelJob,
}: {
  messages: ChatMessage[];
  onRegenerate?: (index: number) => void;
  onCancelJob?: (jobId: string) => void;
}) {
  return (
    <div className="chat">
      {messages.map((m, i) =>
        m.role === 'user' ? (
          <div key={i} className="chat-row user">
            <div className="chat-bubble user">{m.content}</div>
          </div>
        ) : (
          <AssistantMessage key={i} index={i} message={m} onRegenerate={onRegenerate} onCancelJob={onCancelJob} />
        ),
      )}
    </div>
  );
}

function AssistantMessage({
  index,
  message,
  onRegenerate,
  onCancelJob,
}: {
  index: number;
  message: ChatMessage;
  onRegenerate?: (index: number) => void;
  onCancelJob?: (jobId: string) => void;
}) {
  const stages = message.stages;
  // 实时模式：SSE 驱动，阶段数据随事件到达，不做定时揭示
  const live = !!message.jobId;
  const [reveal, setReveal] = useState<RevealState>(() => initialReveal(stages));

  // 模拟（非实时）消息：分阶段自动推进
  useEffect(() => {
    if (live || !stages?.length || reveal.cancelled) return;

    const allShown =
      (stages.every(s => s.type === 'thinking') && reveal.logsShown >= stages.reduce((n, s) => n + (s.logs?.length ?? 0), 0)) ||
      (reveal.taskShown && reveal.doneShown) ||
      (reveal.taskShown && !stages.some(s => s.type === 'done'));

    if (allShown) return;

    const delay = reveal.logsShown === 0 && !reveal.taskShown ? 600 : 900;
    const timer = setTimeout(() => {
      setReveal(prev => {
        const next = { ...prev };
        const thinkingLogs = stages.flatMap(s => (s.type === 'thinking' ? s.logs ?? [] : []));
        if (next.logsShown < thinkingLogs.length) {
          next.logsShown += 1;
        } else if (!next.taskShown && stages.some(s => s.type === 'task')) {
          next.taskShown = true;
        } else if (!next.doneShown && stages.some(s => s.type === 'done')) {
          next.doneShown = true;
        }
        return next;
      });
    }, delay);
    return () => clearTimeout(timer);
  }, [stages, reveal, live]);

  /* ---------- 无阶段（纯文本） ---------- */
  if (!stages?.length) {
    return (
      <div className="chat-row assistant">
        <div className="chat-avatar">
          <AgentAvatar />
        </div>
        <div className="chat-bubble assistant">{message.content}</div>
      </div>
    );
  }

  const thinkingLogs = stages.flatMap(s => (s.type === 'thinking' ? s.logs ?? [] : []));
  const taskStage = stages.find(s => s.type === 'task');
  const doneStage = stages.find(s => s.type === 'done');
  const errorStage = stages.find(s => s.type === 'error');
  const cancelled = taskStage?.cancelled ?? false;

  if (live) {
    const running = !doneStage && !errorStage && !cancelled;
    return (
      <div className="chat-row assistant">
        <div className="chat-avatar">
          <AgentAvatar />
        </div>
        <div className="chat-content">
          {thinkingLogs.length === 0 && running && (
            <div className="chat-thinking">
              <span className="chat-thinking-dots">
                <i />
                <i />
                <i />
              </span>
              <span>任务响应中...</span>
            </div>
          )}
          {thinkingLogs.map((log, li) => (
            <div key={li} className="chat-log">
              {log}
            </div>
          ))}

          {taskStage && running && (
            <TaskCard
              stage={taskStage}
              cancelled={cancelled}
              onCancel={message.jobId ? () => onCancelJob?.(message.jobId!) : undefined}
            />
          )}

          {errorStage && <ErrorBox logs={errorStage.logs ?? [errorStage.logs?.[0] ?? '生成失败']} />}

          {doneStage && (
            <div className="chat-done">
              {doneStage.logs?.map((log, li) => (
                <div key={li} className="chat-log done">
                  {log}
                </div>
              ))}
              <GenerationResults outputs={doneStage.outputs ?? []} />
              {doneStage.outputs?.length === 0 && (
                <div className="chat-log done">生成完成。</div>
              )}
              <div className="chat-done-meta">
                {doneStage.credits !== undefined && (
                  <span className="chat-credits">本次消耗 {doneStage.credits} 积分</span>
                )}
                <span className="chat-ai-note">以上内容由 AI 生成</span>
              </div>
              <div className="chat-done-actions">
                {doneStage.suggestion && (
                  <button className="chat-suggestion" onClick={() => onRegenerate?.(index)}>
                    {doneStage.suggestion}
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M2.5 6h7m0 0L6.5 3M9.5 6 6.5 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                )}
                <button className="chat-regenerate" onClick={() => onRegenerate?.(index)}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M12 7a5 5 0 1 1-1.46-3.54M12 2.5V6H8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  重新生成
                </button>
              </div>
            </div>
          )}

          {running && taskStage && (
            <div className="chat-meta-row">
              <span>时间</span>
              <span>生成模式</span>
              <span>操作类型</span>
              <span>资产库</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ---------- 模拟（mock）消息：定时揭示 ---------- */
  const isStillRunning = !reveal.cancelled && !(reveal.taskShown && reveal.doneShown && !taskStage);

  return (
    <div className="chat-row assistant">
      <div className="chat-avatar">
        <AgentAvatar />
      </div>
      <div className="chat-content">
        {reveal.logsShown === 0 && !reveal.taskShown && !reveal.cancelled && (
          <div className="chat-thinking">
            <span className="chat-thinking-dots">
              <i />
              <i />
              <i />
            </span>
            <span>任务响应中...</span>
          </div>
        )}

        {thinkingLogs.slice(0, reveal.logsShown).map((log, li) => (
          <div key={li} className="chat-log">
            {log}
          </div>
        ))}

        {reveal.taskShown && taskStage && (
          <TaskCard stage={taskStage} cancelled={reveal.cancelled} />
        )}

        {reveal.doneShown && doneStage && !reveal.cancelled && (
          <div className="chat-done">
            {doneStage.logs?.map((log, li) => (
              <div key={li} className="chat-log done">
                {log}
              </div>
            ))}
            <div className="chat-done-meta">
              {doneStage.credits !== undefined && (
                <span className="chat-credits">本次消耗 {doneStage.credits} 积分</span>
              )}
              <span className="chat-ai-note">以上内容由 AI 生成</span>
            </div>
            <div className="chat-done-actions">
              {doneStage.suggestion && (
                <button className="chat-suggestion" onClick={() => onRegenerate?.(index)}>
                  {doneStage.suggestion}
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M2.5 6h7m0 0L6.5 3M9.5 6 6.5 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
              <button className="chat-regenerate" onClick={() => onRegenerate?.(index)}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M12 7a5 5 0 1 1-1.46-3.54M12 2.5V6H8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                重新生成
              </button>
            </div>
          </div>
        )}

        {isStillRunning && !reveal.doneShown && (
          <div className="chat-meta-row">
            <span>时间</span>
            <span>生成模式</span>
            <span>操作类型</span>
            <span>资产库</span>
          </div>
        )}
      </div>
    </div>
  );
}
