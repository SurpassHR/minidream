import { useEffect, useState, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage, ChatStage, GenerationOutput } from '../api';

/* ==================== 工具函数 ==================== */

/** 渐进式揭示文字（打字机效果） */
function useTypewriter(text: string, enabled: boolean, speed = 18) {
  const [shown, setShown] = useState(enabled ? 0 : text.length);
  const raf = useRef(0);
  const last = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setShown(text.length);
      return;
    }
    setShown(0);
    last.current = performance.now();
    const tick = (now: number) => {
      const dt = now - last.current;
      if (dt >= speed) {
        last.current = now;
        setShown(prev => {
          const next = prev + Math.max(1, Math.floor(dt / speed));
          if (next >= text.length) return text.length;
          raf.current = requestAnimationFrame(tick);
          return next;
        });
      } else {
        raf.current = requestAnimationFrame(tick);
      }
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [text, enabled, speed]);

  return shown;
}

/* ==================== 子组件 ==================== */

function AgentAvatar({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
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

/* ==================== Markdown 渲染 ==================== */

function MarkdownContent({ content, animate }: { content: string; animate?: boolean }) {
  const shown = useTypewriter(content, !!animate);
  const displayText = animate ? content.slice(0, shown) : content;
  const isDone = !animate || shown >= content.length;

  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayText}</ReactMarkdown>
      {!isDone && <span className="cursor-blink" />}
    </div>
  );
}

/* ==================== 思维链（可折叠） ==================== */

function ThinkingChain({ logs, live }: { logs: string[]; live: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const count = logs.length;
  if (count === 0) return null;

  return (
    <div className={`thinking-chain${expanded ? ' expanded' : ''}`}>
      <button className="thinking-toggle" onClick={() => setExpanded(e => !e)}>
        <svg className="thinking-icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path
            d="M3 5.5 7 9.5l4-4"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="thinking-label">
          {live ? `深度思考中…（${count} 步）` : `深度思考（${count} 步）`}
        </span>
        {live && (
          <span className="thinking-dots">
            <i /><i /><i />
          </span>
        )}
      </button>
      {expanded && (
        <div className="thinking-logs">
          {logs.map((log, i) => (
            <div key={i} className="thinking-log-item">
              <span className="thinking-step">{i + 1}</span>
              <span className="thinking-text">{log}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ==================== 生成结果 ==================== */

function GenerationResults({ outputs }: { outputs: GenerationOutput[] }) {
  if (!outputs?.length) return null;
  const images = outputs.filter(o => o.kind === 'image');
  const videos = outputs.filter(o => o.kind === 'video');
  const texts = outputs.filter(o => o.kind === 'text');

  return (
    <div className="generation-results">
      {images.length > 0 && (
        <div className="result-grid">
          {images.map((img, i) => (
            <figure key={`${img.url ?? i}`} className="result-figure">
              <img className="result-img" src={img.url} alt={img.label ?? `生成图片 ${i + 1}`} loading="lazy" />
              {img.label && <figcaption>{img.label}</figcaption>}
            </figure>
          ))}
        </div>
      )}
      {videos.length > 0 && (
        <div className="result-videos">
          {videos.map((v, i) => (
            <div key={`${v.url ?? i}`} className="result-video-wrap">
              <video className="result-video" src={v.url} controls playsInline preload="metadata" />
              {v.label && <div className="result-video-label">{v.label}</div>}
            </div>
          ))}
        </div>
      )}
      {texts.length > 0 && (
        <div className="result-texts">
          {texts.map((t, i) => (
            <pre key={i} className="result-text">{t.text}</pre>
          ))}
        </div>
      )}
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

/* ==================== 带动画的思考日志 ==================== */

function AnimatedThinkingLogs({ logs }: { logs: string[] }) {
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (shown >= logs.length) return;
    const timer = setTimeout(() => setShown(s => s + 1), 400);
    return () => clearTimeout(timer);
  }, [shown, logs.length]);

  return (
    <>
      {logs.slice(0, shown).map((log, i) => (
        <div key={i} className="chat-log thinking-log">
          {log}
        </div>
      ))}
    </>
  );
}

/* ==================== 助手消息主体 ==================== */

function AssistantMessageBody({
  message,
  live,
  onRegenerate,
  onCancelJob,
  index,
}: {
  message: ChatMessage;
  live: boolean;
  onRegenerate?: (index: number) => void;
  onCancelJob?: (jobId: string) => void;
  index: number;
}) {
  const stages = message.stages;
  if (!stages?.length) {
    return <MarkdownContent content={message.content} />;
  }

  const thinkingLogs = stages.flatMap(s => (s.type === 'thinking' ? s.logs ?? [] : []));
  const taskStage = stages.find(s => s.type === 'task');
  const doneStage = stages.find(s => s.type === 'done');
  const errorStage = stages.find(s => s.type === 'error');
  const cancelled = taskStage?.cancelled ?? false;
  const running = live && !doneStage && !errorStage && !cancelled;

  return (
    <div className="assistant-stages">
      {/* 思维链 */}
      {thinkingLogs.length > 0 && (
        <ThinkingChain logs={thinkingLogs} live={running} />
      )}

      {/* 等待中的 loading */}
      {running && thinkingLogs.length === 0 && (
        <div className="chat-thinking">
          <span className="chat-thinking-dots"><i /><i /><i /></span>
          <span>任务响应中...</span>
        </div>
      )}

      {/* 任务进度卡片 */}
      {taskStage && running && (
        <TaskCard
          stage={taskStage}
          cancelled={cancelled}
          onCancel={message.jobId ? () => onCancelJob?.(message.jobId!) : undefined}
        />
      )}

      {/* 错误 */}
      {errorStage && <ErrorBox logs={errorStage.logs ?? ['生成失败']} />}

      {/* 完成态 */}
      {doneStage && (
        <div className="chat-done">
          {message.content && (
            <MarkdownContent content={message.content} animate={live} />
          )}
          <GenerationResults outputs={doneStage.outputs ?? []} />
          {doneStage.outputs?.length === 0 && !message.content && (
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
    </div>
  );
}

/* ==================== 主组件 ==================== */

export default function ChatView({
  messages,
  onRegenerate,
  onCancelJob,
}: {
  messages: ChatMessage[];
  onRegenerate?: (index: number) => void;
  onCancelJob?: (jobId: string) => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  return (
    <div className="chat">
      {messages.map((m, i) =>
        m.role === 'user' ? (
          <div key={i} className="chat-row user">
            <div className="chat-bubble user">
              <div className="bubble-content">{m.content}</div>
            </div>
          </div>
        ) : (
          <div key={i} className="chat-row assistant">
            <div className="chat-avatar">
              <AgentAvatar />
            </div>
            <div className="chat-bubble assistant">
              <AssistantMessageBody
                message={m}
                live={!!m.jobId}
                onRegenerate={onRegenerate}
                onCancelJob={onCancelJob}
                index={i}
              />
            </div>
          </div>
        ),
      )}
      <div ref={bottomRef} />
    </div>
  );
}
